# PATS-Copy — Build Guide

## Prompt for New Context Window

Paste this when starting:

> I'm building PATS-Copy, a Polymarket copy-trading system. Repo: `SUNMANOFFICIAL189/pats-copy`. Read these files for context:
> 1. `docs/PRD.md` — Product requirements
> 2. `docs/CONTEXT.md` — Lessons from predecessor (PATS-Poly)
> 3. `docs/BUILD_GUIDE.md` — Implementation plan
> 4. `src/carry-over/README.md` — Reusable module instructions
>
> Start Phase 1 (Backend MVP): T-001 scaffold, T-002 carry-over modules, T-003 leaderboard scraper.
>
> Rules:
> - Self-verify before returning control. Build then check it compiles.
> - Use `github:push_files` for multi-file commits.
> - Predecessor repo: `SUNMANOFFICIAL189/pats-poly` for reference files.
> - Local dir: `~/Desktop/PATS_COPY`
> - macOS — no `grep -P`, use `-oE`

---

## Phase 1: Backend MVP (Week 1)

### T-001: Scaffold Project
- package.json, tsconfig.json, .env.example
- Deps: @supabase/supabase-js, dotenv, puppeteer, winston, ws, zod
- Dev: @types/node, @types/ws, tsx, typescript
- Structure:
  ```
  src/
    core/       # Runner, risk manager, copy executor
    leaders/    # Leaderboard scraper, scorer, selector, wallet monitor
    signals/    # Glint, news scanner, AI classifier (confirmation)
    data/       # Supabase
    execution/  # Polymarket CLI wrapper
    types/      # TypeScript types
    utils/      # Logger
  ```

### T-002: Integrate Carry-Over Modules
- Fetch from pats-poly repo (see src/carry-over/README.md)
- Modify logger filename, extend types, extend Supabase

### T-003: Leaderboard Scraper
- Investigate: check polymarket.com/leaderboard for API calls
- Check for public GraphQL endpoint
- Fallback: Puppeteer scraping
- Extract: wallet, name, P&L, win rate, trade count, last active
- Poll every 5 minutes, store in leaders table

### T-004: Trader Scorer
- 40% win rate (30d) + 30% profit factor (14d) + 15% frequency + 15% recency
- Normalize each to 0-100

### T-005: Leader Selector
- Pick #1 by composite score
- Hysteresis: >5% margin for >1 hour before rotating
- Log rotations to leader_history

### T-006: Wallet Monitor
- Poll Data API: positions + trades for leader's address
- Detect new opens by diffing snapshots
- Cross-reference with Glint whale tracker for speed
- Emit leader-trade event

### T-007: Confirmation Layer
- Check Glint signals (2hr window) for market
- AI classifier for sentiment on market topic
- Approve/Veto/Skip decision with logged reason

### T-008: Copy Executor
- Paper mode: simulate with slippage
- Size: (leader_size / leader_portfolio) * our_portfolio
- Cap at risk limits, one per market

### T-009: Runner
- Orchestrate all modules, status log every 5 min

### T-010: Supabase Migration
- leaders, leader_history, copy_trades, daily_performance tables

### T-011: E2E Validation
- Paper mode, verify full pipeline

---

## Phase 2: Paper Validation (Weeks 2-3)
Run 14 days, analyze win rate, tune confirmation thresholds

## Phase 3: Live Execution (Week 4)
Fund wallet $1K, enable live mode

## Phase 4: Dashboard in Anti-Gravity (Weeks 5-6)
Next.js + Tailwind: leaderboard view, trade history, P&L charts, leader timeline
