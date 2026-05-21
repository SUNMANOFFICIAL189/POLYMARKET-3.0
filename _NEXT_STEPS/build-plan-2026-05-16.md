# PATS-Copy Master Build Plan — 2026-05-16

**Owner:** Sunil
**Date locked:** 2026-05-16
**Status:** Pre-Phase-0. About to ship categoriser removal.
**Recovery context:** This document captures the full state and forward plan so any new session can resume without losing context.

---

## 1. CURRENT BOT STATE (verified 2026-05-16)

| Metric | Value |
|---|---|
| Balance | $5,128.17 |
| Initial bot capital | $6,300 |
| Total return | -18.60% (improved from -21.69% pre-restart) |
| Cumulative realized P&L | -$812 |
| Bot uptime | ~33h since restart 120 (2026-05-14 16:02 UTC) |
| Soak start | 2026-05-12 07:22 UTC |
| HEAD | `b3e8205` (fix(option-d): per-pipeline maxPositionPct + visible geo rejection logs) |
| Branch | strategy/buy-optimization |
| Tags | `pipeline-isolation-fix-2026-05-12`, `pre-pipeline-isolation-fix-2026-05-12-rollback` |

### Pipeline state

| Pipeline | Status | Capital | Open | Closed in soak | Realized P&L | WR |
|---|---|---|---|---|---|---|
| Signal | ACTIVE | $6,300 (shares bot capital) | 2 | 8 | **+$154.88** | **87.5%** |
| Geopolitics | ACTIVE | $1,500 | 3 (phantom in memory; 0 in Supabase) | 9 | -$85.13 | 0% |
| Copy | DISABLED | $0 | 0 | 0 | n/a | n/a |

### Watchlist (Tier-1, current)

| Wallet | Soak realized P&L (leader-side) | Status |
|---|---|---|
| balthazar (`0x5a218c7a…`) | $0 realized (positions still open) | KEEP — long-hold edge |
| Car (`0x7c3db723…`) | **-$145.57** (8 closed, 0 wins) | UNDER REVIEW |
| MRF (`0x16cbe223…`) | $0 realized (lottery positions open) | KEEP for variance exposure |
| unknown-near-miss (`0x44c1dfe4…`) | **-$15,645 realized** | DEMOTE CANDIDATE |

---

## 2. VERIFIED FINDINGS FROM 2026-05-12 → 2026-05-16 SESSIONS

All numbers below are from code-pulled data, not prose estimates.

### Signal pipeline
- **Lifetime (29 days, 292 trades):** -$394.92 total = **-$13.63/day average**
- **Last 4 days (8 trades, 7W/1L):** +$154.88 = +$38.72/day
- **Z-score of recent vs lifetime:** +0.98σ — NOT statistically significant
- **Recent wins:** all SELL-Yes on BTC daily price markets or Trump China visit markets (two clusters only)
- **Catastrophic day on record:** 2026-05-07 = -$1,000.90 (the -$943 BTC trade)
- **Verdict:** Strategy C edge MAY exist but not yet statistically proven. 4-day window is a hot streak, not a baseline.

### Geopolitics pipeline
- 9 closed trades, 0 wins, -$85.13 realized
- Categoriser bug: politics-only filter rejects 95%+ of balthazar's main book (Peruvian elections)
- Hypothetical $75 mirror without categoriser, RESOLVED-only: **+$2,119.54** (10 trades, 1 win dominating: +$2,324)
- All 4 specialists have realized ZERO or NEGATIVE in soak window
- balthazar's edge requires long holding times (weeks-months); our 4-day soak window can't capture it

### Strategy C scanner (HYPOTHESIS — not verified)
- 25 candidate markets active in any moment matching criteria
- Signal pipeline catches ~2/day; scanner could catch ~5-10/day
- Profitability NOT verified — would need historical price data per market

### Consensus trades (3 in 4 days)
- 100% WR but n=3 is statistically meaningless
- Dominated by one trade ($346 on "Trump says Iran" with 3-of-4 specialist agreement)
- Suggestive but insufficient evidence

### Resolved-but-unsettled yield
- Verified $0.25 per $500 deployed
- At $1,500 pool: ~$50-100/year. **Not worth building.**

---

## 3. KNOWN BUGS

| Bug | Status | Impact |
|---|---|---|
| Phantom-position tracking in `geopoliticsExecutor.openTrades` | OPEN | Lifecycle manager closes positions in paperEngine + Supabase but doesn't notify executor's in-memory Map. Causes incorrect drawdown breaker triggering. **MUST fix during Phase 0.** |
| Categoriser blocks 95% of balthazar's edge markets | OPEN | About to be fixed in Phase 0 |
| Bot's `executed=N open=M` counters can desync from Supabase | OPEN | Symptom of the phantom bug; same fix |

---

## 4. CTDD LESSONS LEARNED (DO NOT FORGET)

These are mistakes made during this session. Future sessions must guard against them:

1. **Don't quote per-day rates without showing lifetime + recent + variance.** I quoted "$40-50/day" based on 4 days. Lifetime is -$13.63/day. The user caught it. Don't repeat.
2. **Always distinguish realized from unrealized P&L.** The "+$10K hypothetical no-categoriser" was mostly unrealized lottery longshots. Resolved-only was +$2,120.
3. **Apply statistical significance tests on small samples.** Z-score <2σ = noise. Don't extrapolate from <30 trades.
4. **Lead with caveats, not bury them.** When prose flows toward a recommendation, numbers in that prose are most likely overstated.
5. **Casual rounding ($38.72 → "$40-50") is a flag.** Be precise.
6. **Audit cross-cut constants when changing architecture.** The 2% maxPositionPct broke geopolitics when we moved to per-pipeline RM. Every config constant must be re-evaluated when context changes.
7. **Use code to verify before claiming.** Pull data; run a script. Prose without a script is a hypothesis.

---

## 5. BUILD PHASES — APPROVED PLAN

### Phase 0: Foundation fixes (Days 0-3)

| Sub-deploy | Task | Hours | Files | Status (2026-05-17) |
|---|---|---|---|---|
| 0.1 | Remove categoriser block | 0.25 | `src/execution/geopolitics-executor.ts` | ✅ SHIPPED — HEAD `d56a1b5`, verified with Cuba trade |
| 0.2 | Add consensus sizing tiers | 3-4 | `src/execution/geopolitics-executor.ts` + buffer + `src/types/index.ts` maxPositionPct→0.15 | ✅ SHIPPED — HEAD `007e755`, verified with "solo → $50" log |
| 0.3 | Fix phantom-position bug | 1-2 | `src/execution/geopolitics-executor.ts` (sweepPhantoms + closePosition stale-cleanup), `src/core/runner.ts` (wire into logStatus) | ✅ SHIPPED — HEAD `206a3f6`, verification watcher armed |
| 0.4 | Build Strategy C scanner pipeline | 6-10 | New `src/signals/strategy-c-scanner.ts` + `src/signals/market-cache.ts` getAllMarkets + `src/core/runner.ts` wiring | ✅ SHIPPED — HEAD `7bcc135`, verification watcher armed for first scan output |

**Consensus sizing tiers (locked):**
- 4-of-4 agreement: $200 (requires maxPositionPct bump)
- 3-of-4 agreement: $150
- 2-of-4 agreement: $100
- Solo trade: $50
- Disagreement (2+ on opposite sides): REJECT

**Consensus time window:** 48h rolling buffer + "position-still-open" check as secondary filter.

### Phase 1: Wallet auto-rotation (Days 4-5)

Build a defensive infrastructure layer that prevents wallet quality decay from silently eroding returns.

- Pull top 100-200 Polymarket wallets weekly
- Compute 30-day **REALIZED** P&L (not lifetime, not unrealized)
- Track each Tier-1 wallet's rolling 30-day realized P&L
- Alert on demotion candidate (Tier-1 wallet drops below -$5,000 realized 30d)
- Alert on promotion candidate (new wallet >$5,000 realized 30d with 30+ resolved trades)
- Human approves all watchlist changes

**Screening criteria (lessons baked in):**
1. 30-day realized P&L >$2,000
2. Resolved trade count last 30d >20
3. Median position size $30-$300 (matches our flat sizing)
4. Active in last 7 days
5. Not on demotion cooldown (30 days)

**Cadence:** Weekly (Mondays UTC) Telegram alert.
**Build time:** 4-6 hours.

### Phase 1.4: Car-only experiment + breaker observability (2026-05-21)

**Trigger:** Soak-week-9 audit (2026-05-21) found the geopolitics drawdown circuit breaker silently blocked ~100+ of Car's valid BUY signals for 3 days straight, after early balthazar losses tripped it. Car was in TIER_1 the whole time but produced 0 executed trades.

**Diagnosis (in plain English):**

1. Balthazar = portfolio-longtail trader. Our bot is a single-trade copier. Mismatch → his trades lost ~$144 net in the early soak window.
2. Geopolitics pipeline 14% drawdown breaker tripped at ~15% DD.
3. **Once tripped, the breaker blocked all subsequent trades — including Car's good ones — because no winners could come through to recover the pool.** Catch-22.
4. Nothing was watching the breaker — no TG alert, no daily summary. 3 days of silent rejection went undetected.

**Four changes (shipped together):**

- **A — Watchlist edit (`src/geopolitics/watchlist.ts`):** Demoted balthazar, MRF, and unknown-near-miss to TIER_2. Car is the sole TIER_1. Audit-trail comment explains each demotion.
- **B — peakBalance reset env flag:** `GEOPOLITICS_RESET_PEAK_ON_BOOT=true` resets the geopolitics RiskManager's peakBalance to current poolBalance at next boot, re-arming the breaker. Idempotent — log-and-ignore on subsequent restarts.
- **C — Breaker state TG alerts:** RiskManager exposes `onBreakerStateChange` callback. Runner fires TG alert on TRIP (state→tripped), RELEASE (state→armed), and 24h-interval STILL-TRIPPED summaries (with running blocked-trade counter).
- **D — `scripts/wallet-watch.py` observer:** Standalone Python script that pulls /positions + /trades for every wallet in watchlist.ts and snapshots to `logs/wallet-snapshots/`. `compare` subcommand diffs two snapshots for the Day 7 rotation decision. Runs entirely outside the bot. Day 0 snapshot taken at deploy time.

**The experiment we're actually running:** Does single-trade copy work when applied to an info-edge trader (Car) with no portfolio-trader contamination?

**Test window:** 7 days post-deploy (~2026-05-28).

**Day 7 verdict matrix:**

| Outcome | Action |
|---|---|
| Car net positive (≥ +$50 over 7 days) | Confirm experiment ✓. Build SELL-side mirroring (Phase 1.5). Consider re-promoting selected Tier-2 wallets with archetype filters. |
| Car net flat (-$50 to +$50) | Extend test 7 more days. Sample noise. |
| Car net negative (<-$50) | Single-trade copy is wrong even with the right archetype. Either commit to basket-replication build or kill geopolitics-copy pipeline. |
| Breaker re-trips on Car alone | Run wallet-watch compare to see if any Tier-2 wallet outperformed. If yes, rotate. If no, single-trade copy is the dead end. |

**Rollback:** `git revert <phase-1.4-commit>` OR `git reset --hard pre-phase-1.4-deploy-2026-05-21`. Fully reversible — no schema changes, no destructive data ops.

**Lesson baked into the spec (observability):** The most valuable change here is **C** — TG alerts on breaker state changes. Silent rejection of every trade for 3 days hidden behind only a "info"-level log line is the real systemic bug. C ships permanently regardless of the experiment outcome.

### Phase 2: 30-day verified soak (Days 6-35)

- Let everything run
- Daily verified status checks using audit scripts
- Watch: consensus trade count + WR, scanner trade count + WR, wallet rotation alerts
- At Day 14: midpoint review
- At Day 30: full verified-data verdict

**Success criteria for "proceed to Phase 3":**
- Strategy C scanner: WR >=55% over 30+ trades AND positive realized P&L
- Geopolitics post-categoriser: any positive realized P&L
- Signal pipeline: WR >=60% sustained

### Phase 3 (REVISED): Capital scaling decision

**If Phase 2 strategies validate (real money, real returns):** scale capital cautiously from $5K → $15K → $25K. Linear scaling of returns.

**If Phase 2 strategies fail:** STOP. Do not throw more capital at unproven strategies. Pivot architecture.

### Phase 4: Sum-to-one arbitrage scanner (only if Phase 3 → $25K+ capital)

6-8 weeks of build. Documented edge exists ($40M extracted on Polymarket 2024-25 per Suarez-Tangil et al. 2025).

**Build at $5K capital = NOT worth it** (build cost > 1 year of returns).
**Build at $25K+ capital = worth it** (returns scale linearly, ROI positive in year 1).

### Phase 5: Calibration & learning layer (planned 2026-05-21, deferred)

**Status:** PLANNED, not yet started. User decision 2026-05-21 to defer until Phase 2 soak completes.

**Trigger to begin:** Phase 2 soak verdict at Day 30 (~2026-06-17). Build only if either (a) signal pipeline shows sustained edge worth scaling, OR (b) the soak shows our confidence values are uncalibrated and we need this layer to fix it.

**Source:** community-written "How to Build an AI-Powered Prediction Market Trading Bot Using Claude Skills" guide, reviewed 2026-05-21. The guide claims Anthropic-architecture inspiration; treat headline metrics (68.4% WR backtest) as marketing-grade. The gaps it surfaces are legitimate even if its anecdotes aren't.

**Scope: Brier score tracking** (6-8h build)
- For every closed trade where we recorded a confidence value, compute `(predicted_probability - actual_outcome)²`
- Rolling 30-trade Brier score per pipeline
- Surface in WalletScreener's weekly TG report so calibration is visible
- A well-calibrated model tracks below 0.25
- Use case: tells us whether our AI confidence numbers are MEANINGFUL or noise. Currently a blind spot.

**Optional follow-ons (only if Brier shows acceptable calibration):**
- Kelly Criterion sizing (Quarter-Kelly default) as alternative to current flat/tier sizing — 4-6h
- Mispricing Score (Z-score) as trade-strength filter — 3-4h
- Automated failure post-mortem (classify each loss: bad prediction / bad timing / bad execution / external shock) — 8-10h

**Explicitly out-of-scope (decided 2026-05-21):**
- Ensemble multi-AI approach (Grok + GPT-4 + Claude + Gemini + DeepSeek vote) — economics don't work at $5K capital; $50/day quoted AI cost = $1500/month = 30% of capital
- Rebuild as Claude Skills markdown pattern — our TypeScript architecture is more production-grade
- The GitHub repos listed in the source guide — security warning from 2026-05-20 research applies (`dev-protocol` malware case)

### Phase 6: Cross-platform arbitrage (research complete 2026-05-20, gated on capital scaling)

See Decision Log 2026-05-20 for full research. Real but small opportunity ($300-800/mo at $10K, $700-1500/mo at $25K). Build cost 7-12 weeks. Hard kill-switch path: 2-week read-only Kalshi spread logger first; abandon if spreads don't theoretical-clear $300/mo at $10K. Sportsbooks PERMANENTLY EXCLUDED.

### Phase 7: Market making / CLOB liquidity provision (long-term)

12-15 weeks of build. Highest-ROI strategy at scale. Requires real-time CLOB client + inventory management. **6+ months out.**

---

## 6. HONEST RETURN EXPECTATIONS (RECALIBRATED)

| Scenario | $5K capital | $25K capital | $50K capital |
|---|---|---|---|
| Modal monthly | $200-800 | $1,000-4,000 | $2,000-8,000 |
| Best case monthly | $500-1,400 | $2,500-7,000 | $5,000-14,000 |
| With Path B added | +$300-900 | +$1,500-4,500 | +$3,000-9,000 |

**For $5K/month income target:** requires either (a) ~$50K capital + verified edge, OR (b) full Path B + Path A stack at $25K capital with 6+ months of build.

**Critical user-context note (well-being):** the user has stated their financial well-being depends on this. This bot is NOT a path to short-term financial security. Realistic timeline to $1K-3K/month: 9-18 months of patient development at modest capital. Future sessions must avoid creating false expectations.

---

## 7. ARCHITECTURAL STATE

```
PATS-Copy Bot (Hetzner: 204.168.204.247:/opt/polymarket-bot)
│
├── PaperTradingEngine ($6,300 nominal)
│   └── 'global' RiskManager (cash ledger only, no gating — Option D)
│
├── Pipeline: signal (active, tight rules)
│   ├── SignalGenerator (news → AI classifier)
│   │   └── pre-AI filter: skip if BUYs off AND endDate > 24h (Option 4 fix, 2026-05-12)
│   ├── SignalExecutor (RM gated, $6,300 pool)
│   └── TG alert: post-execution only (Option 1 fix, 2026-05-12)
│
├── Pipeline: copy (disabled)
│   └── CopyExecutor ($0 pool)
│
├── Pipeline: geopolitics (active, post-fix)
│   ├── WalletMonitor for 4 Tier-1 specialists
│   ├── GeopoliticsExecutor (RM gated, $1,500 pool)
│   │   ├── Politics-only filter (TO BE REMOVED in Phase 0)
│   │   ├── Price band 0.03-0.90, no coin-flip zone
│   │   ├── Per-pipeline drawdown breaker (14% of pool)
│   │   └── Per-trade max-loss cap (5% of pool)
│   └── 168h TTL floor
│
└── (NEW in Phase 0) Pipeline: strategy-c-scanner (build pending)
    ├── Gamma-api scanner (polls active markets every 60s)
    ├── Filter: price>=0.92, end<72h, liquidity>$500
    └── Wires into shared executor pattern
```

---

## 8. KEY FILES AND PATHS

| Path | Purpose |
|---|---|
| `/Users/sunil_rajput/Desktop/POLYMARKET_TRADING_3.0/` | Local repo |
| `root@204.168.204.247:/opt/polymarket-bot` | Production deployment |
| `src/execution/geopolitics-executor.ts` | Geopolitics filter chain (categoriser fix target) |
| `src/execution/signal-executor.ts` | Signal pipeline executor |
| `src/core/runner.ts` | Pipeline orchestration |
| `src/core/risk-manager.ts` | Per-pipeline RM (Option D, isolation fixed 2026-05-12) |
| `src/core/paper-trading.ts` | Paper trading engine |
| `src/geopolitics/watchlist.ts` | Tier-1 specialist wallets |
| `src/signals/market-categoriser.ts` | Soon-to-be-deprecated |
| `dashboard/src/app/page.tsx` | Dashboard (Phase 1 redesign pending) |
| `_NEXT_STEPS/strategy-audit-2026-05-12.md` | Earlier audit (superseded by this doc) |
| `_NEXT_STEPS/build-plan-2026-05-16.md` | **THIS DOCUMENT** |

---

## 9. RESUMPTION INSTRUCTIONS FOR NEW SESSIONS

To pick this up cleanly in a future session:

1. **Read this document fully.**
2. Read `/Users/sunil_rajput/Vaults/Jarvis-Brain/JARVIS-BRAIN/Projects/PATS-Copy/04 Decision Log.md` for decisions made.
3. Read `~/.claude/projects/-Users-sunil-rajput/memory/project_session_handoff_2026_05_16.md` for memory context.
4. Run a verified state check:
   ```bash
   ssh root@204.168.204.247 'pm2 list && pm2 logs polymarket-bot --lines 50 --nostream | grep STATUS | tail -3'
   ```
5. Pull current trade data from Supabase to verify against this document's snapshot.
6. Confirm with user which phase to resume.

---

## 10. NOTES TO FUTURE SELF / FUTURE SESSIONS

- Do NOT extrapolate per-day rates from 4-day windows.
- Do NOT bundle multiple risky fixes in one deploy.
- Do NOT recommend adding capital before strategies are verified profitable.
- Do NOT promise the user that this bot will transform their financial situation.
- DO check verified data before quoting any number.
- DO label "verified" vs "speculation" explicitly.
- DO maintain the wallet auto-rotation alerts once Phase 1 ships.
- DO check the phantom-position bug status — it recurs without proper fix.

**The CTDD doctrine for this project is: data first, prose second, recommendation third. Reverse this order and we ship overconfident garbage.**

---

## Phase 1 ship — 2026-05-17 (later)

**Phase 1 COMPLETE.** Wallet auto-rotation screener deployed.

| Component | Commit | Notes |
|---|---|---|
| WalletScreener (new file) | `52ffc21` | Polls `/biggest-winners` weekly, aggregates per-wallet realized P&L, flags demote/promote candidates |
| Runner integration | (same commit) | Construct + start + on('report') → Telegram alert handler |
| Pre-deploy rollback tag | `pre-phase1-deploy-2026-05-17` | One commit before Phase 1; reverts the screener if needed |
| Master kill switch | `WALLET_SCREENING_ENABLED=false` | In-place disable without redeploy |

**Cadence:** First report 5 min after bot start (deploy verification), then every 7 days.

**Behavior:** Read-only. Bot does NOT auto-modify watchlist. Reports advisory only. User reviews and manually edits `src/geopolitics/watchlist.ts` if a demote/promote recommendation is warranted.

**Phase 2 starts now** — 30-day verified soak with all Phase 0 + Phase 1 infrastructure live.

---

## Phase 1.1 ship — 2026-05-17 (calibration fix)

**Issue surfaced from first Phase 1 report:** All 4 Tier-1 wallets flagged DEMOTE because `/biggest-winners` only shows realized wins; balthazar's ~500 open Peru positions worth +$284K unrealized weren't visible to the screener.

**Fix:** commit `2fe241b`. For each Tier-1 wallet, ALSO pull `/positions` and compute open-book health. A wallet is HEALTHY if ANY of:
1. /biggest-winners totalWinPnl >= DEMOTE_THRESHOLD ($100)
2. open-book unrealized P&L >= UNREALIZED_HEALTH_THRESHOLD ($1000)
3. >= MIN_RECENT_POSITIONS open positions ($10 — activity proxy)

Demote only when all three signals are absent. Adds ~4 HTTP calls per weekly screen (one per Tier-1 wallet, in parallel). Negligible cost.

New env knobs: `WALLET_UNREALIZED_HEALTH_THRESHOLD`, `WALLET_MIN_RECENT_POSITIONS`, `WALLET_POSITIONS_FETCH_LIMIT`.

Expected outcome: balthazar (and likely MRF) should now show as HEALTHY via signal (b) or (c). Car is marginal. unknown-near-miss should still flag (she has -$15K realized in our soak + presumably weak open book).

**Verification:** watcher armed for next ~5min screen.
