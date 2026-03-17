# PATS-Copy — Product Requirements Document

**Version:** 1.0
**Last Updated:** 2026-03-17
**Status:** Draft

---

## 1. Executive Summary

PATS-Copy is an autonomous Polymarket copy-trading system that identifies the highest-performing trader on Polymarket's public leaderboard, copies their trades in real time, and uses a news/whale intelligence layer to confirm or veto each trade before execution. It rotates between top traders as performance shifts.

### Success Criteria
>65% win rate over 30-day paper trading period

### Timeline
| Milestone | Target |
|-----------|--------|
| Phase 1: Backend MVP | 1 week |
| Phase 2: 14-day paper validation | 2 weeks |
| Phase 3: Live execution ($1K) | Week 4 |
| Phase 4: Dashboard (Anti-Gravity) | Weeks 5-6 |

---

## 2. Ranking Methodology

### Composite Score (optimized for high win rate)
- **Win rate 30d** (40%) — primary metric
- **Profit factor 14d** (30%) — total wins / total losses
- **Trade frequency** (15%) — must be actively trading
- **Recency** (15%) — decays rapidly, enables rotation

### Leader Rotation
New leader must exceed current by >5% for >1 hour (prevents flapping).

---

## 3. Confirmation Layer

When leader opens a position, BEFORE copying:
1. Check Glint signals (last 2hrs) for supporting/contradicting news
2. Run AI classifier on recent headlines about the market
3. **Approve**: signals support or don't contradict
4. **Veto**: strong opposing signals exist
5. **Skip**: micro-bet or unverifiable market

---

## 4. Risk Controls

| Parameter | Paper | Live |
|-----------|-------|------|
| Max position | 2% | 2% |
| Max positions | 5 | 3 |
| Stop-loss | 15% | 15% |
| Max daily loss | 5% | 5% |
| Max drawdown | 15% | 15% |
| One per market | Yes | Yes |

---

## 5. Data Sources

| Source | Provides | Access |
|--------|----------|--------|
| Polymarket Leaderboard | Rankings, P&L, win rate | Scrape or API |
| Polymarket Data API | Wallet positions, trades | REST (public) |
| Glint.trade | Real-time news + whale trades | WebSocket via Puppeteer |
| RSS Feeds (5) | News for confirmation | HTTP polling |
| Claude Sonnet | AI confirmation | REST API |
| Polymarket CLI | Order execution | CLI subprocess |

---

## 6. Feature Requirements (MVP)

| ID | Feature | Description |
|----|---------|-------------|
| F-001 | Leaderboard Scraper | Poll leaderboard, extract trader data, 5min refresh |
| F-002 | Trader Scorer | Composite score with 4 weighted components |
| F-003 | Leader Selector | Pick #1, rotation with hysteresis |
| F-004 | Wallet Monitor | Detect leader's new positions via Data API + Glint |
| F-005 | Confirmation Layer | News/Glint check before copying |
| F-006 | Copy Executor | Paper mode first, proportional sizing |
| F-007 | Position Management | Stop-loss, max 5, one per market |
| F-008 | Supabase Persistence | leaders, leader_history, copy_trades tables |
| F-009 | Runner | Orchestrator + status logging |

---

## 7. Supabase Schema

### leaders table
wallet_address, display_name, composite_score, win_rate_30d, profit_factor_14d, trade_count_30d, total_pnl_30d, last_trade_time, is_current_leader, updated_at

### leader_history table
wallet_address, became_leader_at, replaced_at, trades_copied, pnl_during_tenure, reason_replaced

### copy_trades table
leader_wallet, market_id, market_question, token_id, outcome, side, leader_entry_price, our_entry_price, our_size, confirmation_result (approved/vetoed), confirmation_reason, status, pnl, entry_time, exit_time
