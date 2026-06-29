#!/usr/bin/env python3
"""
PATS clean-data soak checkpoint — "re-measure from zero".

Reads a copy_trades JSON export, scores honest POST-FIDELITY trades against the
pre-registered 6-gate edge bar, runs the fabricated-exit ARTIFACT TRIPWIRE, and
prints a one-page report. NO bot/strategy changes — measurement only.

Usage:
    python3 scripts/soak/checkpoint.py [export.json]

Refresh the dataset first (server, where .env has creds):
    npx tsx scripts/soak/export-trades.ts        # writes soak-export.json

Spec + thresholds: _NEXT_STEPS/clean-data-soak-2026-06-28.md
Provenance: 2026-06-28 strategy verdict (the SELL>=0.90 fabricated-exit artifact).
"""
import json, sys, math, statistics
from datetime import datetime, timezone

# ---- pre-registered config (LOCKED 2026-06-28 — do not edit after data accrues)
ZERO_POINT  = "2026-06-28"          # fidelity deploy, commit 74b8bc3
POOL        = {"signal": 6300.0, "copy": 6300.0, "geopolitics": 750.0}
MIN_N       = 30                    # gate 1: resolved trades
Z_BAR       = 1.96                  # gate 3: dollar-outcome significance
LONGSHOT    = 0.40                  # gate 4: <40% of trades at entry <= 0.05
TAIL_PCT    = 0.13                  # gate 6: no single trade worse than -13% of pool
DEFAULT_EXPORT = "soak-export.json"

def num(x): return isinstance(x, (int, float))

def load(path):
    d = json.load(open(path))
    return d if isinstance(d, list) else (d.get("trades") or d.get("data") or [])

def entry_dt(r):
    t = r.get("entry_time") or r.get("created_at") or ""
    try: return datetime.fromisoformat(str(t).replace("Z", "+00:00"))
    except Exception: return None

def implied_exit(r):
    """Reconstruct the exit price the engine used. shares=size/entry (the bot's
    convention); SELL pnl=(entry-exit)*shares, BUY pnl=(exit-entry)*shares."""
    e, s, p = r.get("our_entry_price"), r.get("our_size"), r.get("pnl")
    if not (num(e) and num(s) and num(p)) or s <= 0 or e <= 0: return None
    return e - p / (s / e) if r.get("side") == "sell" else e + p / (s / e)

def resolved(rs):
    return [r for r in rs if r.get("status") in ("closed", "stopped") and num(r.get("pnl"))]

def gates(trades, pool):
    rs = resolved(trades)
    n = len(rs)
    if n == 0: return None
    pnls = [r["pnl"] for r in rs]
    tot  = sum(pnls)
    wins = sum(1 for p in pnls if p > 0)
    loss = sum(1 for p in pnls if p < 0)
    mean = tot / n
    sd   = statistics.pstdev(pnls) if n > 1 else 0.0
    z    = (mean / (sd / math.sqrt(n))) if sd > 0 else 0.0
    longs = sum(1 for r in rs if num(r.get("our_entry_price")) and r["our_entry_price"] <= 0.05) / n
    worst = min(pnls)
    tail_limit = -TAIL_PCT * pool
    g = {
        "G1 n>=30":        (n >= MIN_N,        f"n={n}"),
        "G2 W/L":          (True,              f"{wins}W/{loss}L"),
        "G3 Z>+1.96":      (z > Z_BAR,         f"Z={z:+.2f}"),
        "G4 longshot<40%": (longs < LONGSHOT,  f"{longs*100:.0f}%"),
        "G5 cum$>0":       (tot > 0,           f"${tot:+.0f}"),
        "G6 worst>-13%":   (worst > tail_limit,f"${worst:+.0f} vs ${tail_limit:.0f}"),
    }
    return {"n": n, "tot": tot, "z": z, "wins": wins, "loss": loss,
            "worst": worst, "gates": g, "pass": all(v[0] for v in g.values())}

def show(name, trades, pool):
    r = gates(trades, pool)
    if not r:
        print(f"  {name:26} n=0  (no resolved trades yet)"); return
    print(f"  {name:26} n={r['n']:3d}  ${r['tot']:+7.0f}  Z={r['z']:+5.2f}  "
          f"{r['wins']}W/{r['loss']}L  worst ${r['worst']:+.0f}   "
          f"{'✅ REAL EDGE' if r['pass'] else '— no edge'}")
    if not r["pass"]:
        print("       fails: " + ", ".join(f"{k}({v[1]})" for k, v in r["gates"].items() if not v[0]))

def tripwire(rs, label):
    """Near-cert trades (entry>=0.85 or <=0.15) closing at a fabricated ~0.5 exit."""
    hits = [r for r in resolved(rs)
            if num(r.get("our_entry_price"))
            and (r["our_entry_price"] >= 0.85 or r["our_entry_price"] <= 0.15)
            and (lambda x: x is not None and 0.45 <= x <= 0.55)(implied_exit(r))]
    booked = sum(r.get("pnl", 0) for r in hits)
    print(f"  {label:22} flagged {len(hits):3d} near-cert closes at ~0.5   "
          f"(P&L booked on them: ${booked:+.0f})")
    return hits

def main():
    path = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_EXPORT
    try:
        rows = load(path)
    except FileNotFoundError:
        print(f"export not found: {path}\nrefresh with:  npx tsx scripts/soak/export-trades.ts"); sys.exit(1)

    zp = datetime.fromisoformat(ZERO_POINT + "T00:00:00+00:00")
    days = (datetime.now(timezone.utc) - zp).days
    soak   = [r for r in rows if (entry_dt(r) or zp.replace(year=2000)) >= zp]
    legacy = [r for r in rows if r not in soak]
    sc = resolved(soak)

    print("=" * 74)
    print(f"PATS CLEAN-DATA SOAK CHECKPOINT   zero point {ZERO_POINT} (deploy 74b8bc3)  +{days}d")
    print(f"export: {path}")
    print(f"rows={len(rows)}  |  post-zero-point soak={len(soak)} ({len(sc)} resolved)  |  legacy excluded={len(legacy)}")
    print("=" * 74)

    print(f"\nSOAK WINDOW — resolved trades: {len(sc)}  (need n>=30 per element for a verdict)")
    if not sc:
        print("  No resolved post-deploy trades yet — re-run at the +2wk checkpoint.")
    else:
        print(f"\n  {'element':26} {'n':>4}   {'cum$':>7}   {'Z':>5}   W/L    worst    verdict")
        print("  " + "-" * 70)
        for pl in ("geopolitics", "signal", "copy"):
            ps = [r for r in sc if r.get("pipeline") == pl]
            if ps: show(pl, ps, POOL.get(pl, 6300))
        sig = [r for r in sc if r.get("pipeline") == "signal" and r.get("side") == "sell"
               and num(r.get("our_entry_price"))]
        b90 = [r for r in sig if r["our_entry_price"] >= 0.90]
        blo = [r for r in sig if r["our_entry_price"] < 0.50]
        if b90: show("signal SELL>=0.90 (H2)", b90, POOL["signal"])
        if blo: show("signal SELL<0.50", blo, POOL["signal"])

    print("\nARTIFACT TRIPWIRE — fabricated ~0.5 exits on near-cert positions")
    soak_hits = tripwire(soak, "SOAK window")
    tripwire(legacy, "legacy (calibration)")
    if soak_hits:
        print("  🛑 TRIPWIRE FIRED in the soak window — fabricated-exit bug resurfaced. STOP, fix, restart the clock.")
    else:
        print("  ✅ soak window clean. (Legacy hits = the known historical artifact — expected, proves the tripwire works.)")

    print("\nPre-registered bar (locked 2026-06-28): n>=30, Z>+1.96, longshot<40%, cum$>0, worst>-13% pool.")
    print("Verdict at +6wk (~2026-08-10). +2wk/+4wk checkpoints = monitor only, NO decisions.")

if __name__ == "__main__":
    main()
