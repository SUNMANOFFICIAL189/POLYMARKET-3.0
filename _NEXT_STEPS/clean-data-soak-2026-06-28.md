# PATS Clean-Data Soak — "Re-measure from zero" (designed 2026-06-28)

**Purpose:** Determine, on *honest* post-fidelity paper data, whether PATS has ANY real edge — with **pre-registered** hypotheses so we never again mistake an artifact for an edge.

**Why now:** The historical "edge" (signal SELL≥0.90, +$2,717) was a **fabricated-exit-price artifact** (verified 2026-06-28: 86/88 "wins" booked at a stale ~0.515 on markets that resolved YES; the 29 honest settlements lost; zero clean NO-resolution wins). The fidelity deploy (1a/1b/3.x/Option A @ `74b8bc3`, 2026-06-28) removed that artifact going forward. **Therefore all pre-2026-06-28 P&L is contaminated and is discarded for edge-measurement.** We start clean.

---

## ZERO POINT
**2026-06-28, commit `74b8bc3`** (fidelity deploy). Only trades **opened on/after** this point count toward the edge verdict. The ~8 legacy geo positions opened pre-deploy are **tracked but EXCLUDED** from the verdict (their entry economics predate honest fills) — let them resolve naturally.

## THE INTEGRITY RULE (the whole point)
**Pre-register hypotheses + thresholds BEFORE looking at the data.** The prior failure mode was post-hoc bucket-mining — slicing 1,016 trades until a positive bucket appeared. This soak locks the thresholds first; no goalpost-shifting after data accrues.

## Pre-registered hypotheses (LOCKED 2026-06-28 — do not edit after data accrues)
| ID | Hypothesis | Pre-registered prediction |
|---|---|---|
| **H1** | Geo StarMaster copy (Fix A + equity breaker) has positive realized expectancy **net of frictions** | Unknown — the genuine test (June's +$120 was confounded by regime + roster) |
| **H2** | Signal SELL≥0.90, when settled honestly (real 0/1, no fabricated 0.5), has positive expectancy | **Predicted FAIL** — the artifact finding implies honest settlements lose. This is the falsification test of the artifact verdict. |
| **H3** | Overall bot is net-positive net of frictions over the soak | Predicted ≈ break-even-to-negative |

Pre-registering H2's predicted failure is the integrity anchor: if H2 *passes* on honest data, the artifact verdict was wrong (we learn something); if it fails, it's confirmed.

## What gets measured
- **Authoritative source:** Supabase `copy_trades`, rows with `entry_time ≥ zero point`, **RESOLVED/realized only**. The bot STATUS + daily_performance ledgers are NOT trusted for the verdict until reconciled (06-12 finding: 3 sources disagreed ~5.5×). Reconciliation is a **precondition**, or measure from Supabase alone.
- Per closed trade record: entry price, exit price, **settlement type** (resolved 0/1 | real market-close | deferred), fee, slippage, realized P&L, hold time, pipeline, side, entry band.

## The 6-gate edge test (CTDD LESSON 25) — applied per element at verdict
1. n ≥ 30 **RESOLVED** trades
2. Explicit W/L counts
3. **Z > +1.96σ** on per-trade **DOLLAR** outcomes at flat size (not %)
4. Longshot ratio < 40%
5. Cumulative $ **AND** realized $ both > 0
6. Worst single trade > −13% of pool

An element is a REAL edge **only if all 6 pass** on honestly-settled, friction-net, resolved trades.

## Artifact tripwire (the safeguard that makes this trustworthy)
Every checkpoint counts **closes whose implied exit clusters at ~0.45–0.55**. Post-1b this should be ≈ 0. If it's > 0, the fabrication path resurfaced (or a new one exists) → **STOP the soak, fix, restart the clock.** This guarantees we never re-measure the artifact.

## Duration + cadence
- **Frequency reality:** geo StarMaster ≈ 1–2 trades/day historically; signal currently ≈ 0 signals/day; geopolitics markets take days-to-weeks to RESOLVE. So **n ≥ 30 resolved per element is the binding constraint**, not calendar time.
- **Minimum soak = 6 weeks** (zero point 2026-06-28 → verdict ≈ **2026-08-10**). Geo may reach n≥30 resolved; **signal may NOT generate enough live signals to test H2** — in which case H2's verdict stands on the historical artifact analysis, with a note that live confirmation needs signal flow.
- **Cadence:** read-only checkpoints at **+2wk (~07-12)** and **+4wk (~07-26)** — *monitor only, NO decisions* (avoid peek-and-decide); **full verdict at +6wk (~08-10)**. Extend if n<30 on the active element.

## Kill criteria (early stop)
- Cumulative realized P&L **< −10% of the relevant pool** at any 2-week checkpoint → pause + investigate.
- Equity breaker trips on a **real** drawdown (post-Option A, deployment no longer false-trips) and stays tripped > 48h → investigate.
- **Artifact tripwire fires** → STOP, fix, restart clock.

## Verdict rules (at +6wk)
- Any element passing **all 6 gates** → real edge → then a **separate** scope decision (CTDD Class 2) on whether to scale. **Never auto-scale.**
- **No element passes → confirmed no edge** → the 2026-06-12 A/B/C fork is the decision (reset goal to honest ceiling / pivot to a different class / stop).
- H2: if untestable (signal idle), the artifact verdict stands; **do NOT ship "Strategy C" as an edge** regardless. (Raising MIN_SELL_ENTRY_PRICE is OK *only* as a risk-control cut of the real <0.05 catastrophic tail, never sold as an edge.)

## What counts as a "real edge" (the bar, plainly)
A **pre-registered** element that, on **≥30 honestly-settled resolved trades**, nets **positive dollars** with **Z>+1.96σ at flat size**, longshot<40%, **no single trade worse than −13% of pool**, and cumulative AND realized both positive. Anything less = noise or artifact.

## Instrumentation (measurement only — NO bot code changes)
- A read-only checkpoint script: fresh Supabase export → filter `entry_time ≥ zero point` + resolved → compute the 6 gates per element → run the artifact tripwire → print a one-page report. (Skeleton: extend `scripts/recon/` or a python on the export, mirroring the 2026-06-28 analysis in `project_pats_strategy_verdict_2026_06_28`.)
- The bot keeps running as-is; the soak does not touch trading logic.

## Provenance
Born from the 2026-06-28 strategy deep-dive (`project_pats_strategy_verdict_2026_06_28`) + the fidelity deploy (`project_pats_fidelity_proofcheck_2026_06_28`). Supersedes "ship Strategy C" (2026-05-12 audit) which is now known to harvest the artifact.
