#!/usr/bin/env python3
"""
wallet-watch — Phase 1.4 (2026-05-21) observer script.

Pulls per-wallet state from Polymarket's public data-api for every wallet in
src/geopolitics/watchlist.ts (Tier-1 + Tier-2). Writes a snapshot JSON file
into logs/wallet-snapshots/. With `compare`, diffs two snapshots to produce
a wallet-by-wallet performance table for the rotation decision at Day 7.

Does NOT touch the bot. Read-only against the public API. Safe to run any
time, ideally via cron once per day.

Usage:
    ./scripts/wallet-watch.py snapshot                  # take a snapshot now
    ./scripts/wallet-watch.py compare <day0.json> <dayN.json>
    ./scripts/wallet-watch.py latest                    # print the latest two diffed

Snapshots are JSON files: { taken_at, wallets: { name: { realized_pnl, cash_pnl,
positions_n, recent_trades_n, sample_titles } } }
"""

import argparse
import json
import re
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WATCHLIST_PATH = ROOT / "src" / "geopolitics" / "watchlist.ts"
SNAPSHOT_DIR = ROOT / "logs" / "wallet-snapshots"
DATA_API = "https://data-api.polymarket.com"


def parse_watchlist():
    """Extract { wallet_address: { name, tier } } from watchlist.ts source."""
    text = WATCHLIST_PATH.read_text()
    wallets = {}
    # Match blocks like: walletAddress: '0x...', name: 'X', tier: N,
    block_re = re.compile(
        r"walletAddress:\s*'(0x[0-9a-fA-F]+)',\s*"
        r"name:\s*'([^']+)',\s*"
        r"tier:\s*([12])",
        re.DOTALL,
    )
    for m in block_re.finditer(text):
        addr = m.group(1).lower()
        name = m.group(2)
        tier = int(m.group(3))
        wallets[addr] = {"name": name, "tier": tier}
    return wallets


def fetch_json(url, timeout=15):
    """Use curl (avoids Python SSL/cert friction on macOS)."""
    try:
        r = subprocess.run(
            ["curl", "-s", "--max-time", str(timeout), url],
            capture_output=True, text=True, check=False,
        )
        return json.loads(r.stdout) if r.stdout else None
    except Exception as e:
        return {"_error": str(e)}


def snapshot_wallet(addr):
    """Pull /positions and /trades?limit=200 for one wallet."""
    positions = fetch_json(f"{DATA_API}/positions?user={addr}&limit=200")
    trades = fetch_json(f"{DATA_API}/trades?user={addr}&limit=200")

    if not isinstance(positions, list):
        positions = []
    if not isinstance(trades, list):
        trades = []

    realized_pnl = sum((p.get("realizedPnl") or 0) for p in positions)
    cash_pnl = sum((p.get("cashPnl") or 0) for p in positions)
    initial_value = sum((p.get("initialValue") or 0) for p in positions)
    current_value = sum((p.get("currentValue") or 0) for p in positions)

    # Latest 5 trade titles for quick visual sanity
    sample_titles = []
    for t in trades[:5]:
        ts = t.get("timestamp") or 0
        sample_titles.append({
            "ts": datetime.fromtimestamp(ts, tz=timezone.utc).isoformat() if ts else "",
            "side": t.get("side", ""),
            "size": t.get("size", 0),
            "title": (t.get("title") or "")[:60],
        })

    return {
        "positions_n": len(positions),
        "recent_trades_n": len(trades),
        "realized_pnl": round(realized_pnl, 2),
        "cash_pnl": round(cash_pnl, 2),
        "initial_value": round(initial_value, 2),
        "current_value": round(current_value, 2),
        "sample_titles": sample_titles,
    }


def cmd_snapshot():
    wallets = parse_watchlist()
    print(f"Found {len(wallets)} wallets in watchlist", file=sys.stderr)
    out = {
        "taken_at": datetime.now(timezone.utc).isoformat(),
        "wallets": {},
    }
    for addr, meta in wallets.items():
        print(f"  Fetching {meta['name']} (Tier-{meta['tier']}) {addr[:10]}...", file=sys.stderr)
        snap = snapshot_wallet(addr)
        out["wallets"][meta["name"]] = {
            "address": addr,
            "tier": meta["tier"],
            **snap,
        }
        time.sleep(0.15)  # be polite to the API

    SNAPSHOT_DIR.mkdir(parents=True, exist_ok=True)
    fname = SNAPSHOT_DIR / f"snapshot-{datetime.now(timezone.utc).strftime('%Y-%m-%d-%H%M')}.json"
    fname.write_text(json.dumps(out, indent=2))
    print(f"Wrote {fname}", file=sys.stderr)
    print(str(fname))


def cmd_compare(path_a, path_b):
    a = json.loads(Path(path_a).read_text())
    b = json.loads(Path(path_b).read_text())
    span_hours = (
        datetime.fromisoformat(b["taken_at"]) - datetime.fromisoformat(a["taken_at"])
    ).total_seconds() / 3600

    print(f"Comparing {Path(path_a).name} → {Path(path_b).name}")
    print(f"Window: {span_hours:.1f}h ({span_hours/24:.1f} days)")
    print()
    print(f"{'Wallet':22s} {'Tier':>4} {'Δ Realized':>12} {'Δ Cash':>10} {'Δ Total':>10} {'Δ Positions':>12} {'Trades(now)':>11}")
    print("-" * 100)

    all_names = sorted(set(a["wallets"]) | set(b["wallets"]))
    rows = []
    for name in all_names:
        wa = a["wallets"].get(name, {})
        wb = b["wallets"].get(name, {})
        d_real = (wb.get("realized_pnl", 0)) - (wa.get("realized_pnl", 0))
        d_cash = (wb.get("cash_pnl", 0)) - (wa.get("cash_pnl", 0))
        d_pos = (wb.get("positions_n", 0)) - (wa.get("positions_n", 0))
        tier = wb.get("tier", wa.get("tier", "?"))
        trades_now = wb.get("recent_trades_n", 0)
        d_total = d_real + d_cash
        rows.append((name, tier, d_real, d_cash, d_total, d_pos, trades_now))

    # Sort by Δ Total descending
    for name, tier, dr, dc, dt, dp, tn in sorted(rows, key=lambda r: -r[4]):
        print(f"{name:22s} {tier:>4} {dr:>+12.2f} {dc:>+10.2f} {dt:>+10.2f} {dp:>+12d} {tn:>11d}")


def cmd_latest():
    files = sorted(SNAPSHOT_DIR.glob("snapshot-*.json"))
    if len(files) < 2:
        print(f"Need ≥2 snapshots in {SNAPSHOT_DIR} (found {len(files)})", file=sys.stderr)
        sys.exit(1)
    cmd_compare(files[0], files[-1])


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd")
    sub.add_parser("snapshot")
    cmp_ap = sub.add_parser("compare")
    cmp_ap.add_argument("file_a")
    cmp_ap.add_argument("file_b")
    sub.add_parser("latest")
    args = ap.parse_args()

    if args.cmd == "snapshot":
        cmd_snapshot()
    elif args.cmd == "compare":
        cmd_compare(args.file_a, args.file_b)
    elif args.cmd == "latest":
        cmd_latest()
    else:
        ap.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
