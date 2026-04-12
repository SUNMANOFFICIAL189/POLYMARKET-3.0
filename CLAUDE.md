# PATS-Copy — Project Context for Claude Code

## Auto-Activate HQ

On session start in this project, automatically load the Commander system:

1. Read `~/claude-hq/commander/COMMANDER.md` (orchestration brain)
2. Read `~/claude-hq/commander/LESSONS.md` (past mistakes)
3. Read `~/claude-hq/registry.json` (tool inventory — 25 tools, 11 stacks)
4. Classify the user's task against the registry
5. This project is classified as: **Full Project Build Stack** (autonomous trading bot)

Then proceed with the Quick Resume below.

## Quick Resume

On session start, read this file and then check the current state:

```bash
# 1. Which branch is deployed on the server?
ssh root@204.168.204.247 'cd /opt/polymarket-bot && git log --oneline -1 && git branch --show-current'

# 2. What's the local branch?
git branch --show-current && git log --oneline -3

# 3. Are all 3 locations synced?
# Mac, GitHub, and Hetzner should match. If not, sync before working.
```

If the answer to #1 includes `optimization/2026-04-12-v2`, the full v2 program (Tier 0+1+2) is deployed. Read `docs/DEPLOYMENT_REPORT_2026-04-12_v2.md` for what's live and what to monitor.

## What This Project Is

PATS-Copy is an autonomous Polymarket copy-trading bot. It identifies top traders on the leaderboard, monitors their wallets, confirms trades via an AI classifier (sole gate — Phase 04 design), and mirrors positions with proportional sizing through a paper trading engine.

- **Capital:** $6,300 USDC (paper mode)
- **Targets:** >65% WR, >8% monthly return, <15% max drawdown
- **Baseline (2026-04-12):** WR 38.2%, +$63.59 realized, Max DD 15.77%

## Architecture (key files)

| Module | Path | Role |
|---|---|---|
| Runner | `src/core/runner.ts` | Orchestration loop — leaderboard poll, trade handling, status log |
| Confirmation | `src/confirmation/confirmation-layer.ts` | AI-only gate (Phase 04). MiroFish/orderbook informational only |
| Copy Executor | `src/execution/copy-executor.ts` | Sizing, filters, HARD BLOCK, cold streak, paper/live execution |
| AI Classifier | `src/signals/ai-classifier.ts` | Cerebras primary + OpenRouter fallback, challengeTrade (devil's advocate) |
| Scorer | `src/leaderboard/scorer.ts` | Composite score: 40% WR + 30% PF + 15% freq + 15% recency |
| Wallet Monitor | `src/monitor/wallet-monitor.ts` | Per-wallet trade polling, close detection with exit price capture |
| Risk Manager | `src/core/risk-manager.ts` | Position sizing, drawdown breaker (14%), daily loss limit |
| Position Lifecycle | `src/core/position-lifecycle.ts` | Auto-close: resolution, TTL (48h), stop-loss (30%) |
| Dashboard | `dashboard/src/app/page.tsx` | SSR Next.js dashboard at http://204.168.204.247 |

## Server Details

- **IP:** 204.168.204.247 (Hetzner CX23, Ubuntu 24.04)
- **SSH:** `root@204.168.204.247` (key-based auth from Mac)
- **Remote uses HTTPS** for git (`git remote set-url origin https://...`). Push from Mac, server fetches.
- **PM2 processes:** polymarket-bot, polymarket-dashboard, mirofish-scanner, mirofish-bridge
- **Bot location:** `/opt/polymarket-bot`
- **Dashboard:** http://204.168.204.247 (port 3000)

## Key Design Decisions (DO NOT violate)

1. **AI is the sole required gate** (Phase 04). MiroFish and orderbook are informational — they affect sizing (0.7x-1.5x) but NEVER veto.
2. **HARD BLOCK at 20% rolling WR** is correct. Fix bad leader selection (F11), don't relax the filter.
3. **Hot wallet elevation** (>=60% WR watchers -> rank-1 treatment) is intentional.
4. **New work goes on a branch off `streamline/slim-and-optimize`**, not off `main`. Current running branch on server should match what's on GitHub. Always verify with SSH before starting work.
5. **Always sync Mac/GitHub/Hetzner BEFORE analyzing code.** Previous session wasted hours analyzing stale local code that differed from the server by 20+ commits.

## Critical Reports

| Document | Purpose |
|---|---|
| `docs/DEPLOYMENT_REPORT_2026-04-12_v2.md` | What's deployed, expected behavior, rollback instructions, monitoring checklist |
| `docs/ANALYSIS_REPORT_2026-04-12_v2.md` | Full strategic analysis against correct running code |
| `docs/BASELINE_2026-04-12.md` | Pre-optimization Supabase baseline (378 trades, WR 38.2%) |

## What Was Done (2026-04-12 session)

Full v2 optimization program deployed:
- **T0.1** Dashboard metrics (WR/DD/Sharpe computed from trades, not null)
- **T0.3** peakBalance persistence (drawdown breaker survives restarts)
- **F3** AI parse-default -> veto (was: silent approve on malformed response)
- **F5** Real leader exit price (was: hardcoded 0.5 midpoint)
- **F8** Drawdown breaker 14% (was: 20%, with persistent peak balance)
- **F9a** Devil's advocate wiring (was: dormant because walletRollingWR set after confirmation)
- **F11** Leader scorer rolling-WR penalty (drops losing wallets from watcher list)
- **F12** OpenRouter fallback model fix (gemma-4-27b-it -> gemma-4-31b-it:free)
- **F4** classifyTrade prompt rewrite (removed "trust the leader" bias, added SKIP)
- **F1** News-scanner wired to classifyTrade (was: hardcoded empty array)
- **Balance sync** Bot writes authoritative balance to Supabase every 5 min; dashboard reads it

## What's Next (Tier 3 — not yet started)

- **F13** MiroFish investigation — 99.7% skip rate, effectively absent
- **F7** Out-of-sample validation of remaining filters (0.75 ceiling, $150 cap, 0.10 edge floor)
- **Cleanup** Remove dead Glint files, formalize walletRollingWR in LeaderTrade type
- **Monitor** 24-48h observation of v2 deployment, compare WR to 38.2% baseline

## Obsidian Knowledge Base

`~/Vaults/Jarvis-Brain/JARVIS-BRAIN/Projects/PATS-Copy/` — MOC at `00 PATS-Copy Hub.md`. PRD, docs, analyses are symlinked from the repo for bidirectional sync.

## Memory System

Cross-session memory is at `~/.claude/projects/-Users-sunil-rajput-claude-hq/memory/project_pats_copy.md`. Read it on session start for the full project state including findings, fix tiers, and forecast.
