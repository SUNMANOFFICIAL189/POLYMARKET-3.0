# Roadmap: PATS-Copy

## Overview

Autonomous Polymarket copy-trading system. Monitors the #1 leaderboard trader, copies trades proportionally, uses AI to veto bad signals. Paper mode for 14 days then live.

## Current Milestone

**v0.1 Paper Trading Validation** (v0.1.0)
Status: In progress
Phases: 1 of 3 complete

## Phases

| Phase | Name | Plans | Status | Completed |
|-------|------|-------|--------|-----------|
| 1 | Backend Build | 3 | ✅ Complete | 2026-03-17 |
| 2 | Stabilisation & Paper Validation | — | 🔄 In progress | — |
| 3 | Live Mode Activation | — | ⬜ Not started | — |

## Phase Details

### Phase 1 — Backend Build ✅
All core modules built and running:
- LeaderboardScraper, TraderScorer, LeaderSelector
- WalletMonitor, ConfirmationLayer, CopyExecutor
- GlintScraper, GlintAdapter, NewsScanner
- Supabase persistence layer
- Runner orchestrator

### Phase 2 — Stabilisation & Paper Validation 🔄
**Goal:** Run paper mode for 14 days with no crashes, clean trade flow, Supabase logging working.

Acceptance criteria:
- Bot runs for 14 days without manual intervention
- At least 10 copy trades executed (not just vetoed/skipped)
- Win rate tracked in Supabase daily_performance
- No "Trade too old" errors after fix deployment
- Glint reconnects slow down (backoff working)

Known blockers:
- Supabase schema migration must be run (docs/SUPABASE-SCHEMA.md)
- Desktop folder must stay in sync with GitHub fixes

### Phase 3 — Live Mode Activation ⬜
**Goal:** Switch to live trading after validation passes.

Trigger criteria:
- Phase 2 paper win rate >65%
- No drawdown >15% during paper period
- All Supabase logs clean
- Leader rotation tested at least once

Actions:
- Set PAPER_MODE=false
- Set RISK_LEVEL=conservative
- Monitor first 5 live trades manually

---
*Roadmap created: 2026-03-17*
