# PATS-Copy — Context Handoff Document

**Purpose:** This document gives a new context window everything needed to build PATS-Copy from scratch.

**Date:** 2026-03-17
**Previous project:** PATS-Poly (`SUNMANOFFICIAL189/pats-poly` on GitHub)
**This project:** PATS-Copy (`SUNMANOFFICIAL189/pats-copy` on GitHub)
**User:** Sunny — runs the system, shares logs, expects diagnosis + fix in one shot. Self-verify before returning control.

---

## 1. WHAT IS PATS-COPY

An autonomous Polymarket copy-trading system that:
1. Identifies the highest-performing trader on Polymarket's public leaderboard
2. Monitors their wallet for new trades in real-time
3. Uses a news/whale intelligence layer to confirm or veto each trade
4. Copies confirmed trades with proportional position sizing
5. Rotates to a new leader when performance shifts

## 2. WHY WE PIVOTED FROM PATS-POLY

PATS-Poly was an autonomous signal-fusion trading system. After 6 sessions:
- Conviction scores plateaued at 40-50 (needed 55+ for conservative mode)
- System opened positions on meme markets ("Jesus Christ return before GTA VI")
- P&L was -$11 on paper trades after 16 hours
- News classifier worked well as CONFIRMATION tool but poorly as PRIMARY signal
- Conclusion: identifying WHO is already generating alpha is easier than generating it independently

## 3. ARCHITECTURE

```
Leaderboard Scraper (5min) -> Trader Scorer -> Leader Selector (rotation hysteresis)
                                                    |
                                            Wallet Monitor (detect new positions)
                                                    |
                                    +-- Confirmation Layer --+
                                    |  Glint signals         |
                                    |  News scanner          |
                                    |  AI classifier         |
                                    +--------+---------------+
                                             |
                                    Copy Executor (paper -> live)
                                             |
                                    Risk Manager (sizing, stops)
                                             |
                                    Supabase (persist everything)
```

## 4. TRADER SCORING FORMULA

Composite score = weighted sum, recalculated every 5 minutes:
- **Win rate (30 days):** 40% weight
- **Profit factor (14 days):** 30% weight (total wins / total losses)
- **Trade frequency:** 15% weight
- **Recency of last trade:** 15% weight (decays rapidly)

Leader rotation: switch when #2 exceeds #1 by >5% for >1 hour (prevents flapping).

## 5. CONFIRMATION LAYER LOGIC

When leader opens a trade:
1. Check Glint signals from last 2 hours for supporting news
2. Run AI classifier on recent headlines matching the market
3. Decision matrix:
   - Supporting signals exist -> APPROVE (copy)
   - No signals either way -> APPROVE (trust leader)
   - Strong opposing signals -> VETO (skip, log reason)
4. A veto does NOT cause leader rotation

## 6. DATA SOURCES

- Polymarket leaderboard: `https://polymarket.com/leaderboard`
- Polymarket Data API (public, no auth):
  - Positions: `https://data-api.polymarket.com/positions?user={address}`
  - Trades: `https://data-api.polymarket.com/trades?user={address}&limit=50`
- Glint.trade WebSocket: `wss://api.glint.trade/ws`
- RSS feeds: NPR, Politico, BBC, CoinDesk, CNN

## 7. ENV VARS NEEDED

```env
ANTHROPIC_API_KEY=sk-ant-...
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_SERVICE_KEY=eyJ...
ENABLE_GLINT=true
GLINT_HEADLESS=true
PAPER_MODE=true
RISK_LEVEL=paper
```

## 8. BUILD ORDER (Phase 1)

1. T-001: Create repo scaffold (package.json, tsconfig, src/ dirs)
2. T-002: Copy reusable modules from pats-poly
3. T-003: Build leaderboard scraper
4. T-004: Build trader scorer
5. T-005: Build leader selector with rotation hysteresis
6. T-006: Build wallet monitor (detect leader's trades)
7. T-007: Build confirmation layer
8. T-008: Build copy executor (paper mode)
9. T-009: Build runner (orchestrate everything)
10. T-010: Supabase schema (leaders, leader_history, copy_trades tables)
11. T-011: End-to-end paper trading validation

## 9. SUCCESS CRITERIA

- Win rate >65% over 30-day paper period
- Monthly return >8%
- Max drawdown <15%
- Copy latency <90 seconds
- System uptime >95%
