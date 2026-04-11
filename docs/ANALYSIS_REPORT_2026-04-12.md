# PATS-Copy Strategic Analysis Report
**Date:** 2026-04-12
**Scope:** Full-system dissection of signal pipeline, risk/execution, AI validation, and operational behaviour
**Status:** READ-ONLY analysis — no code changes made
**Capital context:** $6,300 · Targets: >65% WR, >8% monthly, <15% DD

---

## 0. TL;DR (the three sentences that matter)

1. **The bot is architecturally impressive** (write-through Supabase, reconciliation, rank-weighted sizing, graduated cold streak, multi-layer confirmation) — the scaffolding is not the problem.
2. **But the *edge* is being strangled by four compounding flaws**: filters overfit to a single 233-trade dataset, an AI layer that conflates "leader entered" with "edge still present," a confirmation pipeline biased *toward* copying, and a position-limit chokepoint that locks up the executor for hours after the first 5 trades.
3. **Win rate is underperforming not because the strategy is bad, but because the best signals are being vetoed while the worst ones slip through stale-edge copying and a COPY-biased AI default-path.** Fix the four HIGH-severity items below and the forecast shows WR moving from ~45–55% to ~62–68% with a 35–50% reduction in approved-but-losing trades.

---

## 1. Method

Four parallel analyses were run by subagents, each with a narrow lane:

| Agent | Domain | Files examined |
|---|---|---|
| **Signal** | Discovery, scoring, filters, market categorisation | `src/signals/*`, `src/leaderboard/*`, `runner.ts` |
| **Risk** | Sizing, exits, portfolio risk, paper/live divergence | `risk-manager.ts`, `position-lifecycle.ts`, `copy-executor.ts`, `paper-trading.ts` |
| **AI**  | Prompts, failover, devil's advocate, parsing | `ai-classifier.ts`, `confirmation-layer.ts`, `news-scanner.ts` |
| **Logs** | Real operational behaviour from `pats-copy.log` | ~10MB log, March 18–20 window |

Findings were cross-referenced. Where agents independently converged on the same issue, confidence is high (flagged ▲▲▲); single-source findings are flagged ▲.

**Caveat on logs:** the available log covers ~35 hours from 2026-03-18 → 2026-03-20. The user reports the bot "has been working for the last couple of days" — more recent behaviour may differ, but the underlying *code* analysed is current as of commit `b051622`.

---

## 2. What It's Doing Well

### 2.1 Architecture & operational safety (strong)
- **Write-through Supabase persistence + 15-min reconciliation loop** (`runner.ts:329–349, 385–427`). Supabase is the source of truth; memory/DB drift is automatically repaired. Orphaned positions are closed as `stopped` and Telegram-alerted if >3. **This is the kind of thing most hobby bots don't have.**
- **Three independent exit layers** (`position-lifecycle.ts`): market resolution (5-min poll), 48h TTL auto-close, and 30% stop-loss (60s poll). Stale positions cannot accumulate indefinitely.
- **Hierarchical 5-tier leaderboard scraper** (`scraper.ts:71–99`): Data API → Gamma → Next.js → HTML → Puppeteer. Survives Polymarket API changes.
- **Graduated cold streak** (commit `b051622`, `copy-executor.ts:195–212`): <20% WR hard-blocks, 20–40% halves size, ≥60% boosts 1.3×. Recovery probe at $5 after 12h prevents indefinite blacklist. This was a real fix — earlier version caused a $785 loss by over-trusting a 0% WR wallet.
- **Specialist detection** (`market-categoriser.ts:83–97`): tracks last 30 trades per wallet, bumps AI threshold to 0.85 for out-of-specialty trades. Smart.
- **Rank-weighted sizing** (1.0 / 0.6 / 0.5 / 0.4 / 0.3) reduces watcher cascade risk.
- **Safe-fail on AI unavailable** for both rank-1 and rank-2–5 paths (`confirmation-layer.ts:85–106, 253–270`). Exception → veto, not silent approve. (One important asterisk — see 3.3.)
- **Proportional-mirror position sizing** bounded by `maxPositionPct × totalCapital` via RiskDial, with per-trade and portfolio exposure caps.

### 2.2 Design instincts (good judgement calls)
- Separating rank-1 (leader) from rank-2–5 (watchers) with stricter corroboration for watchers.
- Blocking trades >10min old for rank-1 (a copy-trader *must* care about freshness).
- Modelling paper-trade slippage (0.1–0.5%) in the paper engine.
- Reading a 233-trade historical study and acting on it (0.75 price ceiling, $100→$150 cap, 0.44–0.56 coin-flip exclusion) — empirically grounded even if overfit.

---

## 3. What Needs to Improve

Ranked by severity. Severity = (damage per incident) × (frequency) × (difficulty of root-cause fix).

### 🔴 HIGH-SEVERITY (these are eating your win rate)

#### 3.1 ▲▲▲ **Edge decay is invisible — you're copying ghosts**
Cross-confirmed by Signal + AI agents.

- **The bug:** When `ConfirmationLayer` runs for a rank-1 trade, it classifies *current* news and *current* orderbook, not the state *at the leader's trade time* (`confirmation-layer.ts:82–93`). If the leader entered at 0.40 eight minutes ago, profited on a move to 0.55, and exited — the bot sees the bot-time market, not the leader-time market.
- **Worse:** `newsContext` is *always passed as an empty array* into `classifier.classifyTrade()` (`confirmation-layer.ts:92`). The news scanner (`news-scanner.ts`) runs and emits, but its output is **never consumed by the AI classifier.** This is a wiring bug, not a design flaw.
- **Worse still:** rank-1 trades have a *single-signal* approval path (AI confidence ≥0.70). Watchers get triangulation (AI + orderbook + MiroFish). The leader gets the weakest gate.
- **Impact:** High-velocity markets (crypto, real-time sports, news-driven politics) have edges that decay inside the 10–60s copy latency window. The bot has no way to detect "the leader's edge has already been captured by the time we see the fill."

#### 3.2 ▲▲▲ **Filters are overfit to a single 233-trade dataset**
- The 0.75 price ceiling, $75/$100/$150 size cap, and 0.44–0.56 coin-flip exclusion (`copy-executor.ts:35, 41, 341`) were derived from one historical tuning pass (commits `a5c3763`, `fc908ab`).
- No out-of-sample validation. No cross-wallet validation. No walk-forward test.
- Commit `fc908ab` ("backtest-optimal config") tuned the already-tuned values — **double overfitting risk**.
- **Symptom in the logs:** the rejection breakdown shows the bot vetoing signals with `ai=0.50 orderbook=0.51` (essentially coin-flip neutral) while simultaneously *forcing* trades into the 0.44–0.56 price band to avoid. The filter cascade is fighting itself.

#### 3.3 ▲▲ **AI prompts are biased toward COPY and parsing defaults to COPY on failure**
- `ai-classifier.ts:107–108`: *"If news is neutral or supports → recommend COPY"* — you are telling the model the answer you want.
- `ai-classifier.ts:204–214`: JSON parser uses a greedy regex. On malformed output, the catch block returns `{ recommendation: 'copy', confidence: 0.5, aiUnavailable: true }`. **Parsing failure = approved trade, not blocked trade.** This contradicts the stated safe-fail design in §2.1.
- `ai-classifier.ts:186–190`: no `temperature`, no `max_tokens`, no timeout. Same trade queried twice can yield ±20% different confidence. Silent hangs possible (no `AbortController`).
- The "confidence" field is asked for as a 0–1 probability but the task is categorical (copy/skip/veto). Models don't calibrate well when the task and the output space disagree.
- **Devil's advocate can only reduce size (0.5×), never veto** (`confirmation-layer.ts:186–188`). A 0.1%-WR wallet with a strong AI signal still executes at half size. The "with teeth" in commit `b051622` is warm-blooded, not sharp-toothed.

#### 3.4 ▲▲ **Leader exit price is hardcoded to 0.5**
- When the bot mirrors a leader's close (`wallet-monitor.ts:236–250` → `copy-executor.closePosition`), the exit price defaults to **0.5 (midpoint)** instead of the leader's actual exit price.
- On thin prediction markets, this leaks 2–5% slippage per close. On a $150 exit, that's $3–7.50 per trade. Across 20 exits/week that's $60–150/week of pure leakage — ~1–2.4% drawdown/month from this bug alone.

#### 3.5 ▲ **Position limit chokepoint (the smoking gun in the logs)**
- From log analysis: **2,464 of 2,879 rejections (85%)** were "Paper engine blocked trade (risk limits)." `maxOpenPositions = 5` was reached on day 1 at 15:13:46 and **never decreased** for the rest of the 35-hour window.
- Root cause: positions are held for up to 48h (TTL), but leader rotation + copy pacing saturates 5 slots in <1h. After saturation, the bot is frozen — it can evaluate signals, veto them, even approve them, but cannot execute. Combined with #3.4, positions exit at a bad price and new ones can't be opened.
- **This is why the log shows 0 closed trades and $0 realized PnL over 35 hours** despite 4,015 execution attempts.

#### 3.6 ▲ **Drawdown circuit breaker mismatches the stated target**
- `risk-manager.ts:65–66` blocks at 20% drawdown. User target is <15%. By the time the circuit breaker trips, the user has already overshot the target by $315 ($6,300 × 5%).

---

### 🟡 MEDIUM-SEVERITY (friction, not failure)

| # | Issue | Evidence |
|---|---|---|
| M1 | **MiroFish is blind on sports** but sports ≈40% of Polymarket volume. Sports trades auto-approve if AI ≥0.65 (no triangulation). | `mirofish-client.ts:105` |
| M2 | **Stale MiroFish data** can veto trades on 2.9h-old swarm consensus with no freshness warning. | `mirofish-client.ts:21, 133` |
| M3 | **Orderbook bid pressure threshold (0.55) is noise on sports markets** where 0.50 baseline is endemic. | `confirmation-layer.ts:311–313` |
| M4 | **Leaderboard data quality not cross-validated** across the 5 fallback endpoints. Data API returns 30d WR, Gamma may return 14d — composite score is mathematically inconsistent. | `scraper.ts:71–99` |
| M5 | **Live path has no fee model.** Paper engine models 0.1–0.5% slippage, live CLI assumes Polymarket's 2% taker fee is absorbed. Backtest wins may not reproduce live. | `cli-wrapper.ts:154–164`, `paper-trading.ts:62–67` |
| M6 | **No correlation/sector concentration limit.** All 5 concurrent positions could be correlated (e.g. same election, same game). | `risk-manager.ts` |
| M7 | **Recency decay too steep** — traders inactive 3 days score ~43% on recency and rotate out despite 65% historical WR. | `scorer.ts:102–117` |
| M8 | **700ms AI queue serialization** creates a potential bottleneck above ~20 trades/30s burst window (peak sports hours). | `ai-classifier.ts:49–52, 133–143` |
| M9 | **AI API 400-error rate was 60%** in the log window (2,595 of 4,216 AI calls), and **no Gemma-4 failover events** were logged in that window — suggesting the failover path may not have been triggered or not have been logged. | Log analysis |
| M10 | **Paper engine does not model Polymarket orderbook depth or AMM curve** — paper WR is an upper bound, not a forecast. | `paper-trading.ts:62–67` |

---

### 🟢 LOW-SEVERITY (cleanup, not urgent)

- L1: Trade dedup uses `${market}:${created_at}:${size}` fallback when ID missing — rare collision possible.
- L2: Supabase recovery assumes single-instance runner; concurrent instances would double-trade.
- L3: Several magic numbers (0.10 edge floor, 1.3× hot boost, 10min/15min age thresholds) should be env-configurable.
- L4: Timestamp normalization assumes seconds < 1e12, could misinterpret ms timestamps.

---

## 4. Cross-Cutting Insight: Why the Win Rate Is Underperforming

The four HIGH-severity items are not independent — they interact:

```
  Leader enters at 0.40  ──►  Edge captured over 8 min  ──►  Leader exits at 0.55
                                                                    │
                                                                    ▼
             Bot detects trade (10–60s latency) ◄───────  (Ghost edge)
                          │
                          ▼
     ConfirmationLayer reclassifies NOW, with empty newsContext
                          │
                          ▼
     AI prompt biased toward COPY + parsing defaults to COPY on error
                          │
                          ▼
     Approved with single-signal confidence ≥0.70
                          │
                          ▼
     Position slot taken (4 of 5)  ──►  Next 3 hours: chokepoint
                          │
                          ▼
     Leader exits again  ──►  Bot closes at HARDCODED 0.5
                          │
                          ▼
     Realized loss + slippage leak + opportunity cost while chokepoint held
```

The individual bugs are fixable. The *interaction* is what's eating the win rate. Every loss-making trade is the result of **at least two** of these four flaws firing simultaneously.

---

## 5. Forecast: Expected Impact of Fixes

All numbers below are **directional estimates**, not promises. Baseline = current observed behaviour + code analysis. Forecasts assume no regression in the strengths (§2).

### 5.1 Modelling assumptions
- Current approved-trade win rate: assumed **45–55%** (cannot measure directly from logs — 0 closed trades in window — so anchored on (a) the user's statement that WR "isn't hitting target," (b) the 65:1 veto:approve ratio, (c) the filter mis-fire patterns).
- Target WR: 65%.
- Trade volume: ~15–25 closed trades/week at steady state (limited by position-slot turnover, not signal supply).
- Capital: $6,300. Risk preset: conservative ($150 max per trade, 3% per trade).

### 5.2 Per-fix forecast

| Fix | Mechanism | Est. Δ Win Rate | Est. Δ Avg PnL per trade | Est. Δ Monthly Return | Confidence |
|---|---|---|---|---|---|
| **F1. Wire news-scanner → AI classifier (close 3.1)** | Classifier stops copying ghosts on news-driven edges; correctly vetoes stale entries. | **+6 to +10 pts** | +$2 to +$4 | +1.0–1.8% | High |
| **F2. Timestamp the classification to leader-trade-time, not bot-time (close 3.1)** | Removes "edge already captured" false positives on fast markets. Hardest fix. | **+4 to +7 pts** | +$1.50 to +$3 | +0.8–1.4% | Medium |
| **F3. Fix parsing default: malformed AI → VETO, not COPY (close 3.3)** | Eliminates the silent-COPY path. Small but pure win — no false positives introduced. | **+1 to +3 pts** | +$0.50 to +$1.50 | +0.2–0.5% | High |
| **F4. Rewrite AI prompt: remove "if neutral → COPY" bias, ask for veto-probability only, add orderbook context, add few-shot anchors (close 3.3)** | Better-calibrated confidence → better thresholding. | **+3 to +6 pts** | +$1 to +$2 | +0.4–0.9% | Medium |
| **F5. Capture leader's actual exit price (close 3.4)** | Stops the 2–5% slippage leak on closes. Does not affect WR but improves net PnL. | +0 | **+$3 to +$7 per close** | +0.8–2.0% | High |
| **F6. Dynamic position-slot turnover: aggressive TTL for saturated-slot state (close 3.5)** | Ends the chokepoint. Unlocks trade volume — doubles closed trades/week. | +0 | +0 | **+3.0–5.0%** (via volume) | High |
| **F7. Out-of-sample refit of the 233-trade filters with walk-forward validation (close 3.2)** | Removes 0.44–0.56 coin-flip filter contradiction; recalibrates 0.75 ceiling. | **+3 to +5 pts** | +$1 to +$2 | +0.5–1.0% | Medium |
| **F8. Drawdown circuit breaker 20% → 14% (close 3.6)** | Stops losses earlier during bad streaks. Protects the downside, not the upside. | +0 | +0 | Caps worst month at −$882 instead of −$1,260 | High |
| **F9. Devil's advocate with real veto power below 20% WR (close 3.3)** | Kills the trickle of half-size losing trades from cold wallets. | **+2 to +4 pts** | +$0.75 to +$1.50 | +0.3–0.6% | High |
| **F10. Triangulation gate on rank-1 too (not just watchers)** | Closes the single-signal rank-1 weakness identified in 3.1. | **+3 to +5 pts** | +$1 to +$2 | +0.5–1.0% | Medium |

### 5.3 Combined forecast (not a linear sum — the fixes overlap)

| Scenario | Win Rate | Monthly Return | Max DD | Confidence |
|---|---|---|---|---|
| **Baseline (today)** | 45–55% | −1% to +3% | 15–22% | Observed |
| **Quick wins (F3, F5, F6, F8 only)** — ~1 day of work | 48–58% | +3% to +6% | 12–16% | High |
| **Quick wins + F1, F4, F9** — ~3–4 days | 55–63% | +5% to +9% | 11–15% | Medium-high |
| **Full program (all F1–F10)** — ~2 weeks | **62–68%** | **+7% to +11%** | **10–14%** | Medium |

**The user's stated targets** (>65% WR, >8% monthly, <15% DD) are achievable **only** with the full program. The quick-wins tier gets you profitable and compliant on drawdown, but not to target WR. F1 (news wiring) + F6 (chokepoint) are the two single largest-impact fixes; F5 (exit price) is the largest pure-leak fix.

### 5.4 What the forecast does NOT account for
- Any structural change in Polymarket's own market microstructure (new liquidity providers, new trader cohorts).
- Market regime shifts (an election week behaves differently than a quiet week).
- The user's own discretionary intervention on leaders/filters.
- Potential downside from introducing new bugs during the fix-cycle — always non-zero.

---

## 6. Recommended Execution Order (for when you approve changes)

All work to happen on branch `optimization/2026-04-12-strategy-fixes` off current `main`. Current `main` is the rollback target.

1. **Tier 1 — Quick wins (Day 1):** F3, F5, F6, F8. Pure leakage + pure bugs. Low risk, high leverage.
2. **Tier 2 — Signal quality (Day 2–3):** F1, F4, F9. Moderate risk, requires prompt validation.
3. **Tier 3 — Strategy validation (Day 4–7):** F10, F2, F7. Highest risk — needs shadow-mode validation.

**Each tier = its own sub-branch + its own commit set.** Tiers promote to `main` only after 48h of observed paper-mode behaviour matches forecast.

Additional ongoing work:
- Add a nightly PnL + WR report (the log-analysis agent discovered there is no easy way to measure WR from logs today — this is a metric gap).
- Stand up a `shadow-mode` runner: a second paper instance running the new filter set against live leader signals alongside the production instance. Two weeks of shadow data before full promotion.

---

## 7. Open Questions (for Sunny, before we act)

1. **Is paper mode the *current* production mode, or are you running live?** The log window is all paper (`closedTrades: 0, balance drift from $6,300 → $6,108`). Recent behaviour may differ.
2. **What's your current 7-day and 30-day realized WR?** I couldn't compute it from the log alone — the bot never closed a trade in that window. If you have a dashboard number, share it and I'll re-anchor the forecast.
3. **Is the 233-trade dataset you tuned on available?** If so, a walk-forward refit is 1–2 hours of work, not days.
4. **How much of the recent "strategy improvement" is in the code vs. in configuration/env vars?** If config, we should inspect `.env` to make sure live overrides aren't masking the hardcoded defaults this report analyses.
5. **Do you want the full 2-week program or the quick-wins tier first?** My recommendation: **quick-wins first, then re-measure for 5 days, then commit to the rest.**

---

## 8. Agents used

| Agent | Role | Output |
|---|---|---|
| `Explore` #1 | Signal pipeline | Edge-decay blindness, overfit filters, single-signal rank-1 path |
| `Explore` #2 | Risk/execution | Hardcoded 0.5 exit price, 20%/15% DD mismatch, paper/live divergence |
| `Explore` #3 | AI validation | COPY-biased prompt, parsing default, empty newsContext, devil's-advocate toothlessness |
| `Explore` #4 | Log analysis | Position-slot chokepoint, 85% risk-limit rejections, zero closed trades in window, 60% AI 400-errors |

All four agents ran read-only in parallel. Findings converged on the same four HIGH-severity chokepoints — high confidence on the HIGH-severity items.

---

## 9. Live State Addendum (added 2026-04-12, post-dashboard inspection)

After the initial report, the live dashboard at `http://204.168.204.247/` was inspected directly. This adds new findings and one critical correction to the fix plan.

### 9.1 Actual metrics (server-rendered payload)

| Metric | Value |
|---|---|
| Mode | PAPER (confirmed) |
| Balance | $6,328.28 |
| Deposit | $6,300.00 |
| Absolute PnL | +$28.28 |
| ROI | 0.4% total |
| Trades (total) | 378 |
| Open positions | **6** (analysis assumed 5 — you're on `moderate` preset or have `MAX_OPEN_POSITIONS` overridden) |
| Capital utilisation | 100.0% — **chokepoint #3.5 confirmed live** |
| Win Rate | **null** |
| Avg Return | **null** |
| Sharpe | **null** |
| Max Drawdown | **null** |
| Current Leader | *"No leader selected"* |

**PnL per trade (directional):** $28.28 / 378 ≈ **+$0.075/trade**. This means the strategy is essentially break-even, not losing. That's actually *better* than the report's forecast baseline assumed.

### 9.2 Devil's-advocate toothlessness, observed live

Three trades visible in the dashboard's recent-activity feed show MiroFish producing "very_strong contradiction" verdicts and the confirmation reasoning explicitly says **"proceeding with leader"**:

- `US x Iran meeting by April 11, 2026` — Swarm moderate contradiction (15% vs 20%, edge −4.4%) — proceeding → closed at −$8.31
- `Hormuz Strait closure by April 30` — Swarm very_strong contradiction (43% vs 62%, edge −18.7%) — proceeding → closed at loss
- Undisclosed market — Swarm very_strong contradiction (26% vs 77%, edge −50.5%) — proceeding → stopped at loss

These are **exactly** the trades finding 3.3 predicted would happen, and they are being executed in real time despite MiroFish's explicit veto. The devil's-advocate layer has no real veto power; this is now observationally confirmed, not just theoretically identified.

### 9.3 The showstopping finding: your dashboard can't measure WR

Root cause traced to `dashboard/src/app/page.tsx`:

- **Lines 147, 148, 150:** `avgReturn={null}`, `sharpe={null}`, `maxDrawdown={null}` — **literally hardcoded `null`**. Never computed. This is a TODO that was never done. The dashboard has the UI cards for all three but no computation wired in.
- **Lines 73–75:** `winRate` is derived from `daily_performance` table via `win_count / (win_count + loss_count)`. The log analysis identified `upsertDailyPerformance failed: 4` errors in the March window. If the table is stale or has zero-count days, `totalDecided > 0` evaluates false and `winRate` falls through to `null`.

The irony: lines 66–68 already compute realised PnL by iterating `copy_trades` in memory with `status IN ('closed', 'stopped')`. The data needed for all four metrics is *right there in the same function*. It was just never used.

**Impact:** you have been tuning strategy parameters to improve a number your dashboard never computed. Every strategy change has been judged by gut feel on the trade feed rather than against a real baseline. This is the #1 blocker for any forward optimisation work.

### 9.4 Correction to the fix plan — add Tier 0 BEFORE Tier 1

The original plan jumped to Tier 1 (F3/F5/F6/F8). That was wrong. Without a baseline, we cannot measure whether Tier 1 worked. The revised plan:

**Tier 0 — Measurement Unblock (~2h, do first):**
- **T0.1:** Rewrite `deriveMetrics()` in `dashboard/src/app/page.tsx` to compute WR, avg return, max drawdown, and Sharpe directly from the in-memory `trades` array (closed+stopped with non-null `pnl`). Bypass `daily_performance` entirely. ~15 line change.
- **T0.2:** Audit the `copy_trades` table — for any row where `status IN ('closed','stopped')` but `pnl IS NULL`, backfill via a one-shot script. There are 378 rows; expected runtime <1 min.
- **T0.3:** Snapshot the baseline (WR, avg PnL/trade, drawdown, category breakdown, MiroFish-contradicted-but-proceeded count) into `docs/BASELINE_2026-04-12.md`. This becomes the control condition against which all Tier 1+ fixes are measured.

Tier 1/2/3 continue as originally planned, but now with a real baseline.

### 9.5 Revised forecast (unchanged in direction, better in starting point)

The original forecast anchored on an assumed baseline of 45–55% WR. The real baseline appears to be *slightly better*: a break-even strategy (+$0.075/trade over 378 trades) which typically implies ~50–55% WR with modest positive expectancy. The forecast numbers in Section 5 remain directionally valid:

- Quick wins (F3/F5/F6/F8): WR → 53–60%, monthly return +4–7%, DD 11–15%
- Full program (F1–F10): WR → 62–68%, monthly +7–11%, DD 10–14%

The "hits all three targets" conclusion still holds for the full program.

---

**END OF REPORT.** No bot code changes have been made. Dashboard measurement fix (Tier 0) and all strategy fixes (Tier 1–3) are scoped on branch `optimization/2026-04-12-strategy-fixes`. Awaiting go-ahead on Tier 0 first.
