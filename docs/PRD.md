# PATS-Copy — Product Requirements Document

**Version:** 1.0 | **Date:** 2026-03-17 | **Status:** Approved

## Executive Summary

PATS-Copy is an autonomous Polymarket copy-trading system that identifies the highest-performing trader on Polymarket's public leaderboard, copies their trades in real time, and uses a news/whale intelligence layer to confirm or veto each trade before execution. It rotates between top traders as performance shifts.

## Feature Requirements (MoSCoW)

### Must Have (MVP)
| ID | Feature | Description | Effort |
|----|---------|-------------|--------|
| F-001 | Leaderboard Scraper | Poll Polymarket leaderboard, extract trader data every 5 min | M |
| F-002 | Trader Scorer | Composite score: 40% win rate + 30% profit factor + 15% frequency + 15% recency | S |
| F-003 | Leader Selector | Identify #1, rotate when #2 exceeds by >5% for >1 hour | S |
| F-004 | Wallet Monitor | Detect leader's new positions via Data API within 60s | L |
| F-005 | Trade Confirmation | News/Glint check: approve if supporting or neutral, veto if contradicting | M |
| F-006 | Copy Executor | Proportional sizing, paper mode first | M |
| F-007 | Paper Trading Engine | Simulate trades, track P&L, stop-losses (reuse from pats-poly) | S |
| F-008 | Position Management | Close when leader closes. Stop-loss 15%. Max 5 positions. One per market | M |
| F-009 | Supabase Persistence | leaders, leader_history, copy_trades, daily_performance tables | S |
| F-010 | Runner + Status Logging | Orchestrate all modules, log every 5 min | M |

### Should Have (Phase 2)
| ID | Feature | Description |
|----|---------|-------------|
| F-011 | Live Execution | Real trades via Polymarket CLI |
| F-012 | Dashboard | Next.js + Tailwind (build in Anti-Gravity) |
| F-013 | Glint Whale Cross-Reference | Instant copy when leader detected in Glint whale feed |
| F-014 | Multi-Leader Tracking | Track top 5, allow manual override |

### Won't Have
| Feature | Reason |
|---------|--------|
| Autonomous trading (PATS-Poly style) | Proven ineffective as primary strategy |
| X/Twitter direct integration | Glint already captures major tweets |
| Orderbook WebSocket | Never produced data in PATS-Poly |

## Technical Stack
| Layer | Technology |
|-------|------------|
| Runtime | TypeScript / Node.js |
| Leaderboard | Puppeteer or Polymarket API |
| Wallet Monitoring | Polymarket Data API + Glint |
| AI Confirmation | Claude Sonnet (Anthropic API) |
| News Feed | Glint.trade WS + RSS |
| Database | Supabase (PostgreSQL) |
| Execution | Polymarket CLI |
| Dashboard (Phase 2) | Next.js via Anti-Gravity |

## Risk Controls
- Max position size: 2% of portfolio per trade
- Max concurrent positions: 5
- Max daily loss: 5% -> halt trading
- Max drawdown: 15% -> halt and alert
- Paper mode required for first 14 days

## Success Criteria
- Win rate >65% over 30-day paper period
- Monthly return >8%
- Max drawdown <15%
- Copy latency <90 seconds
- System uptime >95%

## Timeline
| Phase | Duration | Focus |
|-------|----------|-------|
| Phase 1: Backend MVP | Week 1 | Build in Claude Chat |
| Phase 2: Paper Validation | Weeks 2-3 | Run, analyze, tune |
| Phase 3: Live Execution | Week 4 | Fund wallet, go live |
| Phase 4: Dashboard | Weeks 5-6 | Build in Anti-Gravity |
