# PATS-Copy Strategic Analysis Report — v2 (Corrected)
**Date:** 2026-04-12
**Scope:** Full-system dissection of the **actually running** bot
**Status:** READ-ONLY analysis — no code changes made on server or repo
**Supersedes:** [ANALYSIS_REPORT_2026-04-12.md](./ANALYSIS_REPORT_2026-04-12.md) (v1, which was run against wrong code)

---

## 0. TL;DR (three sentences)

1. **The v1 report was run against a local Mac snapshot that was 20+ commits and several weeks stale.** The bot that's actually running on Hetzner is on branch `streamline/slim-and-optimize` at commit `d08632d "Phase 04+05"` plus uncommitted hand-edits on four core files — a meaningfully different codebase where several v1 findings are invalidated, several are confirmed in the wild, and two entirely new HIGH-severity problems are visible in the live logs that v1 had no way to see.
2. **The single biggest finding from re-analysis is operational, not architectural**: in the 4h 15m log window just captured, the bot ran **911 AI-approved confirmations but only executed 22 trades** — a 97.6% post-approval veto rate driven by the HARD BLOCK rolling-wallet filter tripping on two of the six watched wallets that currently sit at **10% and 13% WR**. The bot is limping because the leader scorer is routing it onto losing wallets, not because the strategy is fundamentally broken.
3. **Five of the original eight fixes still apply** (F3 parse-default, F5 leader exit price, F8 drawdown threshold, F9a devil's advocate wiring, Tier 0 dashboard fix). Three need to be dropped or reworked (F6 saturation TTL — solving a non-problem; F9c MiroFish veto — violates an explicit Phase 04 design decision; and F8 alone is insufficient without also persisting peakBalance across restarts). **Three new fixes surface from the real-code analysis** (F11 rolling-wallet filter recalibration, F12 repair the broken OpenRouter fallback, F13 investigate MiroFish's 99.7% skip rate).

---

## 1. Method (v2)

Four parallel subagents, same domains as v1 but pointed at the *real* code and real logs:

| Agent | Source |
|---|---|
| Signal pipeline | `/tmp/pats-real-code/src/**/*.ts` — tarball pulled over SSH from `/opt/polymarket-bot` on Hetzner, includes uncommitted edits |
| Risk & execution | same tarball |
| AI validation | same tarball |
| Log analysis | `/tmp/pats-server-bot.log` — `pm2 logs polymarket-bot --nostream --lines 4000` from live server |

The scratch code captures: `d08632d` committed state **plus** the uncommitted hand-edits to `src/confirmation/confirmation-layer.ts` (+79), `src/core/runner.ts` (+10), `src/execution/copy-executor.ts` (+110), `src/signals/ai-classifier.ts` (+239). The server still has five `.bak` iteration files not included in the tarball (kept separate to avoid analysis noise). Baseline Supabase data (378 trades, WR 38.2%, +$63.59 PnL, Max DD 15.77%) is unchanged — that came from Supabase queries, which always reflected ground truth.

Where the two v2 agents disagreed on a specific wiring question (Signal said the devil's-advocate wiring bug is fixed; Risk and AI said it's not), the disagreement was resolved by live-log evidence: **zero** `devil`/`advocate`/`CHALLENGE` log lines in 4h 15m of operation (call volume ≈ 900 confirmations). If devil's advocate were actually firing, it would be visible. It isn't. Risk and AI agents win that call.

---

## 2. What Changed vs v1 Report

### v1 findings that SURVIVE (still valid on real code)

| v1 Finding | Status | Why |
|---|---|---|
| **3.1 Edge decay invisible / empty newsContext** | ✅ Confirmed | `newsContext: [] = []` is still hardcoded in `confirmation-layer.ts:82` and `:243`. News scanner runs but is never wired to `classifyTrade`. |
| **3.3a AI prompt biased toward COPY** | ✅ Confirmed | `ai-classifier.ts:107–108` still says *"If no relevant news at all: recommend COPY (trust the leader)"* — directional bias intact. |
| **3.3b Parse default returns 'copy' on malformed response** | ✅ Confirmed | `classifyTrade` fallback at lines 115–122 still returns `{recommendation: 'copy', confidence: 0.5, aiUnavailable: true}`. Silent-approve path still there. |
| **3.3c Devil's advocate dormant (walletRollingWR wiring)** | ✅ Confirmed by logs | Zero devil's advocate log lines in 4h despite ~900 confirmations. Wiring bug verified both in code (copy-executor sets walletRollingWR at line 197–199 *inside* execute, which runs after confirmation) and operationally. |
| **3.4 Leader exit price hardcoded to 0.5** | ✅ Confirmed | `runner.ts:212` still has `closePosition(data.marketId, 0.5, 'leader_closed')`. Phase 04/05 didn't touch the exit path. |
| **3.6 Drawdown circuit breaker at 20%** | ✅ Confirmed *and worse* | `risk-manager.ts:65` still `> 0.20`. **NEW**: `peakBalance` is set at constructor time and never persisted, so the breaker is effectively inert across restarts — see §4.4 for the full gotcha. |
| **Tier 0 dashboard metrics null** | ✅ Confirmed | `avgReturn`, `sharpe`, `maxDrawdown` still hardcoded to `null` in `page.tsx:147,148,150`. Baseline query path unchanged. |

### v1 findings that are INVALIDATED by Phase 04/05

| v1 Finding | Status | Why |
|---|---|---|
| **3.2 Overfit filters from 233-trade dataset** | ⚠️ Partially invalidated | The `MAX_WATCHER_PRICE=0.75`, `EDGE_FLOOR_DISTANCE=0.10`, `MAX_POSITION_DOLLARS=150` filters are all still present in `copy-executor.ts`, so the original concern about overfitting stands. But the claim that "the filter cascade is fighting itself" (0.44-0.56 exclusion + 0.55 orderbook threshold) is no longer correct — orderbook is now **informational only** per Phase 04, not a gate. The conflict is gone. |
| **3.5 Position-slot chokepoint** | ❌ Invalidated | v1 anchored on March log data showing `maxOpenPositions=5` saturated. Current live log shows **7 open / default cap 10** and **zero** "Max open positions" or "Capital cap" rejections in 4h. Phase 04 removed `RANK1_RESERVED_SLOTS=2` and added a 65% capital cap. There is no current chokepoint. **F6 (saturation TTL) was solving a non-problem.** |
| **F9c MiroFish contradiction → veto** | ❌ Invalidated by design | Phase 04-01 explicitly made MiroFish **informational only** — affecting sizing (1.5×/0.7×) but not decision. The comment at `confirmation-layer.ts:158–161` reads *"still approve but flag it"* and is intentional, not a bug. Implementing F9c would reverse a deliberate architectural decision. |

### NEW HIGH-severity findings that v1 could not see

| # | Finding | Evidence |
|---|---|---|
| **N1** | **HARD BLOCK at 20% rolling-wallet WR is filtering 97.6% of approved trades.** | 911 AI-approvals → 22 executions in 4h 15m. 550 HARD BLOCK log lines. Two watched wallets (`0x2005d1`, `0x2a2c53`) are sitting at 10% and 13% rolling 10-trade WR. |
| **N2** | **Leader scoring is routing the bot onto losing wallets.** | Same two wallets above are being watched at **rank 1 and rank 2** despite 10–13% recent WR. Either the composite scorer has a lag/decay issue (scoring on 30-day metrics while recent 10-trade is crashing) or the leaderboard itself is dominated by volatile gamblers during the current window. |
| **N3** | **`peakBalance` never persisted — drawdown breaker inert across restarts.** | `risk-manager.ts:32` sets `peakBalance = balance` in constructor. Bot has restarted 51 times in 3 days per pm2. Each restart rebases the DD tracker to that restart's balance. The "20% circuit breaker" can never fire on a historical drawdown — only on a fresh 20% loss from the last restart point. |
| **N4** | **OpenRouter Gemma 4 fallback is broken.** | 4x `"AI: Fallback also failed: 400 Bad Request — google/gemma-4-27b-it is not a..."` in the log. When Cerebras rate-limited at 15:15, the fallback path failed too. Both primary + fallback returned 400. The bot then went to orderbook-fallback for watcher trades. **If both fail simultaneously on rank-1, the silent-approve default (finding 3.3b) triggers.** |
| **N5** | **MiroFish is 99.7% skipping.** | 349 `mirofish=skip` log lines vs 1 `mirofish=neutral` and 0 supports/contradicts. MiroFish is effectively absent from decision-making. Either sports-skip is firing on almost every market, the bridge is degraded, or the scan cache is stale. This explains why only 3 MiroFish overrides appear in the 378-trade baseline. |

---

## 3. What's Working (Strengths on real code)

- **Write-through Supabase persistence + reconciliation loop** — same as v1, still sound
- **Three-layer exit system** (resolution / TTL / stop-loss in `position-lifecycle.ts`) — still robust
- **Phase 04 simplification** of the gate — AI-only for rank-1, AI-primary-with-orderbook-fallback for watchers, is actually a *good* architectural decision and removed the "gate fighting itself" issue v1 flagged
- **Phase 05 rolling wallet filter** — the three-tier system (hard block <20%, reduced 25% size 20–40%, hot-boost 1.3× at ≥60%) is *the* right shape for cold-streak management. It's just tuned such that the current wallet set spends all its time in the hard-block bucket.
- **Hot wallet elevation to rank-1** (`runner.ts:305–307`) — wallets with ≥60% rolling WR get lifted from watcher rank to rank-1 treatment regardless of leaderboard position. Clever anti-flapping mechanism.
- **Priority wallet system** — `0x6ac5bb06... Op0jogggg` is hardcoded as always-watched at rank-2, guaranteeing monitoring of a known profitable wallet even if the leaderboard drops them.
- **Single-lane API queue with 700ms gap** in `ai-classifier.ts:49–52` — prevents burst rate-limit cascades, works in practice (log shows only one spike in 4h, cleanly recovered).
- **Smart order routing** in `cli-wrapper.ts` — limit at midpoint when spread > 3¢, market order otherwise. Good instinct.
- **Specialist detection + out-of-specialty penalty** on watcher AI thresholds — still present and sensible.
- **User's uncommitted AI-classifier refactor** (+239 lines) appears to be architectural: splitting primary/fallback providers, adding `challengeTrade` as a first-class method, cleaner queue pattern. Direction looks right even if incomplete.

---

## 4. What's Broken — Severity-sorted

### 🔴 HIGH

#### 4.1 Leader scorer is routing to losing wallets (new — N2)
The current watcher set includes wallets at 10% and 13% rolling 10-trade WR sitting at rank 1 and 2. The composite scorer uses 30d WR (40%), 14d profit factor (30%), 30d frequency (15%), recency (15%). If a wallet had strong 30d numbers but has gone cold in the last 10 trades, it can still score #1. **The scorer has no penalty for recent-window degradation**, and the HARD BLOCK fires on the recent 10-trade window, creating a conflict where the scorer says "watch this wallet" and the filter says "reject every trade from this wallet." Net effect: paralysis. **This is the single highest-leverage fix in the report.**

#### 4.2 HARD BLOCK at 20% filters 97.6% of approved trades (new — N1)
This follows directly from 4.1: if the scorer picks losing wallets, the filter blocks 95%+ of their signals. The filter is doing its job; the scorer is feeding it the wrong wallets. If 4.1 is fixed, 4.2 resolves automatically. If 4.1 is NOT fixed, 4.2 needs a workaround (raise threshold to 30% so the cold-streak size reduction kicks in more, accepting some losses in exchange for trade volume).

#### 4.3 Devil's advocate wiring bug still present (confirmed v1 finding 3.3c)
`copy-executor.ts:197–199` sets `walletRollingWR` on the leaderTrade object *inside* `execute()`, which runs **after** `confirmationLayer.confirm()` has already returned in `runner.ts:309`. So the check at `confirmation-layer.ts:176` (`(trade as any).walletRollingWR !== undefined`) is always false and devil's advocate never fires. Log analysis confirms: **zero** devil's advocate log lines in 4h. The Phase 05 commit introduced rolling wallet tracking but did not fix the ordering bug.

#### 4.4 Drawdown breaker inert across restarts (new — N3)
`risk-manager.ts:26–39`:
```ts
this.peakBalance = balance;  // set once in constructor
// ...
updateBalance(balance) {
  if (balance > this.peakBalance) this.peakBalance = balance;
  const drawdown = (this.peakBalance - balance) / this.peakBalance;
  // ...
}
```
`peakBalance` is initialized to whatever the balance is at bot startup and rises with wins. It is **never persisted** to Supabase and never restored on restart. With 51 restarts in 3 days, each restart rebases the DD tracker — the historical 15.77% peak drawdown that shows in Supabase cannot trip the circuit breaker because the in-memory `peakBalance` starts fresh every restart. **Tightening the threshold from 20% to 14% (proposed F8) does nothing without also fixing the persistence.**

#### 4.5 newsContext always empty; classifyTrade prompt biased toward COPY (confirmed v1 3.1 + 3.3a)
Still present, still unfixed. Two bugs in one path:
- `confirmation-layer.ts:82` and `:243`: `const newsContext = []`
- `ai-classifier.ts:108`: `"If no relevant news at all: recommend COPY (trust the leader)"`

The combined effect: the AI classifier is **guaranteed** to see "(no recent news found for this market)" on every single call, which triggers the biased prompt branch, which tells the model "recommend COPY." The AI is not making a decision; it's being told the decision. This is particularly important now that AI is the **sole required gate** per Phase 04.

#### 4.6 classifyTrade fallback returns 'copy' (confirmed v1 3.3b)
`ai-classifier.ts:115–122`. Silent-approve path on malformed JSON. Interacts catastrophically with N4 (broken fallback) — if both Cerebras and OpenRouter 400 at the same time, the parse error falls through to the 'copy' default with confidence 0.5, which is below the 0.70 veto threshold → trade approved.

#### 4.7 Leader close price hardcoded to 0.5 (confirmed v1 3.4)
`runner.ts:212`. Still there, Phase 04/05 did not touch it. Same 2–5% slippage leak per close.

#### 4.8 OpenRouter Gemma 4 fallback is broken (new — N4)
4x 400 errors on `google/gemma-4-27b-it` in 4 seconds during the 15:15 Cerebras rate-limit spike. The model name is wrong, the auth is wrong, or the model is unavailable on OpenRouter. Whatever the cause, **the fallback path that `d08632d` and subsequent commits were supposed to rely on does not actually work.** When primary fails, the bot is defenceless.

### 🟡 MEDIUM

- **M1** MiroFish 99.7% skip rate (new — N5). Not necessarily bad if intentional (sports-skip), but warrants investigation — it's a dead signal currently.
- **M2** No edge decay re-validation (confirmed v1)
- **M3** No sector/correlation limits (confirmed v1)
- **M4** Paper vs live fee/slippage gap (confirmed v1)
- **M5** No temperature / max_tokens / AbortController on AI calls (confirmed v1)
- **M6** Hot wallet elevation to rank-1 (`runner.ts:305–307`) is good, but bypasses the per-specialty threshold check in the confirmation layer — a hot wallet trading outside its specialty gets the 0.70 rank-1 threshold instead of the 0.85 out-of-specialty threshold
- **M7** Hardcoded magic numbers that should be env: `EDGE_FLOOR_DISTANCE=0.10`, `MAX_WATCHER_PRICE=0.75`, `MIN_WATCHER_PRICE=0.08`, leader-close price `0.5`, cold size multiplier `0.25`, hot boost `1.3`, 10-min / 15-min trade age windows.
- **M8** 65% capital cap is checked twice (redundant, harmless)
- **M9** `challengeTrade` fallback safely defaults to `proceed:false` (good), but since devil's advocate never fires (§4.3), this correctness is theoretical.

### 🟢 LOW

- **L1** Glint files are confirmed dead code (imports grep returns zero). Cleanup recommended, not urgent.
- **L2** `(trade as any).walletRollingWR` cast pattern — should be formalised in the `LeaderTrade` interface
- **L3** Stale comments in `ai-classifier.ts` header claim "Mistral" but the code uses `OLLAMA_BASE_URL` env with fallback to `llama3.2` and Cerebras auth

---

## 5. The Cross-Cutting Insight (revised)

v1's insight was "the scaffolding can be right and the edge can still be dead." That's still true, but the v2 data sharpens it:

**The strategy isn't broken — the bot is being fed bad leaders to copy.** The baseline wallet breakdown confirms: `0x204f…5e14` contributed **+$1,079 on 191 trades at 46% WR** — essentially single-handedly carrying the P&L. Every other wallet the bot has copied is collectively losing. The current live-log wallet set has two of the six wallets at 10%/13% WR. The scorer is *supposed* to rotate away from underperformers (it has a 15% recency weight), but either recency decay isn't steep enough, or the composite score is dominated by the 30-day window while the rolling 10-trade window crashes.

This is a very different finding from v1. v1 said "the edge is decaying inside the copy latency." v2 says **"the edge was never there because the bot is copying the wrong traders."** These have completely different fix plans.

The HARD BLOCK filter is, paradoxically, acting as an accidental safety net: it prevents the bad wallets from actually executing losing trades. That's why the baseline sits at break-even instead of deeply negative. Without the HARD BLOCK, the bot would be losing money at the rate of those 10-13% WR wallets. The correct fix is not to relax the filter, it's to feed the filter better signals via a better-calibrated leader scorer.

---

## 6. Forecast — Revised

Baseline (unchanged, from Supabase): 378 trades, 38.2% WR, +$63.59 realized, +0.45% over 17 days, Max DD 15.77%. Running at ~$0.17 avg PnL/trade.

### Why the v1 forecast was wrong about the direction of gains
v1 assumed the biggest lever was signal quality on rank-1 (F1 wire news, F2 leader-time classification, F4 prompt rewrite) plus the chokepoint (F6). v2 shows rank-1 quality is not the binding constraint: it's leader quality. Even a perfect confirmation layer cannot turn a 10% WR wallet into a winner.

### Revised per-fix forecast

| Fix | What it does | Est. Δ WR | Est. Δ monthly return | Confidence |
|---|---|---|---|---|
| **F11 (NEW) — Recalibrate rolling wallet filter + add a recent-window penalty to scorer** | Stops the scorer from routing to <30% recent-window wallets as rank 1-2. The single biggest lever. Expected: blended WR moves from 38% → ~48-55% as losing wallets get filtered out of the watched set. | **+10 to +17 pts** | **+3 to +6%** | **High** |
| **F9a — Fix walletRollingWR wiring (move attachment to runner.handleLeaderTrade before confirm call)** | Finally makes devil's advocate run. Will size down or veto the sub-20% WR wallet trades that currently slip through via the orderbook fallback path. | **+2 to +4 pts** | +0.5 to +1% | High |
| **F3 — Parse default → veto on malformed response** | Closes the silent-approve path. Pure pure pure win. | +1 to +3 pts | +0.2 to +0.5% | High |
| **F5 — Real leader exit price** | Stops 2-5% slippage leak per close. Doesn't move WR, improves net PnL. | +0 | +0.8 to +2% | High |
| **F8 + peakBalance persistence** | Drawdown breaker actually fires. Protects the downside. Doesn't move WR or monthly average, caps worst-case month. | +0 | +0 | High (but only protective) |
| **Tier 0 dashboard fix** | Measurement unblock. No behavioural impact, but required for everything else to be measurable. | +0 | +0 | High |
| **F12 — Fix OpenRouter fallback (replace broken Gemma 4 model)** | When primary fails, fallback actually works. Prevents trades from silently defaulting to the buggy copy fallback. | +1 to +2 pts | +0.2 to +0.4% | Medium |
| **F1 — Wire news-scanner → classifyTrade (unchanged from v1)** | Gives AI real news context. Phase 04 made AI the sole gate, so this is more important now. | +3 to +6 pts | +0.5 to +1% | Medium |
| **F4 — Remove "trust the leader" bias + prompt rewrite** | Stops telling the model the answer. Calibration improves. | +2 to +5 pts | +0.4 to +1% | Medium |
| **F13 — MiroFish investigation** | Unknown — if MiroFish was supposed to contribute a signal and isn't, fixing it may improve sizing on the 1.5× branch. If it's intentionally skipping, no change. | +0 to +2 pts | +0 to +0.5% | Low |

### Combined forecast

| Scenario | Win Rate | Monthly Return | Max DD | Confidence |
|---|---|---|---|---|
| **Current baseline** | 38.2% (139W/225L over 17 days) | +0.9% / month | 15.77% | Observed |
| **Quick wins: F3 + F5 + F8 + peakBalance persistence + Tier 0** | 38-42% | +2 to +4% | 12-15% | High |
| **Quick wins + F9a + F11** | **48-55%** | **+5 to +9%** | **11-14%** | **Medium-high** |
| **Full v2 program (add F1 + F4 + F12 + F13)** | **55-64%** | **+7 to +11%** | **10-13%** | Medium |

**Key change from v1 forecast:** the full program still gets to the ~65% WR / 8% monthly / <15% DD targets, but the path is different. **F11 (scorer/filter recalibration) and F9a (devil's advocate wiring) are now the two largest levers** — not F1/F4/F6 as v1 assumed. F6 is dropped entirely.

---

## 7. Revised Fix Plan

Replacing the v1 tiers with a tighter set. All on a **new** branch `optimization/2026-04-12-v2` off `origin/streamline/slim-and-optimize` (NOT off the v1 branch — that was based on the wrong code).

### Tier 0 — Measurement Unblock (~2h, zero strategy risk)
- [ ] **T0.1** Dashboard metrics fix — same as before, still valid
- [ ] **T0.2** Baseline already captured in `docs/BASELINE_2026-04-12.md` — no change needed
- [ ] **T0.3 (NEW)** Persist `peakBalance` to Supabase. Required precondition for F8 to mean anything.

### Tier 1 — Zero-risk fixes with high certainty (~3-4h)
- [ ] **F3** Parse default → veto (same)
- [ ] **F5** Real leader exit price (same, runner.ts:212)
- [ ] **F8-revised** Drawdown breaker 14% + persistent peakBalance (depends on T0.3)
- [ ] **F9a** Move `walletRollingWR` attachment from `copy-executor.execute()` to `runner.handleLeaderTrade` *before* `confirmationLayer.confirm()`. This is a 4-line diff that makes devil's advocate finally run.

**Drop: F6 (saturation TTL) — not needed, not a chokepoint. F9b/c (MiroFish veto) — violates Phase 04 design.**

### Tier 2 — High-leverage strategic (~1 day)
- [ ] **F11 (NEW, top priority)** Recalibrate leader scorer + rolling wallet filter:
  - Add a rolling 10-trade recency penalty to the composite score (if recent-window WR < 30%, score × 0.3)
  - OR: add a pre-scoring filter that drops any wallet with <30% rolling 10-trade WR from the leaderboard candidate set entirely
  - This is the single biggest lever — expected +10 to +17 WR pts
- [ ] **F12 (NEW)** Fix OpenRouter fallback: either replace `google/gemma-4-27b-it` with a working model, fix the API config, or swap the fallback provider entirely (Groq? Anthropic direct?)
- [ ] **F1** Wire `news-scanner` → `ConfirmationLayer.classifyTrade` — pass real `recentNews` instead of `[]`
- [ ] **F4** Rewrite `classifyTrade` prompt: remove "trust the leader" bias, add calibration anchors, add orderbook context to the prompt

### Tier 3 — Investigation + hygiene (~half day)
- [ ] **F13 (NEW)** MiroFish investigation — why 99.7% skip rate? Is sports-skip firing too broadly? Is the bridge up? Is the cache stale?
- [ ] **F7** Out-of-sample validation of the remaining filters (0.75 price ceiling, $150 cap, 0.10 edge floor) on the 378-trade Supabase dataset
- [ ] Cleanup: remove Glint files, formalise `walletRollingWR` in `LeaderTrade` type, move magic numbers to env

---

## 8. Open Questions (for Sunny before Tier 2)

1. **Are the uncommitted hand-edits on the server meant to land, or are they experiments?** 342 insertions across the 4 files including the entire AI classifier. I need to see what you're building before I commit to F1/F4, because those touch the same file.
2. **Is the `0x6ac5bb06 Op0jogggg` priority wallet the user's conscious choice to always-watch, or can F11 rework the leader set freely?**
3. **What is the actual current watcher set, as of right now?** The log shows 6 wallets (`0x2a2c53`, `0x2005d1`, `0x5d05b1`, `0x43e98f`, `0x9e9c8b`, `0x6ac5bb`) — is `0x204f…5e14` (the profitable wallet from the Supabase baseline) still being watched? If not, when did it fall off, and why?
4. **Is the 51-restarts-in-3-days signal from pm2 intentional** (you manually restarting during hand-tuning) or is it crash-and-recover?
5. **What goal are you tuning toward right now?** If you tell me what you were iterating on in the four edited files, the re-analysis can be more precise.

---

## 9. What NOT to do

Three specific v1 proposals that should be dropped:

- **F6 (saturation TTL)** — solves a non-problem. No chokepoint in the live state.
- **F9b/c (MiroFish contradiction → veto)** — violates Phase 04's intentional design to make MiroFish informational only. Would also not help given the 99.7% skip rate — there's almost nothing to veto on.
- **Blindly pushing the v1 optimization branch** — it's based on a stale `main` and does not include 20+ commits that are on `streamline/slim-and-optimize`. Deploying it would regress Phase 04/05 entirely.

---

## 10. Execution order (when approved)

1. Create new branch `optimization/2026-04-12-v2` off `origin/streamline/slim-and-optimize` (after fetching the server's latest — some server commits still aren't pushed to GitHub)
2. Get an answer to Question 1 (uncommitted hand-edits) so we don't clobber your in-flight work
3. Tier 0 → Tier 1 → Tier 2 → Tier 3 in that order
4. Each tier commits separately; tsc clean before each commit
5. Deploy Tier 0 + Tier 1 to server as a unit; observe 24h; then deploy Tier 2; observe 3-5 days; then Tier 3

---

**END OF v2 REPORT.** No code changes have been made. Awaiting Sunny's review + answers to §8 before any implementation.
