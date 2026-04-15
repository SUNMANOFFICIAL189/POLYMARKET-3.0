# PATS-Copy Hybrid Strategy — Architecture Plan
**Branch:** `strategy/hybrid-v1`
**Based on:** `optimization/2026-04-12-v2` (copy-trading fallback with all fixes)
**Date:** 2026-04-15

---

## Why the pivot

The copy-trading strategy cannot reach the stated targets (65% WR, 8% monthly, <15% DD). After 419 trades over 3 weeks:
- WR: 34.5% (below 35.7% breakeven)
- Avg PnL/trade: -$0.60 (negative expectancy)
- Every copied wallet degrades to 0-20% WR within 6 trades
- 70% of volume is sports markets where the AI has zero information advantage
- Copy latency (10-60s) erodes the leader's edge on thin markets

The infrastructure is solid. The strategy is not. This plan pivots the strategy while reusing the platform.

---

## Three-phase hybrid approach

### Phase 1: Category Filter (immediate — stops the bleeding)

**What**: Hard-filter sports markets from the execution pipeline. Only allow trades on markets categorized as: `politics`, `crypto`, `finance`, `other` (macro/tech/world events). Sports markets get an automatic SKIP/veto at the executor level.

**Why**: The AI + news pipeline has genuine information advantage on political, crypto, and macro markets (NPR, AP, BBC, CoinDesk cover these). It has ZERO advantage on sports. Removing sports removes 70% of blind bets.

**Expected impact**: Trade volume drops ~70%. Remaining trades have AI-assessable information. WR should improve from 34% to 42-50% on the filtered set.

**Implementation**:
- `copy-executor.ts`: add category filter before sizing. If `categoriseMarket(trade.marketQuestion) === 'sports'` → block.
- Configurable via `ALLOW_SPORTS=true` env var to re-enable if needed.
- Log line: `CopyExecutor: SPORTS FILTER — "${market}" skipped (category: sports)`

**Files**: `src/execution/copy-executor.ts` (5 lines)

---

### Phase 2: Signal-Based Original Trading (the core pivot)

**What**: The bot identifies its OWN trading opportunities from the news + market data pipeline, instead of copying leaders. When news breaks that has clear directional implications for a Polymarket market, the bot enters a position based on its own analysis.

**Architecture**:

```
NewsScanner (existing) → emits news items
    ↓
SignalGenerator (NEW) — matches news to open Polymarket markets
    ↓
    For each matched market:
        AI classifier evaluates: is this news actionable?
        → confidence > 0.80 + direction clear → SIGNAL
    ↓
SignalExecutor (NEW) — enters position at market price
    Uses existing: PaperTradingEngine, RiskManager, PositionLifecycleManager
    Sizing: fixed fractional ($20-50 per trade, based on confidence)
    Exit: market resolution, 24h TTL, or 20% stop-loss
```

**Key components to BUILD**:

1. **`src/signals/signal-generator.ts`** — NEW module
   - Subscribes to NewsScanner events
   - Maintains a cache of active Polymarket markets (fetched from Gamma API)
   - On each news item, fuzzy-matches against active markets
   - If match found, calls AI classifier with the news + market context
   - Emits `{market, side, confidence, reasoning, newsItem}` signals

2. **`src/execution/signal-executor.ts`** — NEW module (or extend CopyExecutor)
   - Receives signals from SignalGenerator
   - Applies risk checks (existing RiskManager)
   - Sizes based on confidence (0.80-0.90 = $20, 0.90-0.95 = $35, 0.95+ = $50)
   - Enters via PaperTradingEngine (paper) or CLI (live)
   - Manages positions via existing PositionLifecycleManager

3. **`src/signals/market-cache.ts`** — NEW module
   - Polls Gamma API every 5 min for active markets
   - Categories: politics, crypto, finance, macro, tech
   - Excludes sports, resolved, and closed markets
   - Provides fuzzy-match search for SignalGenerator

4. **AI prompt for signal assessment** — NEW prompt in ai-classifier.ts
   - Different from copy-confirmation prompt
   - Input: news headline + market question + current market price
   - Output: `{action: 'buy'|'sell'|'skip', confidence: 0-1, reasoning: string}`
   - No "trust the leader" bias — pure news-to-market assessment

**What we REUSE** (unchanged):
- NewsScanner (already running, feeding 100+ items/day)
- PaperTradingEngine (handles paper execution + PnL)
- RiskManager (drawdown breaker, daily loss limit, position sizing)
- PositionLifecycleManager (resolution, TTL, stop-loss)
- Supabase persistence (copy_trades table works for signal-trades too)
- Dashboard (displays trades regardless of source)
- Telegram alerts (already wired)

**Expected impact**: 5-15 high-conviction trades per week (vs 17 in 3 days of blind copies). Higher WR (48-55%) because every trade has AI-assessed news backing. Lower volume compensated by higher conviction sizing.

**Files**: 3 new files (~300 lines each), modifications to runner.ts + ai-classifier.ts

---

### Phase 3: Contrarian Paper Test (parallel, low-effort)

**What**: Run a shadow contrarian signal alongside the main strategy. When the copy-trading system says BUY, the contrarian paper-tests SELL (and vice versa). Track the contrarian's hypothetical WR without executing real trades.

**Why**: If the copy-trading system is consistently wrong (34.5% WR), the inverse should be consistently right (~65%). If this holds over 50+ paper trades, we can add contrarian as a real signal source.

**Implementation**: Lightweight — log-only, no execution.
- When `CopyExecutor` approves a trade, also log: `CONTRARIAN PAPER: would SELL ${outcome} @ ${price}`
- When the trade closes, compute contrarian PnL and log it
- After 50 trades, aggregate contrarian WR and PnL

**Files**: `src/execution/copy-executor.ts` (10 lines of logging)

---

## Execution order

1. **Phase 1 (today)**: Category filter — 5 lines, deploy immediately. Stops the sports bleeding.
2. **Phase 2 (this session + next)**: Signal generator + market cache + executor. This is the real pivot. ~3-5 hours of focused work.
3. **Phase 3 (parallel)**: Contrarian logging — 10 lines, can deploy alongside Phase 1.

## How the modes coexist

The runner operates both modes simultaneously:
- **Copy mode**: watches leaderboard, copies non-sports trades (existing pipeline + category filter)
- **Signal mode**: watches news, generates original signals on AI-assessable markets
- **Contrarian mode**: paper-tracks inverted copy signals (log only)

Each mode produces trades tagged with their source (`copy`, `signal`, `contrarian-paper`). The dashboard can filter by source. WR and PnL are tracked per-source in the STATUS log.

## Success criteria

| Metric | Target | Timeframe |
|---|---|---|
| Signal-mode WR | >50% | First 20 trades |
| Signal-mode avg PnL/trade | >$0 | First 20 trades |
| Copy-mode WR (filtered) | >42% | 30 days |
| Combined monthly return | >5% | 30 days |
| Max drawdown | <12% | Ongoing |
| Contrarian paper WR | >55% over 50 trades | 2 weeks |

---

**This plan does NOT merge into the copy-trading branch.** The `optimization/2026-04-12-v2` branch remains the fallback (with Fix A + Fix B deployed). The `strategy/hybrid-v1` branch is a separate evolution. If hybrid fails, rollback to v2 copy-trading.
