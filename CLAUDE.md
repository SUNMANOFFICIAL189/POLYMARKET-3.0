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

## Autonomous Monitoring Protocol

**THIS SECTION IS MANDATORY.** On every session that involves PATS-Copy, after completing any task (fix, deploy, analysis), run the health check below BEFORE reporting success. Do not wait for the user to ask. Do not skip this.

### Post-Deploy Verification (run within 10 minutes of any deployment)

```bash
ssh root@204.168.204.247 'cd /opt/polymarket-bot && pm2 logs polymarket-bot --nostream --lines 100 2>&1' > /tmp/pats-postdeploy.log
```

Then verify ALL of these. If any fail, investigate root cause immediately — do NOT move to the next task:

1. **Bot is running** — `pm2 ls` shows online, uptime increasing
2. **No crash loops** — restart count hasn't jumped since deploy
3. **Fix signature present** — every deployed fix must produce at least one log line proving it's active. If a fix has zero log evidence after 10 min, it's either dormant or broken. Investigate.
4. **No new errors** — grep for `[error]`, `ERR`, `failed`. If new error patterns appear that weren't present before, the deploy introduced a regression. Do NOT move on.
5. **Positions are moving** — if open positions > 0 AND closedTrades hasn't changed in >2 hours, something is blocking closes. Investigate the lifecycle manager.
6. **Execution is happening** — if vetoes are climbing but executions haven't moved in >2 hours, investigate what's blocking execution (slot cap? drawdown breaker? HARD BLOCK on all wallets?).

### Anomaly Rules (check on every status pull)

These are RED FLAGS that require immediate root-cause investigation, not just observation:

| Anomaly | Threshold | Required action |
|---|---|---|
| **Balance unchanged** for >2 hours | Same balance across 24+ STATUS lines | Investigate: is the bot frozen? Are positions stuck? Is it trading at all? |
| **Zero lifecycle events** despite open positions | openPositions > 0 AND zero `PositionLifecycle:` log lines in 2h | Investigate: is the resolution checker working? Are market slugs matching? Check `fetchMarketStatus` results. |
| **Execution rate < 5%** for >1 hour | vetoes climbing but executions flat | Investigate: is drawdown breaker blocking? All wallets HARD BLOCKED? Position cap full? |
| **Open positions at cap** for >6 hours | openPositions >= MAX_OPEN_POSITIONS with no closes | Positions are gridlocked. Check market resolution + TTL. Do NOT just wait for TTL — investigate why resolution isn't working. |
| **AI error rate > 20%** | More than 1 in 5 AI calls returning errors | Investigate: is Cerebras down? Is the fallback working? Is F3 safe-fail vetoing everything? |
| **Devil's advocate zero activity** when trades are being confirmed | Confirmation APPROVED log lines exist but zero devil's advocate lines | F9a wiring may have regressed. Check walletRollingWR attachment in runner. |
| **Balance divergence > $50** between TG and dashboard | Compare hourly TG alert vs dashboard | Investigate: is .bot-status.json being written? Is the dashboard reading it? |
| **New error pattern** after deploy | Any `[error]` message not seen before | The deploy introduced a regression. Investigate immediately. Do not move to next task. |

### Root-Cause Discipline

**Every workaround MUST be paired with a root-cause investigation in the same session.**

When you encounter an anomaly:
1. **Workaround** — apply the immediate fix to restore operation (e.g., flush stale positions via TTL)
2. **Root cause** — in the SAME session, investigate WHY the anomaly occurred (e.g., why did the resolution checker fail? What's the slug mismatch?)
3. **Permanent fix** — implement the real fix, not just the workaround (e.g., multi-strategy lookup + logging)
4. **Verify** — confirm the permanent fix works by checking for its specific log signature

**Never report a workaround as "fixed."** Always distinguish between "workaround applied" and "root cause resolved." If only the workaround ships, explicitly tell the user the root cause is still open.

### Post-Fix Closed Loop

After deploying any fix:
```
Deploy → Wait 10 min → Pull logs → Check fix signature →
  If signature present: ✓ Fix confirmed
  If signature absent: ⚠ Fix didn't take → investigate why
  If new errors: 🚨 Regression → rollback + investigate
```

This loop is NOT optional. Run it for every deployment. If the fix signature isn't present within 10 minutes, the fix is suspect regardless of whether `tsc` passed.

### Proactive Health Check (run at session start AND before session end)

```bash
ssh root@204.168.204.247 'cd /opt/polymarket-bot && \
  echo "=== STATUS ===" && pm2 logs polymarket-bot --nostream --lines 50 2>&1 | grep STATUS | tail -3 && \
  echo "=== ERRORS ===" && pm2 logs polymarket-bot --nostream --lines 200 2>&1 | grep -i error | grep -v "balance_usdc" | tail -5 && \
  echo "=== LIFECYCLE ===" && pm2 logs polymarket-bot --nostream --lines 200 2>&1 | grep PositionLifecycle | tail -5 && \
  echo "=== OPEN POSITIONS ===" && cat .bot-status.json 2>/dev/null'
```

If any anomaly rule triggers, investigate BEFORE doing whatever the user asked for. The bot's health comes first.

## Obsidian Knowledge Base

`~/Vaults/Jarvis-Brain/JARVIS-BRAIN/Projects/PATS-Copy/` — MOC at `00 PATS-Copy Hub.md`. PRD, docs, analyses are symlinked from the repo for bidirectional sync.

## Memory System

Cross-session memory is at `~/.claude/projects/-Users-sunil-rajput-claude-hq/memory/project_pats_copy.md`. Read it on session start for the full project state including findings, fix tiers, and forecast.
