# PATS-Copy

## What This Is

An autonomous Polymarket copy-trading system that monitors the #1 ranked trader on the leaderboard, copies their trades with proportional sizing, and uses AI + Glint.trade signals to veto bad trades before execution. Runs in paper mode for the first 14 days to validate performance before going live.

## Core Value

Sunny can generate >8% monthly return on $6,300 of capital by autonomously copying the best Polymarket trader, without needing to monitor markets manually.

## Current State

| Attribute | Value |
|-----------|-------|
| Version | 0.1.0 |
| Status | Beta — paper trading validation |
| Last Updated | 2026-03-17 |

## Requirements

### Validated (Shipped)

- [x] Leaderboard scraper — fetches top 20 traders via Puppeteer (49 entries found)
- [x] Leader scorer — composite score: 40% win rate + 30% profit factor + 15% frequency + 15% recency
- [x] Leader selector — hysteresis rotation (>5% margin, >1hr duration)
- [x] Wallet monitor — polls Data API every 30s for new leader trades
- [x] Glint scraper — intercepts wss://api.glint.trade/ws for whale + signal feed
- [x] AI confirmation layer — Claude Sonnet veto check before every copy
- [x] Copy executor — proportional sizing, paper mode simulation
- [x] Supabase persistence — leaders, leader_history, copy_trades, daily_performance tables
- [x] Glint reconnect backoff — stable-connection guard prevents infinite 22s loop

### Active (In Progress)

- [ ] Paper trading validation — 14 days, target >65% win rate, >8% monthly return, <15% drawdown
- [ ] Supabase schema migration — tables must be created before persistence works

### Planned (Next)

- [ ] Live mode activation — switch PAPER_MODE=false after 14-day validation passes
- [ ] Leader rotation monitoring — verify hysteresis logic in practice
- [ ] Position close detection — confirm leader-closed events trigger our exits

### Out of Scope

- Manual trade entry — system is fully autonomous
- Multi-leader copying — single leader at a time by design
- Options/futures — Polymarket binary markets only

## Target Users

**Primary:** Sunny (solo operator)
- Capital: $6,300 USDC
- Goals: >65% win rate, >8% monthly return, <15% drawdown
- Constraint: Paper mode required for first 14 days

## Constraints

### Technical Constraints
- Must run on macOS (darwin) with Node.js/tsx
- Polymarket Data API is public but rate-limited — 30s poll interval minimum
- Glint.trade requires authenticated session (Google login, cookies saved)
- Puppeteer leaderboard scraper is the only working strategy (API endpoints all 403/empty)

### Business Constraints
- PAPER_MODE=true mandatory for first 14 days — no live capital at risk
- $6,300 total capital — max position size governed by RiskManager

## Key Decisions

| Decision | Rationale | Date | Status |
|----------|-----------|------|--------|
| Single leader, not multi | Simplicity — diversifying across leaders adds noise, not signal | 2026-03-17 | Active |
| Hysteresis rotation (5%/1hr) | Prevent churning between near-equal traders | 2026-03-17 | Active |
| AI veto only (no AI approve) | Trust the leader — only block on strong opposing signals (≥70% confidence) | 2026-03-17 | Active |
| Paper mode 14 days | Validate before risking real capital | 2026-03-17 | Active |
| Puppeteer for leaderboard | All public API endpoints return empty — only browser-rendered page works | 2026-03-17 | Active |

## Success Metrics

| Metric | Target | Current | Status |
|--------|--------|---------|--------|
| Win rate | >65% | n/a (day 1) | Not started |
| Monthly return | >8% | 0% | Not started |
| Max drawdown | <15% | 0% | On track |
| AI cost per day | <$0.50 | $0.00 | On track |
| Consecutive vetoes | <5 | 0 | On track |

## Tech Stack

| Layer | Technology | Notes |
|-------|------------|-------|
| Runtime | Node.js + tsx | ESM modules, NodeNext resolution |
| Language | TypeScript | Strict mode |
| Scraping | Puppeteer | Leaderboard + Glint CDP interception |
| AI | Claude Sonnet 4.6 | Trade confirmation veto only |
| Database | Supabase (PostgreSQL) | 4 tables: leaders, leader_history, copy_trades, daily_performance |
| Signals | Glint.trade WebSocket | wss://api.glint.trade/ws |
| News | RSS scanner | Multi-feed news context for AI |

## Links

| Resource | URL |
|----------|-----|
| Repository | https://github.com/SUNMANOFFICIAL189/POLYMARKET-3.0 |
| Supabase | https://supabase.com/dashboard/project/sluurctitmrzfjcijyov |
| Glint.trade | https://glint.trade/events |
| Polymarket Leaderboard | https://polymarket.com/leaderboard |

---
*PROJECT.md — Updated when requirements or context change*
*Last updated: 2026-03-17*
