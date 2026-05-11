# 2026-05-11 — Master Handoff

## State at handoff

- **Bot HEAD:** `82c9119` on `strategy/buy-optimization` (Option D landed)
- **pm2:** restart 113, online, no churn
- **Pipelines:** `signal: ON $6300/100%`, `copy: off $0`, `geopolitics: off $0`
- **Branch 2 listener:** connected, processing both matchOrders contracts
- **Watchdog:** ACTIVE mode (not soak), 30-min cadence
- **Insurance:** snapshot `pre-option-d-deploy-2026-05-11` + git tag `pre-option-d-deploy-2026-05-11` → `3a532b5`

## What landed this session

### 1. Option D deployed (per-pipeline RiskManagers + capital pools)
Full per-pipeline isolation: each pipeline (signal/copy/geopolitics) has its own `RiskManager` with isolated balance/peak/drawdown/dailyPnl/openTrades. Supabase `copy_trades.pipeline` column added + backfilled (signal=284, copy=436) + indexed. Per-pipeline capital via env vars (`SIGNAL_CAPITAL`, `COPY_CAPITAL`, `GEOPOLITICS_CAPITAL`). Default share preserves current behaviour exactly: signal gets 100%, copy/geopolitics scaffolded at $0. Hydration + 10-min health check clean.

### 2. Branch 3 backtest run — verdict MIXED
- 30-day window, 11 watched wallets, `MIRROR_SCALAR=0.02`, `GEOPOLITICS_CAPITAL=$1500`
- **Only 8 positions had Gamma MTM data** (34 of 42 markets returned empty — resolved/archived markets aren't queryable)
- **All 8 from one wallet: `0x5d05b1f5`** (the geopolitics specialist)
- 75% WR, leader PnL +$333.97 (all MTM, no realized)
- **Proportional sizing:** $160.46 PnL on $1,440.76 deployed = 11.14% ROI
- **Flat $75 sizing:** $187.39 PnL on $1,350.00 deployed = 13.88% ROI
- **Flat beat proportional** — formula effectively flat-caps high-conviction trades (max-loss-pct kicks in) and over-allocates on small leader trades

### 3. Research-first decision
User chose to research alternative geopolitics specialists before committing to Branch 3 build. Single-wallet concentration risk is the biggest weakness in the backtest result.

## What's deferred / blocked

- **Branch 3 build** — deferred pending 4-6h research sprint outcome
- **BUY re-enable** — user-deferred (still worth +$50-150/mo per historical analysis, not the big lever)
- **Phase 6 promotion attempt** — metric structurally invalid; no gate exists; listener stays on for data collection only

## Next session — research sprint (time-boxed 4-6h)

### Phase 1: Source candidates (1-2h)
- Polymarket leaderboard top 100 (30d, 90d, all-time)
- Cross-check current 11-wallet watch list for actual geopolitics activity in last 90d
- Optional: Dune queries if accessible

### Phase 2: Screening (1-2h)
- Hard filters:
  - ≥15 geopolitics-market trades in last 90d
  - WR ≥55% on those trades
  - Avg trade size $10–$500
  - Active in last 14 days
- Output: ranked shortlist of 5-10 candidates

### Phase 3: Backtest validation (1-2h)
- Re-run `scripts/backtest/branch3-geopolitics.ts` against shortlist
- Compare proportional vs flat sizing across larger sample
- Decision criteria:
  - Shortlist validates with diversified positive PnL → **BUILD** Branch 3 (diversified pool)
  - `0x5d05b1f5` is the only specialist → small-cap test ($200) or **KILL** Branch 3
  - Shortlist outperforms `0x5d05b1f5` → **SWAP** in stronger wallets

### Deliverables
- Updated `scripts/backtest/branch3-geopolitics.ts` with researched wallet list
- Research findings doc at `_NEXT_STEPS/branch-3-research-<date>.md`
- Decision Log entry with verdict
- BACKLOG entry resolved (mark Done with outcome)

## Files of note

- `scripts/backtest/branch3-geopolitics.ts` — the backtest harness (reusable)
- `~/Vaults/Jarvis-Brain/JARVIS-BRAIN/Projects/PATS-Copy/04 Decision Log.md` — 2026-05-11 entries
- `~/claude-hq/docs/BACKLOG.md` — "Branch 3 Geopolitics Specialist Research Sprint" entry
- `~/.claude/projects/-Users-sunil-rajput/memory/project_session_handoff_2026_05_11.md` — auto-memory handoff

## Recovery commands

```bash
cd ~/Desktop/POLYMARKET_TRADING_3.0
git branch --show-current   # strategy/buy-optimization
git log --oneline -3         # 82c9119 at HEAD

# Bot health
ssh root@204.168.204.247 'cd /opt/polymarket-bot && \
  pm2 jlist | python3 -c "import json,sys,time; d=json.load(sys.stdin); b=[p for p in d if p[\"name\"]==\"polymarket-bot\"][0]; pe=b[\"pm2_env\"]; print(f\"status={pe[\"status\"]} restarts={pe[\"restart_time\"]} uptime_s={(time.time()*1000-pe[\"pm_uptime\"])/1000:.0f}\")" && \
  cat .bot-status.json | python3 -m json.tool | head -30'
```
