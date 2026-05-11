# Branch 3 Geopolitics Specialist Research Sprint — Findings

**Sprint dates:** 2026-05-11 (resumed from session-end handoff)
**Time spent:** ~3h of the 4-6h time-box
**Status:** COMPLETE. Verdict locked. Build decision is the user's.

---

## TL;DR

**The 2026-05-11 baseline measurement was structurally biased.** Polymarket's Gamma `/markets?condition_ids=` endpoint silently omits resolved markets — so the original backtest could only see currently-open positions, which were systematically the wallet's still-winning bets. The true picture from the unbiased `/positions?user=X` endpoint is materially different:

| Wallet | 2026-05-11 view (Gamma-narrow) | True view (/positions, n=26 politics) |
|---|---|---|
| `0x5d05b1f5` (was treated as the lone specialist) | 75% WR, +$334 leader / +$160 prop / +$187 flat | **53.6% WR, −$2,405 net P&L, median bet $5** |

**Decision-criteria mapped outcome: BUILD via SWAP.** Replace `0x5d05b1f5` with `0x24c8cf69a0e0a17eee21f69d29752bfa32e823e1`, a much stronger geopolitics specialist surfaced from Phase 2 v2's `/positions` screen.

**Recommended Branch 3 v1 spec:**
- WATCHED_WALLETS: `[0x24c8cf69]` primary + `[0x44c1dfe4]` tier-2 (positive truePnl near-miss)
- Sizing: **flat $75** (beat proportional in every measurement)
- Pipeline: `geopolitics`, isolated capital via Option D's `GEOPOLITICS_CAPITAL` env var
- DO NOT start build before user confirms. The "diversified pool" goal isn't met — still essentially 1 primary wallet.

---

## What changed vs. the 2026-05-11 baseline

### The selection-bias bug

`scripts/backtest/branch3-geopolitics.ts` STAGE 3a fetches market prices from `gamma-api.polymarket.com/markets?condition_ids=<cid>`. Gamma silently omits markets that have already resolved and been archived. Of the 42 unique positions held by `0x5d05b1f5` in the 30-day window, Gamma returned data on only 8 — and those 8 were exactly the still-open winners. The 34 missing were mostly resolved-and-redeemed positions, where the bulk of any wallet's REALIZED P&L (positive or negative) actually lives.

### The unbiased measurement source

`data-api.polymarket.com/positions?user=<wallet>&limit=500` returns ALL of a wallet's current positions, including resolved-but-redeemable ones. Per position it exposes:
- `cashPnl` = unrealized P&L on currently-held shares
- `realizedPnl` = P&L from sells BEFORE resolution
- `redeemable` flag for resolved positions awaiting payout
- **truePnl = cashPnl + realizedPnl** = total economic P&L on the position

This is now the canonical metric for wallet-level edge measurement on Polymarket. The Gamma-based backtest harness has the same structural bias and should be replaced or supplemented (BACKLOG item 1, below).

---

## Phase-by-phase results

### Phase 1a — Polymarket leaderboard scrape (Puppeteer)
- Scraped `https://polymarket.com/leaderboard` at Weekly / Monthly / All windows, Profit-Loss sort
- DOM virtualisation limited each window to 27-35 visible wallets (vs target top-100)
- **71 unique candidates** across the three windows (1 wallet in all 3, rest window-specific)
- Output: `_NEXT_STEPS/branch-3-phase1a-leaderboard.json`
- Script: `scripts/research/phase1a-leaderboard-fetch.ts`

### Phase 1b — Audit existing 11-wallet watch list (data-api /trades)
Critical finding — the watch list is essentially stale:

| Wallet | 90d total | 90d politics | Newest |
|---|---|---|---|
| `0x5d05b1f5` | 3500+ | **908** | 7h |
| `0xee613b3f` | 3500 | 7 | 16d |
| `0xfe787d2d` | 3500 | 7 | 1.8h |
| `0x507e52ef` | 3500 | 6 | 1.8h |
| `0x204f72f3` | 3500 | 2 | 0.2h |
| 6 others | 200-3500 | 0-1 | varies |

Only 1/11 has ≥15 politics trades. 97.3% of all politics trades on the list come from `0x5d05b1f5` alone — already a flag that the "11-wallet list" is functionally a 1-wallet list. Output: `_NEXT_STEPS/branch-3-phase1b-watchlist-audit.json`.

### Phase 2 v1 — Screening via trade-derived closure (BUGGY)
Used `netShares ≈ 0` to flag closed positions. Failed for every candidate (`closed=0`) because Polymarket positions usually close via market RESOLUTION, not via the trader selling out. Empty shortlist for the wrong reason. Script kept as `scripts/research/phase2-screen-candidates.ts` for reference.

### Phase 2 v2 — Screening via /positions endpoint (UNBIASED)
- Hard filters (locked): ≥15 geopolitics positions / WR≥55% / median size $10-$500 / active≤14d
- Broader geopolitics keyword list to compensate for codebase categoriser gaps (Iran/Israel/Gaza/Netanyahu/Hezbollah/Taiwan all missing from `src/signals/market-categoriser.ts` — bug filed to BACKLOG)
- 1 wallet passes all filters; 6 are positive-PnL near-misses
- Script: `scripts/research/phase2v2-screen-via-positions.ts`
- Output: `_NEXT_STEPS/branch-3-phase2v2-shortlist.json`

### Phase 3 — Re-run backtest on shortlist
Updated `scripts/backtest/branch3-geopolitics.ts` LEADERS to `[0x24c8cf69, 0x5d05b1f5, 0x44c1dfe4]`. Legacy 11-wallet list preserved as commented `LEGACY_LEADERS_2026_05_11` block.

WINDOW_DAYS=30, MIRROR_SCALAR=0.02, GEOPOLITICS_CAPITAL=$1500. Aggregate:

| Metric | Value |
|---|---|
| Positions analyzed | 47 (closed=1, mtm=58, **skipped=119 due to Gamma bias**) |
| Total proportional PnL | +$52 |
| Total flat $75 PnL | **+$693** |
| Combined WR | 66.0% |

Per-leader (proportional only — harness doesn't break out flat per-wallet):

| Wallet | n | WR | Proportional PnL |
|---|---|---|---|
| `0x24c8cf69` | 26 | 69.2% | −$52 |
| `0x5d05b1f5` | 8 | 75% | +$159 |
| `0x44c1dfe4` | 13 | 53.8% | −$54 |

Important: the harness `0x24c8cf69 = −$52` does NOT represent the wallet's real edge — 119 positions (most resolved) were skipped. The true picture is below.

---

## The shortlist passer in detail

### `0x24c8cf69a0e0a17eee21f69d29752bfa32e823e1`

| Metric | Value (broader filter via /positions) |
|---|---|
| Geopolitics positions | 146 (of 196 total — 74.5% specialist concentration) |
| **Resolved-only WR** | **69.6% (48/69)** |
| **Resolved-only realized P&L** | **+$116,529** |
| All-position WR (cashPnl+realizedPnl > 0) | 62.4% |
| All-position truePnl | +$142,791 |
| Median position size | $167 |
| p75 size | $713 |
| p90 size | $3,066 |
| Max size | $315,000 (a hedged JD Vance 2028 position — YES + NO both held, net ~$0) |
| Newest trade | 0.6h ago (ultra-active) |
| Source | leaderboard-Weekly |

Sample of top wins (resolved + open):
- +$123K on "Will Kevin Warsh be confirmed as Fed Chair?" (open, init $2862)
- +$82K on "US x Iran permanent peace deal by April 22, 2026?" (**redeemed**, init $4 — pure lottery hit)
- +$32K on "Will the Iranian regime fall before 2027?" (open, init $713)
- +$19K on "Trump announces end of military operations against Iran by April 7th?" (**redeemed**, init $320)
- +$10K on "US x Iran permanent peace deal by May 15, 2026?" (open)

Sample of top losses:
- −$16K on "Netanyahu out by June 30?" (open)
- −$12K on "Will the next Prime Minister of Hungary be János Lázár?" (resolved-redeemed)
- −$11K on "US x Iran permanent peace deal by May 13, 2026?" (open)

Interpretation: heavy specialist in Iran/Israel/Trump-foreign-policy markets with a mix of (a) targeted bets on confirmable events and (b) low-cost longshot YES bets on event-by-date markets. Variance is high, but the resolved track record is undeniably positive.

### Tier-2 candidate: `0x44c1dfe43260c94ed4f1d00de2e1f80fb113ebc1`
30 geo positions, WR 46.7% (failed 55% threshold), truePnl **+$20,586**, median size $139. Positive net P&L despite sub-threshold WR. Worth tracking; not eligible for the primary watch list.

### Other positive-PnL near-misses (positives but failed ≥1 filter)
- `0xde7be6d4` — 138 geo, WR 29.7%, truePnl **+$321K**, median $1351 (whale — too big for our sizing)
- `0xd7f85d0e` — 10 geo, WR 60%, truePnl +$2.5K (count too low + whale)
- `0x84cfffc3` — 5 geo, WR 100%, truePnl +$962 (sample too small)
- `0x507e52ef` — 11 geo, WR 45.5%, truePnl +$399 (just under thresholds)

---

## Verdict (locked criteria → outcome)

| Locked criterion | Holds? | Action |
|---|---|---|
| Diversified positive PnL on larger sample → BUILD | Partial — n=47 (6× expansion) with +$52 prop / +$693 flat. Positive but not "diversified" (1 primary + 2 secondaries) | BUILD with flat sizing v1 |
| `0x5d05b1f5` is the only consistent specialist → KILL / small-cap | FALSE — `0x24c8cf69` is decisively stronger | not applicable |
| Shortlist outperforms `0x5d05b1f5` → SWAP | TRUE on /positions ground truth (+$142K vs −$2.4K). FALSE in Gamma-biased harness | SWAP — drop `0x5d05b1f5`, lead with `0x24c8cf69` |

**Recommendation: BUILD via SWAP.** Build Branch 3 v1 with:
- `WATCHED_WALLETS = [0x24c8cf69]` primary
- Tier-2 candidate: `0x44c1dfe4` (track separately; not in active mirror list)
- Sizing: **flat $75** (out-performed proportional in every cut)
- Pipeline: `geopolitics` (Option D infrastructure already shipped 2026-05-11)
- Concentration caveat: still one primary wallet. Recommend a 30-day paper soak before considering live.

---

## What this sprint did NOT accomplish

- True "diversified pool" — Phase 1a's leaderboard scrape was capped by DOM virtualisation; we have 1 strong passer + 1 tier-2, not 5-10
- Out-of-sample backtest validation — Phase 3 backtest's structural bias means the verdict rests on /positions snapshot data, not a clean replay
- Outcome on the 6 leaderboard wallets that returned 0 trades from data-api (`0x56687bf4`, `0x1f2dd6d4`, etc. — these may be PROXY wallets or otherwise non-trade-active addresses; would need separate investigation)

---

## Discovered bugs / BACKLOG candidates

1. **Codebase market categoriser misses Iran/Israel/Gaza/Netanyahu/Taiwan** — `src/signals/market-categoriser.ts:KEYWORDS.politics` should be extended. Caused under-counting of geopolitics activity for both screening and the backtest harness. Should be patched **before** Branch 3 ships.
2. **Branch 3 backtest harness uses Gamma `/markets?condition_ids=` for MTM** — silently omits resolved markets, creating selection bias. Replace or supplement with `/positions?user=X` aggregation.
3. **Polymarket leaderboard DOM scrape capped at ~27-35 wallets per window** — DOM virtualisation hides rows. Future work: programmatically scroll + intercept the lazy XHR call (the leaderboard frontend must have a paginated backend the page lazy-loads from).
4. **`/positions` endpoint is now the canonical wallet-edge measurement** — should become a first-class tool in the bot's leader-evaluation flow (potentially replace or augment `scorer.ts`'s composite score with per-position resolved-PnL).

---

## Files created this sprint

| File | Purpose |
|---|---|
| `_NEXT_STEPS/MISSION_BOARD-branch3-research-2026-05-11.md` | Sprint mission board |
| `scripts/research/phase1-leaderboard-recon.ts` | API/recon probe |
| `scripts/research/phase1a-leaderboard-fetch.ts` | Puppeteer leaderboard scrape |
| `scripts/research/phase1b-audit-watchlist.ts` | data-api audit of existing 11 wallets |
| `scripts/research/phase2-screen-candidates.ts` | v1 screener (buggy — trade-derived closure) |
| `scripts/research/phase2v2-screen-via-positions.ts` | v2 screener (unbiased — uses /positions) |
| `_NEXT_STEPS/branch-3-phase1a-leaderboard.json` | Phase 1a output |
| `_NEXT_STEPS/branch-3-phase1b-watchlist-audit.json` | Phase 1b output |
| `_NEXT_STEPS/branch-3-phase2-shortlist.json` | Phase 2 v1 output (empty due to bug) |
| `_NEXT_STEPS/branch-3-phase2v2-shortlist.json` | Phase 2 v2 output (canonical shortlist) |
| `_NEXT_STEPS/branch-3-research-2026-05-11.md` | This document |

Plus `scripts/backtest/branch3-geopolitics.ts` LEADERS array updated; legacy preserved as commented `LEGACY_LEADERS_2026_05_11`.
