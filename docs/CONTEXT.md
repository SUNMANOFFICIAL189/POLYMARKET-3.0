# PATS-Copy — Context & Lessons from PATS-Poly

## Why We Pivoted
Autonomous signal fusion conviction scores never exceeded 50. The fusion formula with 3 of 5 components stuck at default (50) couldn't produce high conviction. News/whale intelligence works as a CONFIRMATION tool but poorly as a PRIMARY signal.

---

## Critical Technical Lessons

### Polymarket CLI
- Binary: `polymarket -o json markets list --active true --limit 100`
- `--order` flag conflicts with `--active` — sort client-side
- `outcomes`, `outcomePrices`, `clobTokenIds` are JSON STRINGS — must `JSON.parse()` each
- `clobTokenIds` produces `0x...` hex strings (66 chars)
- Filter out micro-bets: `question.match(/Up or Down.*\d+:\d+[AP]M/i)`
- Markets need: volume >= 100, prices 0.01-0.99, tokenId.length > 10

### Polymarket Data API (wallet monitoring)
- `https://data-api.polymarket.com/positions?user={address}` — public, no auth
- `https://data-api.polymarket.com/trades?user={address}&limit=50` — public, no auth
- These are KEY for monitoring leader trades

### CLOB WebSocket
- URL: `wss://ws-subscriptions-clob.polymarket.com/ws/market`
- Text-level PING every 10s, server responds PONG
- Subscription: `{ assets_ids, type:'market', operation:'subscribe', custom_feature_enabled:true }`
- **NEVER GOT ORDERBOOK DATA** — server returns `[]`. Don't depend on this.

### Glint.trade
- WS: `wss://api.glint.trade/ws`
- Auth: Google OAuth via Privy, userDataDir persists session
- First run: `GLINT_HEADLESS=false` for manual login
- Frames: `{ data, room }` — rooms: feed, whale_trades, health_check, red_alerts, flight_events
- Feed: `data.news.headline`, `data.tweet.body`, `data.telegram.text`
- Whales: `data.wallet`, `data.side`, `data.amount`, `data.market.slug/question`
- Health check pings every 5s — count for liveness
- **DROPS AFTER 4-8 HOURS** — page-refresh reconnect + liveness watchdog built but needs validation
- Source tiers: Bloomberg/Reuters = T1 (+10), CoinDesk/CNN = T2 (+5), else T3

### AI Classifier (Claude Sonnet)
- Model: `claude-sonnet-4-5-20250929`, max_tokens: 512
- Strip markdown fences before JSON.parse
- Regex fallback for truncated JSON
- Retry: 3 attempts, 1s/2s/4s exponential backoff on ECONNRESET/ETIMEDOUT
- Cost: ~$0.003/call

### Supabase
- CHECK constraint must include 'paper' as valid risk_level
- Migration SQL needed for new tables

### Environment
- `.env` RISK_LEVEL overrides paper preset — use PAPER_MODE=true to force
- Puppeteer v24: headless is boolean, not string 'new'
- macOS: no `grep -P`, use `grep -oE`
- Log with tee: `npm run paper 2>&1 | tee ~/Desktop/pats-copy.log`

---

## What Worked in PATS-Poly
1. Glint whale detection — captured real $10K-$50K trades
2. AI classifier with retry — 0 ECONNRESET failures after fix
3. Paper trading engine with stop-losses
4. Supabase persistence
5. check-status.sh for monitoring

## What Failed
1. Autonomous conviction scoring — never exceeded 50
2. CLOB WS orderbook — zero data received
3. Market selection — picked meme/sports markets
4. Glint reconnection — drops after hours (fix built, not validated overnight)
5. Fusion engine — 3/5 components defaulting to 50 makes math impossible

---

## Reusable Modules

Fetch from `SUNMANOFFICIAL189/pats-poly` main branch:

| File | Modify? |
|------|--------|
| src/signals/glint-scraper.ts | No — use with reconnect fix |
| src/signals/glint-adapter.ts | Simplify for confirmation |
| src/signals/news-scanner.ts | No |
| src/signals/ai-classifier.ts | Change prompt for confirmation |
| src/core/risk-manager.ts | No |
| src/data/supabase.ts | Extend with new tables |
| src/execution/cli-wrapper.ts | No |
| src/utils/logger.ts | Change log filename |
| src/types/index.ts | Extend with Leader types |
| package.json | Rename, keep deps |
| tsconfig.json | Copy as-is |
