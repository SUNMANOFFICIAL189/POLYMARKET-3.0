#!/usr/bin/env python3
"""
wallet-watch — Phase 1.4 (2026-05-21), enhanced Phase 1.6 (2026-05-24).

Pulls per-wallet state from Polymarket's public data-api for every wallet in
src/geopolitics/watchlist.ts (Tier-1 + Tier-2). Writes a snapshot JSON file
into logs/wallet-snapshots/. With `compare`, diffs two snapshots to produce
a wallet-by-wallet performance table with archetype + activity signal.

Does NOT touch the bot. Read-only against the public API. Safe to run any
time, ideally via cron once per day.

Phase 1.6 additions (per LESSONS.md #25 — CTDD discipline):
  - Per-side activity (BUYs and SELLs separately, plus 24h burst counts)
  - Archetype hints (longshot %, near-cert %, event concentration)
  - Realized win/loss DISTRIBUTION (not just sum — catches "few catastrophic
    losses hidden behind net headline" pattern that fooled the JustCrazy
    analysis)
  - Sample-size adequacy + Z-score on per-position % returns
  - Compare-mode now flags archetype changes and per-side activity shifts

Usage:
    ./scripts/wallet-watch.py snapshot                  # take a snapshot now
    ./scripts/wallet-watch.py compare <day0.json> <dayN.json>
    ./scripts/wallet-watch.py latest                    # diff oldest vs newest
"""

import argparse
import json
import re
import statistics
import subprocess
import sys
import time
from collections import Counter
from datetime import datetime, timezone, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WATCHLIST_PATH = ROOT / "src" / "geopolitics" / "watchlist.ts"
SNAPSHOT_DIR = ROOT / "logs" / "wallet-snapshots"
DATA_API = "https://data-api.polymarket.com"

# Archetype thresholds (calibrated against balthazar/MRF/JustCrazy as known
# portfolio-longtail, and Car as known info-edge candidate).
LONGSHOT_PRICE = 0.05
NEAR_CERT_PRICE = 0.90
PORTFOLIO_LONGSHOT_THRESHOLD = 0.40   # ≥40% of BUYs at <$0.05 → portfolio-longtail signal
INFO_EDGE_MAX_EVENTS = 30             # ≤30 distinct events = focused
MIN_SAMPLE_FOR_ZSCORE = 30            # need ≥30 positions to bother with significance test


def parse_watchlist():
    """Extract { wallet_address: { name, tier } } from watchlist.ts source."""
    text = WATCHLIST_PATH.read_text()
    wallets = {}
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


def classify_archetype(metrics):
    """
    Heuristic archetype hint — see LESSONS.md #25, prevent the JustCrazy trap.

    Recalibrated 2026-05-24: simplified to longshot-ratio-driven only. The
    previous `n_events <= 30` ceiling was a false-negative trap — Car (our
    reference info-edge wallet) has 95 events and was being misclassified as
    MIXED, which would have blocked him from passing the gate. The actual
    discriminator between INFO_EDGE and PORTFOLIO_LONGTAIL is the longshot
    ratio (% of BUYs at price ≤$0.05), not the event count. Event count
    inflates with high-frequency markets (BTC up/down 5m, daily sports) and
    doesn't indicate strategy type.
    """
    longshot_pct = metrics["longshot_ratio"]
    n_buys = metrics["total_buys"]

    if n_buys < 10:
        return "INSUFFICIENT_DATA"
    if longshot_pct >= PORTFOLIO_LONGSHOT_THRESHOLD:
        # 40%+ longshot bets = clearly portfolio-longtail strategy
        return "PORTFOLIO_LONGTAIL"
    if longshot_pct < 0.20:
        # <20% longshot = doesn't look like portfolio-longtail; treat as INFO_EDGE
        # and let the Z-score + tail-risk gates do the discrimination.
        return "INFO_EDGE"
    # 20-40% longshot = ambiguous, classify as MIXED (won't pass candidate gate
    # but visible in snapshot for human review)
    return "MIXED"


def snapshot_wallet(addr):
    """Pull /positions and /trades for one wallet, compute enriched metrics."""
    positions = fetch_json(f"{DATA_API}/positions?user={addr}&limit=300")
    trades = fetch_json(f"{DATA_API}/trades?user={addr}&limit=500")

    if not isinstance(positions, list):
        positions = []
    if not isinstance(trades, list):
        trades = []

    now = datetime.now(timezone.utc)
    cutoff_24h = (now - timedelta(hours=24)).timestamp()

    # ── P&L aggregates ─────────────────────────────────────────────
    realized_pnl = sum((p.get("realizedPnl") or 0) for p in positions)
    cash_pnl = sum((p.get("cashPnl") or 0) for p in positions)
    initial_value = sum((p.get("initialValue") or 0) for p in positions)
    current_value = sum((p.get("currentValue") or 0) for p in positions)

    # Distribution: catches "few catastrophic losses hidden by net" pattern
    pos_real_pnls = [(p.get("realizedPnl") or 0) for p in positions]
    n_realized_wins = sum(1 for r in pos_real_pnls if r > 10)
    n_realized_losses = sum(1 for r in pos_real_pnls if r < -10)
    sum_realized_wins = sum(r for r in pos_real_pnls if r > 0)
    sum_realized_losses = sum(r for r in pos_real_pnls if r < 0)
    worst_realized = min(pos_real_pnls) if pos_real_pnls else 0
    best_realized = max(pos_real_pnls) if pos_real_pnls else 0

    # CTDD CRITICAL: Z-score on DOLLAR-SCALED outcomes at OUR $50 trading size,
    # NOT on % returns. % return Z-score is biased toward portfolio-longtail
    # wallets (rare longshots produce huge % gains that mask catastrophic
    # dollar losses on the modal trade). Dollar-scaled Z-score is the metric
    # LESSONS.md #25 actually requires for rotation decisions.
    #
    # MIN_POSITION_SIZE_FOR_SCALED filter added 2026-06-08 (schema 1.7) to
    # exclude positions where the leader's tiny position size creates a
    # scaling-artifact tail. Concrete trigger: 2026-06-08 health check
    # surfaced StarMaster's -$1,499 "worst trade" — turned out to be a $3
    # bet on a 2026 Peruvian presidential candidate that lost $97; scaled to
    # $50 = $97 × (50/3) = $1,617. Pure math artifact, not real exposure.
    # Threshold $50 matches our typical geopolitics trade size; her positions
    # below that scale don't reflect anything we'd actually trade.
    OUR_SIZE = 50.0
    MIN_POSITION_SIZE_FOR_SCALED = 50.0
    scaled_dollar_pnls = []
    scaled_excluded_tiny = 0  # diagnostic: how many positions filtered
    for p in positions:
        iv = p.get("initialValue") or 0
        if iv <= 0:
            continue
        if iv < MIN_POSITION_SIZE_FOR_SCALED:
            scaled_excluded_tiny += 1
            continue
        avg = p.get("avgPrice") or 0
        if avg <= 0 or avg > NEAR_CERT_PRICE:
            continue
        # Their total $ P&L scaled to OUR $50 entry size
        # Per-share approach: their_pct_return * $50 = our_dollar_pnl
        their_total = (p.get("cashPnl") or 0) + (p.get("realizedPnl") or 0)
        their_pct = their_total / iv
        our_pnl_at_50 = their_pct * OUR_SIZE
        scaled_dollar_pnls.append(our_pnl_at_50)

    pct_mean = statistics.mean(scaled_dollar_pnls) if scaled_dollar_pnls else 0
    pct_median = statistics.median(scaled_dollar_pnls) if scaled_dollar_pnls else 0
    pct_stdev = statistics.stdev(scaled_dollar_pnls) if len(scaled_dollar_pnls) >= 2 else 0
    # Z-score on mean DOLLAR pnl at our scaled size, vs zero
    zscore = (pct_mean / (pct_stdev / (len(scaled_dollar_pnls) ** 0.5))) if pct_stdev > 0 else 0
    zscore_significant = abs(zscore) > 1.96
    zscore_direction = "POSITIVE" if zscore > 1.96 else ("NEGATIVE" if zscore < -1.96 else "INCONCLUSIVE")

    # Net dollar outcome if we'd taken every eligible BUY at $50 (counterfactual)
    sum_scaled_pnl = sum(scaled_dollar_pnls)
    n_scaled_wins = sum(1 for p in scaled_dollar_pnls if p > 1)
    n_scaled_losses = sum(1 for p in scaled_dollar_pnls if p < -1)
    worst_scaled_trade = min(scaled_dollar_pnls) if scaled_dollar_pnls else 0
    best_scaled_trade = max(scaled_dollar_pnls) if scaled_dollar_pnls else 0

    # ── Trade-level activity ───────────────────────────────────────
    buys = [t for t in trades if (t.get("side") or "").upper() == "BUY"]
    sells = [t for t in trades if (t.get("side") or "").upper() == "SELL"]

    recent = [t for t in trades if (t.get("timestamp") or 0) >= cutoff_24h]
    recent_buys = sum(1 for t in recent if (t.get("side") or "").upper() == "BUY")
    recent_sells = sum(1 for t in recent if (t.get("side") or "").upper() == "SELL")
    recent_buy_usd = sum((t.get("size", 0) * t.get("price", 0)) for t in recent if (t.get("side") or "").upper() == "BUY")
    recent_sell_usd = sum((t.get("size", 0) * t.get("price", 0)) for t in recent if (t.get("side") or "").upper() == "SELL")

    # ── Archetype indicators ───────────────────────────────────────
    # CTDD: derive from BOTH /trades (recent activity) AND /positions (current
    # book). Trades alone misses wallets that USED to do longshot heavily —
    # current positions reveal their structural strategy.
    trade_longshot_buys = sum(1 for t in buys if 0 < (t.get("price") or 0) <= LONGSHOT_PRICE)
    trade_near_cert_buys = sum(1 for t in buys if (t.get("price") or 0) >= NEAR_CERT_PRICE)
    trade_longshot_ratio = trade_longshot_buys / len(buys) if buys else 0
    trade_near_cert_ratio = trade_near_cert_buys / len(buys) if buys else 0

    # Position-based longshot ratio — what's the wallet's CURRENT book structure?
    pos_longshots = sum(1 for p in positions if 0 < (p.get("avgPrice") or 0) <= LONGSHOT_PRICE)
    pos_longshot_ratio = pos_longshots / len(positions) if positions else 0

    # Take the MAX of trade-based and position-based as our archetype signal —
    # if a wallet is longshot-heavy in EITHER lens, treat them as portfolio-longtail
    longshot_ratio = max(trade_longshot_ratio, pos_longshot_ratio)
    near_cert_ratio = trade_near_cert_ratio

    event_counts = Counter(t.get("eventSlug") or "" for t in buys if t.get("eventSlug"))
    top_event_concentration = (max(event_counts.values()) / len(buys)) if buys and event_counts else 0
    unique_events_n = len(event_counts)

    metrics = {
        "longshot_ratio": longshot_ratio,
        "near_cert_ratio": near_cert_ratio,
        "top_event_concentration": top_event_concentration,
        "unique_events_n": unique_events_n,
        "total_buys": len(buys),
    }
    archetype_hint = classify_archetype(metrics)

    # ── Latest 5 trade titles ──────────────────────────────────────
    sample_titles = []
    for t in trades[:5]:
        ts = t.get("timestamp") or 0
        sample_titles.append({
            "ts": datetime.fromtimestamp(ts, tz=timezone.utc).isoformat() if ts else "",
            "side": t.get("side", ""),
            "size": t.get("size", 0),
            "price": t.get("price", 0),
            "title": (t.get("title") or "")[:60],
        })

    return {
        # Position-level
        "positions_n": len(positions),
        "realized_pnl": round(realized_pnl, 2),
        "cash_pnl": round(cash_pnl, 2),
        "initial_value": round(initial_value, 2),
        "current_value": round(current_value, 2),
        # Distribution (catches the JustCrazy trap)
        "n_realized_wins": n_realized_wins,
        "n_realized_losses": n_realized_losses,
        "sum_realized_wins": round(sum_realized_wins, 2),
        "sum_realized_losses": round(sum_realized_losses, 2),
        "worst_realized_position": round(worst_realized, 2),
        "best_realized_position": round(best_realized, 2),
        # Per-position SCALED-TO-$50 dollar P&L stats (CTDD gate per LESSONS.md #25)
        "scaled_pnl_median": round(pct_median, 2),
        "scaled_pnl_mean": round(pct_mean, 2),
        "scaled_pnl_stdev": round(pct_stdev, 2),
        "scaled_pnl_zscore": round(zscore, 2),
        "scaled_pnl_sample_n": len(scaled_dollar_pnls),
        "scaled_pnl_sum": round(sum_scaled_pnl, 2),
        # Schema 1.7 (2026-06-08): added — count of positions excluded from
        # scaled_dollar_pnls because initialValue < MIN_POSITION_SIZE_FOR_SCALED ($50).
        # These are scaling-artifact territory; their inclusion would make
        # worst/Z stats unreliable. Reported here for transparency.
        "scaled_excluded_tiny_n": scaled_excluded_tiny,
        "scaled_n_wins": n_scaled_wins,
        "scaled_n_losses": n_scaled_losses,
        "worst_scaled_trade": round(worst_scaled_trade, 2),
        "best_scaled_trade": round(best_scaled_trade, 2),
        "zscore_significant": zscore_significant,
        "zscore_direction": zscore_direction,
        # Activity
        "trades_sampled": len(trades),
        "total_buys": len(buys),
        "total_sells": len(sells),
        "buys_24h": recent_buys,
        "sells_24h": recent_sells,
        "buy_volume_24h_usd": round(recent_buy_usd, 2),
        "sell_volume_24h_usd": round(recent_sell_usd, 2),
        # Archetype indicators
        "longshot_ratio": round(longshot_ratio, 3),
        "near_cert_ratio": round(near_cert_ratio, 3),
        "top_event_concentration": round(top_event_concentration, 3),
        "unique_events_n": unique_events_n,
        "archetype_hint": archetype_hint,
        # Sample
        "sample_titles": sample_titles,
    }


def cmd_snapshot():
    wallets = parse_watchlist()
    print(f"Found {len(wallets)} wallets in watchlist", file=sys.stderr)
    out = {
        "taken_at": datetime.now(timezone.utc).isoformat(),
        "schema_version": "1.7",
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
        time.sleep(0.15)

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

    # Section 1: P&L delta
    print("=== P&L delta ===")
    print(f"{'Wallet':22s} {'T':>2} {'Δ Real':>9} {'Δ Cash':>9} {'Δ Total':>10} {'WinsΔ':>6} {'LossΔ':>6}")
    print("-" * 80)
    all_names = sorted(set(a["wallets"]) | set(b["wallets"]))
    for name in all_names:
        wa, wb = a["wallets"].get(name, {}), b["wallets"].get(name, {})
        d_real = (wb.get("realized_pnl", 0)) - (wa.get("realized_pnl", 0))
        d_cash = (wb.get("cash_pnl", 0)) - (wa.get("cash_pnl", 0))
        d_total = d_real + d_cash
        d_wins = (wb.get("n_realized_wins", 0)) - (wa.get("n_realized_wins", 0))
        d_loss = (wb.get("n_realized_losses", 0)) - (wa.get("n_realized_losses", 0))
        tier = wb.get("tier", wa.get("tier", "?"))
        print(f"{name:22s} {tier:>2} ${d_real:>+8.0f} ${d_cash:>+8.0f} ${d_total:>+9.0f} {d_wins:>+6} {d_loss:>+6}")

    # Section 2: archetype + scaled-to-$50 dollar Z-score (current snapshot B)
    print()
    print("=== Archetype + scaled-$50 Z-score (snapshot B — applies LESSONS.md #25) ===")
    print(f"{'Wallet':22s} {'T':>2} {'Archetype':22s} {'$Zscore':>8} {'n':>4} {'$Sum':>10} {'W/L':>7} {'WorstHit':>9} {'BestHit':>9}")
    print("-" * 115)
    for name in all_names:
        w = b["wallets"].get(name, {})
        if not w:
            continue
        wl = f"{w.get('scaled_n_wins',0)}/{w.get('scaled_n_losses',0)}"
        print(f"{name:22s} {w.get('tier','?'):>2} {w.get('archetype_hint',''):22s} {w.get('scaled_pnl_zscore',0):>+7.2f}σ {w.get('scaled_pnl_sample_n',0):>4} ${w.get('scaled_pnl_sum',0):>+8.0f} {wl:>7} ${w.get('worst_scaled_trade',0):>+8.0f} ${w.get('best_scaled_trade',0):>+8.0f}")

    # Section 3: activity rate (BUYs vs SELLs in last 24h)
    print()
    print("=== Activity in last 24h (per snapshot B) ===")
    print(f"{'Wallet':22s} {'T':>2} {'BUYs':>5} {'SELLs':>6} {'$BuyVol':>10} {'$SellVol':>10}")
    print("-" * 75)
    for name in all_names:
        w = b["wallets"].get(name, {})
        if not w:
            continue
        print(f"{name:22s} {w.get('tier','?'):>2} {w.get('buys_24h',0):>5} {w.get('sells_24h',0):>6} ${w.get('buy_volume_24h_usd',0):>9.0f} ${w.get('sell_volume_24h_usd',0):>9.0f}")

    # Section 4: CTDD-flagged rotation candidates (gates from LESSONS.md #25)
    print()
    print("=== CTDD candidate gate (LESSONS.md #25) ===")
    print("Required to be flagged: ALL of —")
    print("  1. Archetype = INFO_EDGE (longshot ratio < 20%; not portfolio-longtail)")
    print("  2. Scaled-$50 Z-score > +1.96σ (statistically positive at OUR size, not %)")
    print("  3. Sample n ≥ 30 positions (significance threshold)")
    print("  4. Scaled $sum > 0 (cumulative $ outcome positive)")
    print("  5. Realized $pnl > 0 (actual paid-out P&L positive — guards against unresolved-longshot inflation)")
    print("  6. Worst single trade > -$200 (tail-risk gate — no $50 trade can lose >13% of $1500 pool)")
    print()
    candidates = []
    for name in all_names:
        w = b["wallets"].get(name, {})
        if not w:
            continue
        passes = (w.get("archetype_hint") == "INFO_EDGE"
                  and w.get("zscore_direction") == "POSITIVE"
                  and w.get("scaled_pnl_sample_n", 0) >= MIN_SAMPLE_FOR_ZSCORE
                  and w.get("scaled_pnl_sum", 0) > 0
                  and w.get("realized_pnl", 0) > 0
                  and w.get("worst_scaled_trade", -1e9) > -200)
        if passes:
            candidates.append(name)
    if candidates:
        for c in candidates:
            w = b["wallets"][c]
            print(f"  ✓ {c} (Z={w['scaled_pnl_zscore']:+.2f}σ, n={w['scaled_pnl_sample_n']}, $sum=${w['scaled_pnl_sum']:+.0f}, realized=${w['realized_pnl']:+.0f}, worst=${w['worst_scaled_trade']:+.0f})")
    else:
        print("  (none — no wallet currently meets the rotation-candidate bar)")
        print()
        print("  This is the CORRECT default. Do NOT rotate based on partial gate matches.")
        print("  Re-evaluate at next snapshot. Gate exists to prevent the JustCrazy-style trap")
        print("  where wallets that LOOK positive on shallow metrics actually lose money at scale.")


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
