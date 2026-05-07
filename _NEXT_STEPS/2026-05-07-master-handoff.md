# 2026-05-07 — Master Handoff

**Session ended:** 2026-05-07
**Next session:** resume from this file
**Status at end:** Bot healthy + heartbeats green, but **−$560 balance drop in last 11h needs investigation FIRST**

---

## ⚠ UPDATE 2026-05-08 (continuation session) — Phase A + Phase B BOTH COMPLETE

**Phase A is CLOSED. Not a regression. Do NOT roll back `ef206c1`.**

**Phase B is CLOSED. Architectural watchdog Tier 1 live in --soak mode.**

Steps 2-6 all completed in the 2026-05-08 continuation session:
  * Step 2: 3 semgrep static rules (`enddate-flow`, `side-aware-pnl`, `single-trade-pool`) — calibrated and committed
  * Step 3: 4 Python runtime rules — 2 from original plan (`supabase_consistency`, `cron_file_existence`) + 2 added per Phase A findings (`low_priced_sell_max_loss`, `supabase_pnl_write_reliability`)
  * Step 4: orchestrator.py + lib/alerts.py — three modes (--soak default, --active, --once-stdout)
  * Step 5: revert-validation — all 4 known bugs from 2026-05-07 confirmed to fire the corresponding rule when the fix is reverted on a temp branch
  * Step 6: launchd loaded, soak running, reminders.json rebased — flip-to-active reminder now fires 2026-05-22

**Currently running:** Watchdog runs every 30 min via `com.claude-hq.pats-watchdog`. Audit log accumulates at `~/claude-hq/watchdogs/pats/audit.log` (gitignored). No Telegram alerts during soak.

**Next decision gate (2026-05-22):** Review audit.log false-positive rate. If <10%, flip `--soak` → `--active` per Phase F step 24.

---

## ⚠ UPDATE 2026-05-08 (continued) — Phase C DEPLOYED, observation started

**Phase C is DEPLOYED. Bot is running Signal v2 (commit `f2fd8e4`). 7-14 day observation window opens now.**

Steps 7-13 all done in same session:
  * Step 7-10: branched `strategy/signal-v2`, edited `signal-executor.ts` + `.env.example`
  * Step 11: `tsc` clean, committed `f2fd8e4`, pushed `strategy/signal-v2`
  * Step 12: fast-forward merged → `strategy/buy-optimization`, pushed
  * Step 13: server pulled (HEAD verified `f2fd8e4`), `npm run build` clean, `pm2 restart` (PID 519630, restart count 104). Hydration succeeded — 2 open, 712 closed, balance recomputed to **$6,308.14** from Supabase

**Important side effect of restart:** The post-restart balance ($6,308.14) is **$925 higher than the pre-restart in-memory balance ($5,382.85)**. The recomputation comes from Supabase `sum(pnl) = +$158.14` which doesn't include the catastrophic −$943 BTC trade (that row has `pnl=0` in the db — see Phase A finding). The bot's view of capital is now over-stated by ~$925 until the BACKLOG `Supabase pnl-write reliability` item is fixed and historical rows are backfilled.

**Behavior change deployed:**
  * BUY signal trades blocked unless `SIGNAL_BUY_ENABLED=true` (default off)
  * SELL signal trades rejected when `hoursToResolution > MAX_HOURS_SELL_RESOLUTION` (default 24h)

**Step 14 (observation, 7-14 days) starts now:**
  * Track WR, PnL, trade volume daily
  * Watch watchdog audit.log daily for new findings
  * Decision gate at +7 days: if signal v2 stable AND watchdog FP rate < 10%, flip watchdog to `--active` early

**Next priority items, in order:**
  1. (queued) **SELL-aware position sizing** — partial mitigation via Signal v2's <24h cap, but doesn't fix the underlying max-loss math.
  2. (queued) **Phase D: sports-convergence-copy** — gated on Phase C step 14 success.

---

## ⚠ UPDATE 2026-05-08 (continued, late) — Supabase pnl-write reliability RESOLVED

**The audit gap is closed. Bot now hydrates to a balance that matches the database, and the database matches reality (modulo $18 in pre-2026-05-06 rows that can't be recovered from rotated logs).**

Branch `fix/pnl-write-reliability` merged → `strategy/buy-optimization` at commit `58d8257`. Two compound bugs fixed:
- `copy-executor.ts:548` — guard added so closePosition delegates to signalExecutor when the marketId isn't tracked, instead of closing the trade in paperEngine and returning null.
- `runner.ts:168` — lifecycle closePosition closure made async + await, so the `if (copy)` truthy check sees the resolved value, not the always-truthy Promise.

Backfill script at `~/claude-hq/watchdogs/pats/scripts/backfill_pnl_writes.py`:
- 46 suspect rows total (status=stopped, pnl=0, our_size>0)
- 2 recoverable from PM2 logs (BTC-80k −$943.04, US-Iran-war −$0.18) — applied
- 44 unrecoverable (pre-2026-05-06 logs rotated, or reconciliation-only closures)
- Per user decision: 44 stay at pnl=0; code fix prevents new occurrences

**Post-deploy verification:**
- Server HEAD `58d8257`, build clean, pm2 restart count 105
- Hydration: `balance=$5289.92, realizedPnl=$-785.08` (matches expected: $6,300 − 3×$75 open − $785.08 = $5,289.92)
- Compiled JS contains both fix guards
- Zero errors since restart

**db sum(pnl) trajectory:** +$158.14 (pre-backfill) → −$785.08 (post-backfill, matches bot's pre-restart in-memory −$767.15 within $18 residual).

**The bot's view of capital is now accurate.** Phase G live-trading is no longer blocked by accounting drift.

---

**Single-trade explanation for the loss:** `9f11b560` SELL on `will-bitcoin-dip-to-80k-on-may-6`, entry 0.0408, size $75, exit 0.555 at 04:46:40 UTC = **−$943.04** PnL (97% of the observed PnL swing). Math: (0.555 − 0.041) × 1,829 shares = $940. Side-aware stop-loss math is correct. The fix surfaced pre-existing tail risk that the previous buggy code had been masking by never firing stop-loss on adverse SELL moves at all.

**Two real architectural gaps (queued in `~/claude-hq/docs/BACKLOG.md`, NOT addressed yet):**
1. SELL-aware position sizing (cap max-loss as % of equity, not dollar-size)
2. Supabase pnl-write reliability (11/30 recent SELL stops have pnl=0 in db while bot logged real losses)

Both should become Tier 1 watchdog rules in Phase B step 3 — they are the right rules to write because they catch exactly this class of bug class.

**Currently-open positions are safe.** `aliens-by-2027` and `nvidia-largest-by-may-31` are both bounded at ~$22 max stop-loss exposure each. Combined ~$45 if both stop.

**Full investigation written up in vault Decision Log entry `2026-05-07 · Phase A balance-drop investigation — NOT a regression`.**

**Skip Phase A below. Resume from Phase B (architectural watchdog Tier 1, scaffold complete in commit `75f7add`, resume from step 2).**

---

## Current state at end of session

| | |
|---|---|
| **Bot HEAD (production)** | `cd908a6` on `strategy/buy-optimization` |
| **Local branch** | `strategy/buy-optimization` synced |
| **Bot uptime** | 11h, 103 PM2 restarts cumulative |
| **Heartbeats** | All 4 layers 🟢 (Telegram-only delivery) |
| **Balance** | **$5,382.85 (down ~$560 in 11h since session-end Step B'/B'' deploy)** |
| **Open positions** | 2 (down from 11) |
| **WR** | 28.4% lifetime |
| **PnL** | **−$767.15 (concerning, see Phase A)** |

---

## Today's deployed commits (PATS-Copy)

| Commit | Change |
|---|---|
| `f80fd08` | Hydration endDate fix — fetches endDate from Gamma during signal-trade hydration |
| `730a85f` | Paper engine carries endDate from input to Trade object |
| `ef206c1` | Side-aware stop-loss — fixes pnl/loss formula for SELL trades |
| `c0e44b9` | Routes signal-bot trades to signalExecutor only on hydration (dual-executor mismatch fix) |
| `cd908a6` | Honest duplicate-position alert wording |
| `d64738b` | Healthchecks.io heartbeats wired into bot status log |

## Today's deployed commits (claude-hq)

| Commit | Change |
|---|---|
| `f09c9ee` | watchdog/listener.py heartbeat to Healthchecks.io |
| `089a4b2` | SSL fix for Mac Python heartbeat |
| `c546a06` | listener.py timeout 10s → 30s (cuts ~95% of false-positive timeouts) |
| `d236682` | Backlog: Gamma slug_contains + MemPalace TCC entries |
| `65e61e6` | Removed obsolete RPI/Goose reminders |
| `5ddc68c` | Backlog: convergence-copy + proportional sizing entries |
| `357dbca` | Backlog: uzucky/watchdog-ai re-evaluation triggers |
| `75f7add` | watchdogs/pats/ Tier 1 architectural watchdog scaffold |

## Server-side changes (no commits — direct edits)

- Removed broken `*/5 * * * * /opt/polymarket-bot/health-check.sh` cron entry
- Added 3 `HC_PING_*` URLs to `/opt/polymarket-bot/.env`
- Appended Healthchecks heartbeat block to `/opt/polymarket-bot/monitor.sh`
- Cleaned up Supabase: marked `ac4f382a-9afd-49d5-8879-a0364ac4bda8` as `stopped` with exit 09:40:30 + pnl $7.79 (manual cleanup of duplicate row)

---

## COMPLETE SEQUENTIAL PLAN — do in this order

### Phase A — Stabilize (do first, blocks everything else)

**Step 1: Investigate the −$560 balance drop**

- Pull the 26 trades that closed in the 11h window after Step B'/B'' deploy (between 2026-05-07 02:36 UTC and ~13:51 UTC)
- Query: `curl ... /rest/v1/copy_trades?leader_wallet=eq.signal-bot&exit_time=gt.2026-05-07T02:36:00&order=exit_time.desc`
- Check each trade: was the close natural (market resolved) or driven by stop-loss/TTL?
- For stop-loss closures: is the side-aware fix working correctly? (entry → current price → expected loss math)
- For market resolutions: did the SELL strategy hold or revert? (is this market variance or a regression?)
- **Decision:**
  - If natural variance (market settled against us, stops worked correctly) → document and continue
  - If regression (stops fired prematurely or wrong direction) → roll back the responsible commit, re-investigate
- **Estimated time:** 30-60 min
- **Gate:** Don't start Phase B until this is clear

---

### Phase B — Architectural watchdog Tier 1 (multi-day)

**Scaffold completed in commit `75f7add` at `~/claude-hq/watchdogs/pats/`. Resume from Phase 2.**

**Step 2: Write 3 semgrep static rules**
- `~/claude-hq/watchdogs/pats/rules/static/enddate-flow.yml` — catches today's hydration bug
- `~/claude-hq/watchdogs/pats/rules/static/side-aware-pnl.yml` — catches today's stop-loss bug
- `~/claude-hq/watchdogs/pats/rules/static/single-trade-pool.yml` — catches today's dual-executor mismatch
- Install semgrep via Trust Gate Tier C (Magika + secret-scan + Socket + reputation review)
- Test each rule against current PATS-Copy code; should have ZERO findings on healthy code
- **Estimated time:** 1-1.5 days

**Step 3: Write 2 Python runtime checks**
- `~/claude-hq/watchdogs/pats/rules/runtime/supabase_consistency.py` — detect stale "open" rows in Supabase
- `~/claude-hq/watchdogs/pats/rules/runtime/cron_file_existence.py` — detect cron entries pointing to missing files
- **Estimated time:** 0.5-1 day

**Step 4: Build orchestrator + alert wiring**
- `~/claude-hq/watchdogs/pats/orchestrator.py` — runs all 5 rules
- `~/claude-hq/watchdogs/pats/lib/alerts.py` — wraps `~/claude-hq/watchdog/telegram.py` PlainAlert
- Output: findings logged to `audit.log`; alerts (when active) follow Lesson 16 format
- **Estimated time:** 1 day

**Step 5: Validate against today's known-bug history**
- For each rule, revert the corresponding fix commit on a temporary branch, run watchdog, confirm rule fires
- Re-apply each fix
- Document which rule catches which bug
- **Estimated time:** 0.5 day

**Step 6: Load launchd + start 14-day observe-only soak**
- `cp ~/claude-hq/watchdogs/pats/com.claude-hq.pats-watchdog.plist ~/Library/LaunchAgents/`
- `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.claude-hq.pats-watchdog.plist`
- Plist already configured with `--soak` flag (observe-only mode)
- Add reminder to `~/claude-hq/watchdog/reminders.json`: fire at +14d "PATS watchdog soak ending — review audit.log + flip to active?"
- **Estimated time:** 30 min
- **Gate:** Don't start Phase C until soak is running

**Phase B total: ~3-5 days build + 14-day passive soak. Phase C can start in parallel after step 6 (don't need to wait for full soak).**

---

### Phase C — Signal v2 (drop BUY + SELL <24h cap)

**Starts only after Phase B Step 6 complete (watchdog soaking, even though alerts not active yet).**

**Step 7: Create `strategy/signal-v2` branch off `strategy/buy-optimization`**
```bash
cd ~/Desktop/POLYMARKET_TRADING_3.0
git checkout strategy/buy-optimization
git pull
git checkout -b strategy/signal-v2
```

**Step 8: Drop BUY signal trades in `signal-executor.ts`**
- Early-return on `signal.side === 'buy'` with informative log
- Env var: `SIGNAL_BUY_ENABLED` (default false)

**Step 9: Add SELL endDate <24h filter in `signal-executor.ts`**
- Compute hours-to-resolution from `signal.market.endDate`
- Reject SELL when `hoursToResolution > 24`
- Env var: `MAX_HOURS_SELL_RESOLUTION=24`

**Step 10: Update `.env.example`** to document new env vars

**Step 11: tsc check, commit, push** to remote `strategy/signal-v2`

**Step 12: Merge `strategy/signal-v2` → `strategy/buy-optimization`** locally + push

**Step 13: Deploy to server**
- ssh, `git fetch origin strategy/buy-optimization`, `git pull --ff-only origin strategy/buy-optimization`
- **VERIFY HEAD matches expected commit BEFORE restart** (lesson learned today)
- `npm run build`
- `pm2 restart polymarket-bot`
- Watch logs for 30 min, confirm no errors + watchdog rules don't false-positive

**Step 14: Observe for 7-14 days**
- Track WR, PnL, trade volume
- Watch for any new bug surfaces (watchdog still in observe-only — check `audit.log` daily)
- **Decision gate:** if signal v2 is stable AND watchdog has zero false positives during this window, flip watchdog to `--active` mode early

**Phase C total: ~1 hour build + 7-14 days observation**

---

### Phase D — Sports-convergence-copy

**Starts only after Phase C step 14 (signal v2 stable for ≥7 days).**

**Step 15: Out-of-sample backtest validation**
- Re-pull leader trade history from Polymarket data-api for last ~4 weeks (post-2026-05-07 data)
- Re-run convergence detection (30-min window, 2+ wallets, sports markets, same direction)
- Compute PnL with market resolutions
- **Decision gate:**
  - If out-of-sample matches in-sample (~60% WR, +$6/event flat sizing) → proceed
  - If diverges significantly (50% WR or worse) → DROP the idea entirely (per Lesson 20)
- **Estimated time:** 1 day

**Step 16: Create `feat/sports-convergence-copy` branch off `strategy/buy-optimization`**

**Step 17: Design sports engine**
- Separate lifecycle (game-length: hours not days)
- Different stop-loss config (tighter — sports markets resolve fast)
- Game-time scheduling (don't open <1h before tipoff, exit at final whistle)
- Capital allocation rules (e.g., 30% of $6,300 caps the sports half, 70% reserved for signal)

**Step 18: Implement sports engine as second PM2 service**
- New file structure (probably `src/sports/` or new repo)
- Reuses paper engine but with sports-specific config
- Convergence detector module (reads from data-api leader trades, not just our copy_trades)
- **Estimated time:** 5-10 days

**Step 19: Validate via paper-mode soak**
- Run for 14-30 days
- Compare actual vs predicted PnL (the in-sample backtest projected ~$60/day)
- **Decision gate:**
  - Matches predictions → keep running, plan Phase 5+ proportional sizing
  - Underperforms → debug or kill

**Phase D total: ~7-14 days build + 14-30 days observation**

---

### Phase E — Cosmetic + decisions (lowest priority, fit anytime)

**Step 20: Decide on `pats-warmup-reminder.plist`**
- File at `~/Library/LaunchAgents/com.claude-hq.watchdog.pats-warmup-reminder.plist`, NOT loaded
- Read its content first to understand what it was for
- Either delete (one-shot already passed) or load via launchctl

**Step 21: Decide on 3 architectural-watchdog reminders in `~/claude-hq/watchdog/reminders.json`**
- They fire May 12 ("retrofit watchdog"), May 26 ("flip to active"), June 2 ("Commander Step 0")
- Now that we're actually building Tier 1, these probably stay relevant
- Consider rewriting their content to reflect Tier 1 reality vs the original Tier 2/3/4 vision

**Step 22: Investigate stale Polymarket leaders DB**
- Half the rows are placeholder data (4% WR, $1 PnL, 0 trades)
- Likely the scraper isn't fully populating the table
- Worth fixing if copy-trading is ever revived (currently dead code)

---

### Phase F — Watchdog flip + evolution (after 14-day soak completes)

**Step 23: Day 14 of soak — review `audit.log`**
- Count true positives vs false positives
- Tune any noisy rules
- **Decision gate:** if false-positive rate is acceptable (<10%), flip alerts on

**Step 24: Flip watchdog from observe-only to active alerting**
- Edit `com.claude-hq.pats-watchdog.plist`: change `--soak` to `--active`
- `launchctl unload` then `launchctl bootstrap` to reload

**Step 25: Watch alerts for 30 days, refine**
- Add new rules as bugs surface
- Document each rule's hit rate

**Step 26: Decide on Tier 2 (after Tier 1 has proven itself for 30+ days)**
- Adds runtime invariants (more sophisticated state validators)
- Adds performance regression detection
- ~2 weeks build effort
- Defer until Tier 1 has at least 30 days of clean data

---

### Phase G — Live mode prep (target: early-to-mid June)

**Starts only after Phases B, C, D have all been observed stable.**

**Step 27: Final 7-day clean run check** — no critical bugs in any of the new components

**Step 28: Build live-execution path**
- Polymarket CLOB order placement via `py-clob-client`
- Risk management review for real capital
- Kill-switch wiring
- Health-endpoint stop conditions

**Step 29: Phase 4a — small live test ($500 on Polymarket)**
- Enable `LIVE_TRADING=true`
- Paper engine still runs as control group
- Compare paper vs live for slippage/fees

**Step 30: Phase 4b — scale up if validated**
- Increase capital
- Optionally add dYdX leverage path

---

## Background items (no specific timing, revisit when triggered)

| Item | Trigger to revisit |
|---|---|
| `uzucky/watchdog-ai` re-evaluation | Stars > 50 OR commit cadence > 6 months stable |
| Gamma `slug_contains` returns garbage | Anytime — drop Strategy 3 from `position-lifecycle.ts:267` (low priority) |
| MemPalace TCC blockage | Next interactive session — likely needs Full Disk Access on Terminal hosting Claude Code |
| Proportional sizing for copy | Only after sports-copy is operational and stable |
| 99 PM2 restart count | Largely historical noise from old monitor cascade. Will trend down naturally. Reset to 0 if cosmetic concern |
| Convergence-copy out-of-sample validation | Built into Phase D step 15 |

---

## Critical decision gates summary

| Gate | What blocks if not passed |
|---|---|
| Phase A complete | Don't start Phase B until balance drop is understood |
| Phase B step 5 (validation) | Don't load launchd if rules don't catch known bugs |
| Phase C step 13 (deploy) | Don't proceed to Phase D until signal v2 is observed stable for ≥7 days |
| Phase D step 15 (out-of-sample) | Don't build sports engine if convergence pattern doesn't replicate |
| Phase F step 24 (flip alerts) | Don't enable alerts if soak shows high false-positive rate |
| Phase G step 27 (live readiness) | Don't go live until 7-day clean run AND human review of risk management |

---

## Lessons from this session

1. **Always verify HEAD matches expected commit BEFORE bot restart in production.** Today the first deploy of Step B' didn't take because of a generic `git pull` (no explicit branch arg). Wasted a restart. Fix: always run `HEAD=$(git rev-parse --short HEAD); if [ "$HEAD" = "$EXPECTED" ]; then ...` before pm2 restart.

2. **Don't conflate "validate against full history" with "validate against recent activity."** The BUY 1-3d "+$343 lifetime profit" was outlier-driven. Last 14 days showed it was actually marginal. Always cross-cut by recency before drawing conclusions.

3. **Don't bundle independent improvements into one branch.** Signal v2 and sports-convergence-copy are independent. Earlier in session I recommended waiting for both. User correctly pushed back: ship each as ready.

4. **Be precise with numbers.** Mid-session, I said "Hard-cap SELL endDate at 48h" then later "BUY endDate floor: 24h." User caught the inconsistency. The 48h was wrong (would have included the losing 1-3d bucket). Always re-check the data before stating a threshold.

5. **The "watchdog" word means different things.** Across this session: `watchdog.sh` (process), Healthchecks heartbeats (operational), HQ Watchdog listener (Telegram I/O), architectural watchdog (Tier 1 detection — what we just scaffolded). When user says "watchdog," confirm which one.

---

## File paths reference

| Thing | Where |
|---|---|
| **PATS-Copy code** | `/Users/sunil_rajput/Desktop/POLYMARKET_TRADING_3.0/` |
| **HQ Watchdog (parent)** | `/Users/sunil_rajput/claude-hq/watchdog/` |
| **PATS Architectural Watchdog scaffold** | `/Users/sunil_rajput/claude-hq/watchdogs/pats/` |
| **HQ Watchdog reminders.json** | `/Users/sunil_rajput/claude-hq/watchdog/reminders.json` |
| **HQ Watchdog .env (Telegram + email creds)** | `/Users/sunil_rajput/claude-hq/watchdog/.env` |
| **Healthchecks API key** | macOS Keychain — service `claude-hq-healthchecks-apikey` |
| **Healthchecks ping URLs** | `/Users/sunil_rajput/claude-hq/watchdog/healthchecks-urls.env` (gitignored, mode 600) |
| **Server bot** | `root@204.168.204.247:/opt/polymarket-bot/` |
| **Server .env (with HC_PING_* URLs)** | `/opt/polymarket-bot/.env` (server-only) |
| **Vault — PATS-Copy hub** | `/Users/sunil_rajput/Vaults/Jarvis-Brain/JARVIS-BRAIN/Projects/PATS-Copy/` |
| **Decision Log** | Vault `04 Decision Log.md` |
| **Backlog (HQ)** | `/Users/sunil_rajput/claude-hq/docs/BACKLOG.md` |
| **Mission Board (vault)** | `Projects/PATS-Copy/03 Mission Board.md` |
| **Project-watchdog design docs** | `/Users/sunil_rajput/claude-hq/docs/project-watchdog/` |

---

## Bootstrap commands (paste into next session start)

```bash
# 1. Verify everything synced
cd ~/Desktop/POLYMARKET_TRADING_3.0
git fetch origin && git status

# 2. Read this handoff
cat _NEXT_STEPS/2026-05-07-master-handoff.md

# 3. Check bot health (pre-investigation)
ssh root@204.168.204.247 'cd /opt/polymarket-bot && \
  git log --oneline -1 && \
  pm2 ls --no-color | grep polymarket-bot && \
  cat .bot-status.json'

# 4. Check Healthchecks state
HC_KEY=$(security find-generic-password -a "$USER" -s "claude-hq-healthchecks-apikey" -w)
curl -s "https://healthchecks.io/api/v3/checks/" -H "X-Api-Key: $HC_KEY" | python3 -m json.tool | head -30
```

---

*Last updated: 2026-05-07 end of session.*
