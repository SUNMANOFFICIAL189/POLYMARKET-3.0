# MISSION BOARD — Branch 3 Geopolitics Specialist Research Sprint

**Started:** 2026-05-11 (session continues from end-of-day handoff)
**Time-box:** 4–6h total. Stop and report at 6h regardless of phase progress.
**Mode:** Research only — no Branch 3 build, no BUY re-enable, no Hetzner mutations.
**Status:** in progress

---

## Brief (verbatim from user)

> Validate whether the geopolitics-copy edge generalises beyond wallet `0x5d05b1f5`
> before committing to the Branch 3 build. The 2026-05-11 backtest gave MIXED
> verdict (positive PnL but all 8 sample positions from one wallet = single point
> of failure).

---

## Baseline being challenged

- Sample: 8 closed positions in last 30d
- Source: **all 8 from wallet `0x5d05b1f5...`**
- Leader PnL: +$333.97 (MTM)
- Proportional sizing: **+$160.46** on $1,440.76 deployed → 11.14% ROI
- Flat $75 sizing: **+$187.39** on $1,350.00 deployed → 13.88% ROI
- Win rate: 75%
- Structural caveat: 34/42 markets had no Gamma MTM data (resolved/archived) → selection bias toward still-open markets

---

## Phase graph

```
[Phase 1] Source candidates   (1-2h)
   │ Top-100 Polymarket leaderboard across 30d / 90d / all-time
   │ + audit existing 11-wallet watch list for last-90d geopolitics activity
   │ Optional: Dune geopolitics dashboards
   │ Output: raw candidate list, no filter yet
   ▼
[Phase 2] Hard-filter screening   (1-2h)
   │ LOCKED FILTERS (no goalpost shifting):
   │   - ≥15 geopolitics-market trades in last 90d
   │   - WR ≥55% on those trades
   │   - Avg trade size $10–$500 (exclude whales + noise)
   │   - Active in last 14 days
   │ Output: ranked shortlist of 5–10 wallets
   ▼
[Phase 3] Backtest validation   (1-2h)
   │ Update WATCHED_WALLETS in scripts/backtest/branch3-geopolitics.ts
   │ Run: npx tsx scripts/backtest/branch3-geopolitics.ts
   │ Compare proportional vs flat sizing on the diversified sample
   ▼
[Verdict] Apply locked decision criteria
   │ See "Decision criteria" below
   ▼
[Persist] Deliverables to disk + Decision Log + BACKLOG + memory
```

---

## Decision criteria (locked — apply mechanically, no goalpost shifting)

| Phase 3 outcome | Verdict |
|---|---|
| Diversified positive PnL on larger sample | **BUILD** Branch 3 v1, flat sizing |
| `0x5d05b1f5` is the ONLY consistent specialist | **Small-cap test ($200)** or **KILL** |
| Shortlist outperforms `0x5d05b1f5` | **SWAP** in stronger wallets, build with new list |

Locked in the 2026-05-11 Decision Log entry. Do not modify mid-sprint.

---

## Constraints (per user brief + global rules)

- **Plain English** in all user-facing replies (CTDD doctrine)
- **DO NOT** start Branch 3 build during this session — research only
- **DO NOT** touch BUY re-enable — user-deferred
- **DO NOT** modify Hetzner production — research is offline/local only
- **Time-box:** stop and report at 6h even if Phase 3 isn't complete
- **Mid-session persistence:** save findings to memory + Decision Log AS YOU GO (compaction risk per CLAUDE.md MID-SESSION PERSISTENCE rule)
- **No goalpost shifting:** if Phase 3 verdict says KILL, the deliverable is KILL — not a re-screening

---

## Cost / credentials

- **Polymarket data-api** — public, no key (proven in existing backtest harness)
- **Polymarket gamma-api** — public, no key
- **Polymarket leaderboard page** — Puppeteer + XHR interception (proven by bot's `LeaderboardScraper`)
- **Optional Dune** — would need free-tier API key if used. Skip on first pass; only invoke if API/Puppeteer paths yield <50 candidates
- **Total estimated tokens this session:** moderate (research + code + analysis). No paid LLM calls.
- **Total estimated $:** $0

---

## Risk flags

| Risk | Mitigation |
|---|---|
| Polymarket leaderboard endpoint returns nothing (existing scraper found 0/8 REST attempts work) | Fall back to Puppeteer + XHR interception, then `__NEXT_DATA__` parse — proven path used in prod |
| Cloudflare / bot-protection on Puppeteer flow | Existing scraper has realistic UA + sandbox flags; reuse those configs |
| "Geopolitics" category isn't a clean tag in the data-api response | Use existing `src/signals/market-categoriser.ts` which already classifies markets |
| Rate-limiting on data-api when probing 100+ wallet histories | Throttle requests; ≥60ms gap between calls (matches existing backtest harness) |
| Top 100 across 3 windows overlap too much, yielding <50 unique wallets | Acceptable — augment with snowball discovery via counterparties on known specialist trades |
| 0x5d05b1f5 stops trading mid-sprint | Pre-built data is frozen in the analysis; sprint result still valid |

---

## Deliverables (end of session)

- [ ] Updated `scripts/backtest/branch3-geopolitics.ts` with researched shortlist
- [ ] Research findings doc: `_NEXT_STEPS/branch-3-research-2026-05-11.md`
- [ ] Obsidian Decision Log entry with verdict + provenance tag
- [ ] BACKLOG entry "Branch 3 Geopolitics Specialist Research Sprint" flipped to **[Done]** with outcome line
- [ ] Memory handoff `~/.claude/projects/-Users-sunil-rajput/memory/project_session_handoff_2026_05_11.md` (or new dated file) updated with verdict for the next session

---

## Knowledge layer touchpoints

- code-review-graph: auto-updates on Edit/Write/Bash via hook
- claude-mem: auto-captures observations (always-on)
- MemPalace: mine after session
- Obsidian: Decision Log append at verdict + Hub "Current State" if shortlist locked in
- LESSONS.md: append rule if any correction surfaces during the sprint
- graphify: incremental update at session end

---

## Session log

(Appended live as phases progress. Mid-session persistence — do not batch to end.)

### 2026-05-11 — Phase 0 complete
- State verified: branch `strategy/buy-optimization` at HEAD `ed37a2f` (above `82c9119`).
- Bot online, restart 113, no churn. Branch 2 listener actively processing blocks. Initial alarm on STATUS staleness was a UTC/local-time confusion — bot is healthy.
- Backtest baseline numbers in master handoff reconciled (memory had a transcription error on "flat $75"; the $75 is the per-trade cap, not the total).
- Mission Board written. Phase 1 commencing.
