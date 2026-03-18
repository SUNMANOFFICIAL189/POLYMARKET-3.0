# PATS-Copy — Product Requirements Document

**Version:** 1.0  
**Last Updated:** 2026-03-17  
**Author:** Claude / Sunny  
**Status:** Draft  
**Predecessor:** PATS-Poly (autonomous signal fusion — pivoting away from this approach)

---

## Table of Contents
1. [Executive Summary](#1-executive-summary)
2. [Product Vision & Objectives](#2-product-vision--objectives)
3. [User Personas & Use Cases](#3-user-personas--use-cases)
4. [Feature Requirements](#4-feature-requirements)
5. [Technical Architecture](#5-technical-architecture)
6. [API & Data Model Specifications](#6-api--data-model-specifications)
7. [Security & Compliance](#7-security--compliance)
8. [Performance Requirements](#8-performance-requirements)
9. [Development Timeline & Milestones](#9-development-timeline--milestones)
10. [Success Metrics & KPIs](#10-success-metrics--kpis)
11. [Risks & Mitigation Strategies](#11-risks--mitigation-strategies)
12. [Out of Scope](#12-out-of-scope)
13. [Appendix](#13-appendix)

---

## 1. Executive Summary

### Product Overview
PATS-Copy is an autonomous Polymarket copy-trading system that identifies the highest-performing trader on Polymarket's public leaderboard, copies their trades in real time, and uses a news/whale intelligence layer to confirm or veto each trade before execution. It rotates between top traders as performance shifts, ensuring the system always follows whoever is currently generating the best returns.

### Problem Statement
Generating alpha from autonomous news classification on prediction markets is extremely difficult — even institutional quant teams struggle with this. PATS-Poly (the predecessor) proved this: after weeks of development, conviction scores plateaued at 40-50 and the system opened positions on low-quality markets. However, Polymarket has a public leaderboard with verifiable track records. Identifying WHO is already generating alpha and following them is a much more tractable problem than generating alpha independently.

### Why This Pivot
- PATS-Poly's autonomous signal fusion produced weak conviction (40-50 range) and opened positions on meme markets
- The news/whale/orderbook intelligence layer works well as a CONFIRMATION tool but poorly as a PRIMARY signal
- Polymarket's public leaderboard provides verifiable, auditable trader performance data
- Copy trading removes the hardest problem (what to trade) and replaces it with a simpler one (who to follow)

### Key Features (MVP)
- Leaderboard tracker: poll Polymarket leaderboard, score and rank traders
- Trade detector: monitor the current #1 trader's wallet for new positions
- Confirmation layer: validate each trade against news/Glint intelligence before copying
- Copy executor: mirror trades with proportional position sizing
- Leader rotation: automatically switch when a new trader takes the top spot
- Paper trading mode for validation before live execution

### Success Criteria
**Primary:** Achieve >65% win rate over a 30-day paper trading period, outperforming the PATS-Poly autonomous approach (which achieved ~0% meaningful win rate).

### Timeline
| Milestone | Target Date |
|-----------|-------------|
| PRD Approved | 2026-03-17 |
| Phase 1: Backend MVP (paper mode) | 2026-03-24 |
| Phase 2: 14-day paper validation | 2026-04-07 |
| Phase 3: Live execution ($1K) | 2026-04-08 |
| Phase 4: Dashboard (Anti-Gravity) | 2026-04-21 |

---

## 2. Product Vision & Objectives

### Vision Statement
Build a reliable, automated copy-trading system for Polymarket that consistently generates profits by following the platform's best traders, confirmed by real-time news intelligence.

### Business Objectives
| Objective | Metric | Target | Timeline |
|-----------|--------|--------|----------|
| Win rate | Closed trades with positive P&L / total closed trades | >65% | 30 days |
| Monthly return | (End balance - Start balance) / Start balance | >8% | Monthly |
| Drawdown limit | Max peak-to-trough decline | <15% | Continuous |
| Uptime | System running without manual intervention | >95% | Weekly |

### Why Copy-the-Leader Over Autonomous Trading
| Aspect | Autonomous (PATS-Poly) | Copy-the-Leader (PATS-Copy) |
|--------|------------------------|----------------------------|
| Signal quality | Weak (conv 40-50) | Proven (top trader's track record) |
| Market selection | Often wrong (meme markets) | Follows proven trader's choices |
| Complexity | Very high (fusion, classifier, thresholds) | Moderate (wallet monitoring + confirmation) |
| Time to validate | Weeks, still unproven | Days (leaderboard data is historical proof) |
| Edge source | Our AI vs the market | Piggybacking a proven edge |

### What We Keep From PATS-Poly
| Component | Role in PATS-Copy |
|-----------|-------------------|
| Glint.trade integration | Whale signal confirmation + news feed |
| RSS news scanner + AI classifier | Trade confirmation layer |
| Supabase persistence | Trade/performance storage |
| Paper trading engine | Validation before live |
| Risk management | Position sizing, stop-losses, drawdown protection |

### What We Drop
| Component | Reason |
|-----------|--------|
| Fusion engine (weighted scoring) | No longer the primary decision maker |
| Conviction thresholds / strategy gates | Replaced by leader's trade + confirmation |
| Orderbook WebSocket | Never produced data; unnecessary for copy trading |
| Smart market selection | Leader's market choices are the selection |

---

## 3. User Personas & Use Cases

### Persona 1: Sunny (System Operator)
**Demographics:** Individual trader, $6,300 capital, technical background  
**Goals:** Generate consistent returns on Polymarket without manual analysis  
**Pain Points:** Autonomous signals were too weak; doesn't have time to manually research every market  
**Key Quote:** "I want a high win success rate — I'd rather follow a proven winner than try to beat the market myself"

**Primary Use Cases:**
1. Start the system, let it run 24/7, check dashboard periodically
2. Review which trader is being followed and why
3. See trade history with confirmation reasons
4. Adjust risk parameters (position size, max exposure)

### User Journey
```
System starts → Polls leaderboard → Identifies #1 trader → Monitors their wallet
    → Trader opens position → System detects it → Confirmation check runs
    → News/Glint supports trade? → YES: Copy with proportional size → Track P&L
                                 → NO: Skip, log reason → Wait for next trade
    → #1 trader's score drops below #2 → Rotate to new leader → Continue
```

---

## 4. Feature Requirements

### MoSCoW Prioritization

#### Must Have (MVP — Phase 1)

| ID | Feature | Description | Effort | Dependencies |
|----|---------|-------------|--------|--------------|
| F-001 | Leaderboard Scraper | Poll Polymarket leaderboard page, extract trader addresses, P&L, win rate, trade count, last active timestamp. Refresh every 5 minutes. | M | None |
| F-002 | Trader Scorer | Compute composite score: 40% win rate (30d), 30% profit factor (14d), 15% trade frequency, 15% recency. Rank all tracked traders. | S | F-001 |
| F-003 | Leader Selector | Identify current #1 by composite score. Rotate when #2 exceeds #1 by >5% margin for >1 hour (prevents flapping). | S | F-002 |
| F-004 | Wallet Monitor | Monitor current leader's wallet address via Polymarket Data API or Glint whale tracker. Detect new position opens within 60 seconds. | L | F-003, Glint |
| F-005 | Trade Confirmation | When leader opens a position, run news/Glint check: (a) any supporting news signals in last 2 hours? (b) does direction contradict strong opposing signals? If no strong contradiction, approve. | M | F-004, Glint, AI Classifier |
| F-006 | Copy Executor | Execute approved trades: proportional position sizing (leader's size / leader's portfolio * our portfolio). Paper mode first. | M | F-005 |
| F-007 | Paper Trading Engine | Simulate trades, track P&L, win rate, stop-losses. Reuse PATS-Poly engine with modifications. | S | F-006 |
| F-008 | Position Management | Track open positions. Close when leader closes. Stop-loss at 15%. Max 5 concurrent positions. One per market. | M | F-007 |
| F-009 | Supabase Persistence | Store: traders table, trades table, daily_performance table, leader_history table. | S | F-007 |
| F-010 | Runner & Status Logging | Orchestrate all modules. Log status every 5 minutes: current leader, open trades, P&L, confirmation stats. | M | All above |

#### Should Have (Phase 2 — Post-Validation)

| ID | Feature | Description | Effort | Dependencies |
|----|---------|-------------|--------|--------------|
| F-011 | Live Execution | Switch from paper to real trades via Polymarket CLI. Smart order routing (spread >3¢ = limit order). | M | F-010, funded wallet |
| F-012 | Leader Performance Dashboard | Next.js + Tailwind dashboard: current leader, leaderboard table, trade history, P&L chart, confirmation log. Build in Anti-Gravity. | L | F-009 |
| F-013 | Glint Whale Cross-Reference | When Glint captures a $10K+ whale trade, check if the wallet is one of our tracked leaders. If so, instant copy signal (skip confirmation delay). | M | F-004, Glint |
| F-014 | Multi-Leader Tracking | Track top 5 traders simultaneously. Show which ones are active. Allow manual override to follow a specific trader. | M | F-002, F-003 |

#### Could Have (Phase 3 — Optimization)

| ID | Feature | Description | Effort | Dependencies |
|----|---------|-------------|--------|--------------|
| F-020 | VPS Deployment | Deploy to Oracle Cloud VPS with PM2 for 24/7 operation. | M | F-011 |
| F-021 | Telegram/Discord Alerts | Send notifications on: new trade copied, leader rotation, stop-loss hit, daily summary. | S | F-010 |
| F-022 | Historical Backtesting | Simulate copy strategy against historical leaderboard data to validate before live. | L | F-001, F-002 |
| F-023 | Adaptive Confirmation Threshold | If leader has >80% win rate, reduce confirmation strictness. If <60%, increase it. | S | F-005, F-002 |

#### Won't Have (This Release)
| Feature | Reason | Future Consideration |
|---------|--------|----------------------|
| Autonomous trading (PATS-Poly style) | Proven ineffective as primary strategy | Never — replaced by copy approach |
| X/Twitter direct integration | Glint already captures major tweets; duplicative | Only if Glint fails long-term |
| Multiple exchange support | Polymarket only for now | If successful, extend to Kalshi |
| Mobile app | Web dashboard sufficient for monitoring | Phase 4+ |

---

## 5. Technical Architecture

### System Overview
```
┌─────────────────────────────────────────────────────────────────┐
│                         PATS-Copy Runner                        │
│                                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │ Leaderboard  │  │   Trader     │  │   Leader Selector    │  │
│  │  Scraper     │→ │   Scorer     │→ │ (rotation logic)     │  │
│  │ (5min poll)  │  │ (composite)  │  │                      │  │
│  └──────────────┘  └──────────────┘  └──────────┬───────────┘  │
│                                                  │              │
│                                        ┌─────────▼───────────┐  │
│                                        │   Wallet Monitor    │  │
│                                        │ (current leader)    │  │
│                                        └─────────┬───────────┘  │
│                                                  │              │
│  ┌──────────────────────────────────────┐       │              │
│  │      Confirmation Layer              │◄──────┘              │
│  │  ┌────────┐ ┌───────┐ ┌──────────┐  │                      │
│  │  │ Glint  │ │ News  │ │   AI     │  │                      │
│  │  │Signals │ │Scanner│ │Classifier│  │                      │
│  │  └────────┘ └───────┘ └──────────┘  │                      │
│  └──────────────────┬───────────────────┘                      │
│                     │                                           │
│           ┌─────────▼───────────┐                              │
│           │   Copy Executor     │                              │
│           │ (paper → live)      │                              │
│           └─────────┬───────────┘                              │
│                     │                                           │
│           ┌─────────▼───────────┐                              │
│           │   Risk Manager      │                              │
│           │ (sizing, stops,     │                              │
│           │  exposure limits)   │                              │
│           └─────────┬───────────┘                              │
│                     │                                           │
│           ┌─────────▼───────────┐                              │
│           │     Supabase        │                              │
│           │ (trades, leaders,   │                              │
│           │  performance)       │                              │
│           └─────────────────────┘                              │
└─────────────────────────────────────────────────────────────────┘
```

### Technology Stack
| Layer | Technology | Rationale |
|-------|------------|-----------|
| Runtime | TypeScript / Node.js | Same as PATS-Poly; reuse existing modules |
| Leaderboard Scraping | Puppeteer or direct API | Polymarket leaderboard data extraction |
| Wallet Monitoring | Polymarket Data API + Glint | Detect leader's trades in near-real-time |
| AI Confirmation | Claude Sonnet via Anthropic API | Reuse PATS-Poly classifier for trade confirmation |
| News Feed | Glint.trade WebSocket + RSS | Reuse existing Glint scraper + news scanner |
| Database | Supabase (PostgreSQL) | Reuse existing schema, extend with leaders table |
| Execution | Polymarket CLI (JSON mode) | Reuse PATS-Poly CLI wrapper |
| Dashboard (Phase 2) | Next.js + Tailwind via Anti-Gravity | Rich UI for monitoring; built after backend is proven |
| Deployment | Oracle Cloud VPS + PM2 | Free tier, 24/7 operation |

### Third-Party Integrations
| Service | Purpose | Priority |
|---------|---------|----------|
| Polymarket Leaderboard | Trader performance data | Must |
| Polymarket Data API | Wallet positions + trade history | Must |
| Glint.trade WebSocket | Whale trades + news signals for confirmation | Must |
| Anthropic API (Claude Sonnet) | AI-powered trade confirmation | Must |
| Supabase | Data persistence | Must |
| Polymarket CLI | Trade execution (live mode) | Should (Phase 2) |

### What We Reuse From PATS-Poly
| File | Reuse Strategy |
|------|---------------|
| `src/signals/glint-scraper.ts` | Copy as-is (with TASK-031 reconnect fix) |
| `src/signals/glint-adapter.ts` | Simplify: only need whale detection + news signal pass-through |
| `src/signals/news-scanner.ts` | Copy as-is |
| `src/signals/ai-classifier.ts` | Copy as-is (with retry logic) |
| `src/core/paper-trading.ts` | Modify: remove strategy factory dependency, add leader-trade-based execution |
| `src/core/risk-manager.ts` | Copy as-is |
| `src/data/supabase.ts` | Extend: add leaders table, leader_history table |
| `src/execution/cli-wrapper.ts` | Copy as-is |
| `src/types/index.ts` | Extend: add Leader, LeaderTrade types |
| `src/utils/logger.ts` | Copy as-is |

---

## 6. API & Data Model Specifications

### Polymarket Leaderboard Data Source
The leaderboard is available at `https://polymarket.com/leaderboard`. Data can be extracted via:
- **Option A:** Puppeteer scraping (reliable, handles dynamic rendering)
- **Option B:** Polymarket's GraphQL/REST API (if public endpoints exist for leaderboard data)
- **Option C:** Glint.trade may expose leaderboard-adjacent data

Investigation needed during Phase 1 to determine the best extraction method.

### Polymarket Data API (Wallet Positions)
- **Endpoint:** `https://data-api.polymarket.com/positions?user={address}`
- **Endpoint:** `https://data-api.polymarket.com/trades?user={address}&limit=50`
- These are public endpoints that return position and trade data for any wallet.

### Data Models

#### `leaders` Table
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| id | UUID | Yes | Primary key |
| wallet_address | TEXT | Yes | Polymarket wallet address |
| display_name | TEXT | No | Leaderboard display name |
| composite_score | FLOAT | Yes | Our computed ranking score |
| win_rate_30d | FLOAT | Yes | Win rate over last 30 days |
| profit_factor_14d | FLOAT | Yes | Profit factor over last 14 days |
| trade_count_30d | INT | Yes | Number of trades in last 30 days |
| total_pnl_30d | FLOAT | Yes | Total P&L in last 30 days |
| last_trade_time | TIMESTAMP | Yes | When they last traded |
| is_current_leader | BOOLEAN | Yes | Currently being followed |
| tracked_since | TIMESTAMP | Yes | When we started tracking |
| updated_at | TIMESTAMP | Yes | Last score update |

#### `leader_history` Table
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| id | UUID | Yes | Primary key |
| wallet_address | TEXT | Yes | Leader's wallet |
| became_leader_at | TIMESTAMP | Yes | When they became #1 |
| replaced_at | TIMESTAMP | No | When they lost #1 (null if current) |
| trades_copied | INT | Yes | How many trades we copied during their tenure |
| pnl_during_tenure | FLOAT | Yes | Our P&L while following them |
| reason_replaced | TEXT | No | Why they were replaced (score_drop, inactive, etc.) |

#### `copy_trades` Table
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| id | UUID | Yes | Primary key |
| leader_wallet | TEXT | Yes | Which leader triggered this trade |
| leader_trade_id | TEXT | No | Reference to leader's original trade |
| market_id | TEXT | Yes | Polymarket market ID |
| market_question | TEXT | Yes | Market question text |
| token_id | TEXT | Yes | CLOB token ID |
| outcome | TEXT | Yes | Yes/No |
| side | TEXT | Yes | buy/sell |
| leader_entry_price | FLOAT | Yes | Price the leader entered at |
| our_entry_price | FLOAT | No | Price we entered at (null if paper) |
| our_size | FLOAT | Yes | Our position size in USDC |
| conviction_score | FLOAT | No | Confirmation layer score (if applicable) |
| confirmation_result | TEXT | Yes | approved/vetoed/skipped |
| confirmation_reason | TEXT | No | Why approved or vetoed |
| status | TEXT | Yes | pending/open/closed/stopped/vetoed |
| pnl | FLOAT | No | Realized P&L |
| entry_time | TIMESTAMP | Yes | When we entered |
| exit_time | TIMESTAMP | No | When we exited |
| created_at | TIMESTAMP | Yes | Record creation time |

---

## 7. Security & Compliance

### API Key Management
| Key | Storage | Rotation |
|-----|---------|----------|
| Anthropic API key | `.env` file, never committed | Rotate if exposed |
| Supabase service key | `.env` file | Rotate quarterly |
| Polymarket wallet private key | `.env` file, encrypted at rest | Never rotate (wallet identity) |

### Data Protection
- No user PII stored (system operates for a single user)
- Wallet addresses are public blockchain data
- Trade data stored in Supabase with service-key-only access
- No passwords or authentication tokens for external users

### Risk Controls
- Maximum position size: 2% of portfolio per trade
- Maximum concurrent positions: 5
- Maximum daily loss: 5% of portfolio → halt trading
- Maximum drawdown: 15% → halt trading and alert
- Paper mode required for first 14 days

---

## 8. Performance Requirements

### Timing Requirements
| Operation | Target | Maximum | Why It Matters |
|-----------|--------|---------|----------------|
| Leaderboard poll | Every 5 min | 10 min | Score freshness |
| Leader trade detection | <60 seconds | 120 seconds | Copy timing gap |
| Confirmation check | <10 seconds | 30 seconds | Minimize price slippage |
| Trade execution | <5 seconds | 15 seconds | Market order fill speed |
| Total copy latency | <75 seconds | 165 seconds | Price may move significantly beyond this |

### Scalability
| Metric | Launch | 3 Months |
|--------|--------|----------|
| Traders tracked | 10-20 | 50 |
| Concurrent positions | 5 | 10 |
| Data storage | <1 GB | <5 GB |
| API calls/day | ~300 (classifier) | ~500 |

### Availability
- Target uptime: 95% (system should run 24/7 with occasional restarts for updates)
- Glint reconnect resilience: auto-recover within 2 minutes
- News scanner resilience: retry on ECONNRESET (already implemented)

---

## 9. Development Timeline & Milestones

### Phase 1: Backend MVP (Week 1) — Build in Claude Chat
| Task | Description | Effort | Dependencies |
|------|-------------|--------|--------------|
| T-001 | Create new repo `pats-copy`, scaffold TypeScript project | S | None |
| T-002 | Copy reusable modules from PATS-Poly (Glint, news, classifier, risk, CLI, Supabase) | M | T-001 |
| T-003 | Build leaderboard scraper (Puppeteer or API) | L | T-001 |
| T-004 | Build trader scorer (composite score formula) | S | T-003 |
| T-005 | Build leader selector (rotation logic with hysteresis) | S | T-004 |
| T-006 | Build wallet monitor (detect leader's new positions) | L | T-005 |
| T-007 | Build confirmation layer (news + Glint check before copy) | M | T-006, T-002 |
| T-008 | Build copy executor (paper mode) | M | T-007 |
| T-009 | Build runner (orchestrator + status logging) | M | T-008 |
| T-010 | Supabase schema migration (leaders, leader_history, copy_trades) | S | T-009 |
| T-011 | End-to-end paper trading validation | M | T-010 |

### Phase 2: Paper Validation (Weeks 2-3)
| Task | Description |
|------|-------------|
| T-012 | Run paper mode for 14 days |
| T-013 | Analyze results: win rate, P&L, leader rotation frequency, confirmation accuracy |
| T-014 | Tune confirmation thresholds based on data |
| T-015 | Fix bugs discovered during extended run |

### Phase 3: Live Execution (Week 4)
| Task | Description |
|------|-------------|
| T-016 | Fund Polymarket wallet ($1,000 initial) |
| T-017 | Enable live execution module |
| T-018 | Run live for 14 days at conservative sizing |
| T-019 | Scale to full capital if results validate |

### Phase 4: Dashboard — Build in Anti-Gravity (Week 5-6)
| Task | Description |
|------|-------------|
| T-020 | Design dashboard wireframes |
| T-021 | Build Next.js app with Supabase connection |
| T-022 | Leaderboard view: ranked traders, scores, current leader highlighted |
| T-023 | Trade history: all copied trades with confirmation reasons |
| T-024 | P&L chart: daily/weekly/monthly performance |
| T-025 | Leader timeline: who was followed when, performance during each tenure |
| T-026 | Deploy to Vercel |

---

## 10. Success Metrics & KPIs

### Primary Metrics
| Metric | Definition | Target | Timeline |
|--------|------------|--------|----------|
| Win Rate | Closed trades with P&L > 0 / total closed trades | >65% | 30 days |
| Monthly Return | Net P&L / starting balance | >8% | Monthly |
| Copy Success Rate | Trades that match leader's outcome / total copies | >60% | 30 days |

### Secondary Metrics
| Category | Metric | Target |
|----------|--------|--------|
| Speed | Average copy latency | <90 seconds |
| Confirmation | Veto accuracy (vetoed trades that would have lost) | >50% |
| Leader quality | Average leader win rate | >65% |
| Uptime | System running hours / total hours | >95% |
| Cost | API costs (Anthropic + Supabase) | <$30/month |

### Monitoring
| What | How | Alert Threshold |
|------|-----|-----------------|
| System health | Status log every 5 min | No log for >15 min |
| Glint connection | Connected/disconnected state | Disconnected >5 min |
| Daily P&L | Supabase daily_performance | Loss >3% in a day |
| Leader rotation | leader_history table | >3 rotations in a day (instability) |
| Trade execution | copy_trades table | >3 consecutive vetoes (possible issue) |

---

## 11. Risks & Mitigation Strategies

### Technical Risks
| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Leaderboard data not accessible via API | Medium | High | Fallback to Puppeteer scraping; investigate Polymarket's GraphQL API |
| Copy latency too high (>2 min) | Medium | High | Use Glint whale tracker for instant detection if leader is a whale; poll Data API frequently |
| Leader's edge is already priced in by the time we copy | Medium | Medium | Confirmation layer filters out trades where price has already moved significantly |
| Glint drops again | High | Medium | TASK-031 reconnect fix (page refresh + liveness watchdog) — already built |
| Leader goes on losing streak | Medium | Medium | Automatic rotation when score drops; stop-loss on individual trades |

### Business Risks
| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Front-running by the leader (they know they're being copied) | Low | Medium | Leaderboard following is public; unlikely they'd sabotage their own track record |
| Polymarket changes leaderboard structure | Low | High | Modular scraper design; quick to adapt |
| Low trade frequency from leader | Medium | Low | Track multiple leaders; alert if no trades for 48 hours |

### Assumptions
- Polymarket leaderboard data is publicly accessible and can be scraped or API'd
- Polymarket Data API (`data-api.polymarket.com`) remains available for wallet position queries
- Top leaderboard traders maintain their edge for periods of 2+ weeks (enough to copy profitably)
- Copy latency of <2 minutes does not significantly erode the leader's edge on prediction markets (which move slowly compared to financial markets)

---

## 12. Out of Scope

### Explicitly Excluded
| Feature/Capability | Reason | Future Consideration |
|--------------------|--------|----------------------|
| Autonomous signal-based trading | Proven ineffective as primary strategy in PATS-Poly | Never — copy approach replaces this |
| X/Twitter direct integration | Glint captures major tweets already; adding X is duplicative | Only if Glint stops capturing tweets |
| Multi-exchange support | Polymarket only for now | Phase 5+ if successful |
| Mobile app | Web dashboard sufficient | Phase 5+ |
| Orderbook WebSocket | Never produced data in PATS-Poly; not needed for copy trading | Never |
| Social sentiment analysis | Adds complexity without clear win-rate improvement | Phase 4 if data supports it |

### Deferred Items
| Item | Target Phase | Dependencies |
|------|--------------|--------------|
| Live execution | Phase 3 | 14-day paper validation |
| Dashboard UI | Phase 4 | Anti-Gravity build |
| VPS deployment | Phase 4 | Proven stability |
| Telegram alerts | Phase 4 | Nice-to-have |
| Backtesting engine | Phase 5 | Historical data collection |

---

## 13. Appendix

### Glossary
| Term | Definition |
|------|------------|
| Composite Score | Weighted ranking formula: 40% win rate (30d) + 30% profit factor (14d) + 15% trade frequency + 15% recency |
| Profit Factor | Total winning P&L / Total losing P&L. A value >2.0 is excellent. |
| Confirmation Layer | News + Glint intelligence check that validates a leader's trade before we copy it |
| Leader Rotation | Switching from one leader to another when their composite score drops below the next best |
| Hysteresis | Requiring the new leader to exceed the current by >5% for >1 hour before rotating, preventing rapid flapping |
| Copy Latency | Time between leader's trade and our copy execution |
| Veto | When the confirmation layer rejects a leader's trade due to contradicting intelligence |

### Carry-over from PATS-Poly
| Lesson | Application |
|--------|-------------|
| ECONNRESET kills classifier | Retry logic with exponential backoff (already built) |
| Glint WS drops after ~4-8 hours | Page-refresh reconnect + liveness watchdog (TASK-031) |
| Market selection matters | Leader's choices replace our market selection entirely |
| Paper mode thresholds matter | Separate paper preset with lower gates for validation |
| WS orderbook data never worked | Don't depend on it; drop it from the architecture |

### Document History
| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | 2026-03-17 | Claude / Sunny | Initial draft — pivot from PATS-Poly to copy-the-leader |
