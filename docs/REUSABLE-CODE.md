# Reusable Code from PATS-Poly

All source code lives in `SUNMANOFFICIAL189/pats-poly` on the `main` branch.

## Files to COPY AS-IS

### `src/signals/glint-scraper.ts` (20KB)
Glint.trade WebSocket interception via Puppeteer CDP. Captures news signals + whale trades.
Has 3-layer reconnect: page refresh -> browser restart -> liveness watchdog.
Emits: `signal` (GlintSignalEvent), `whale` (GlintWhaleEvent), `connected`, `disconnected`.

### `src/signals/news-scanner.ts`
RSS feed scanner (NPR, Politico, BBC, CoinDesk, CNN). Polls every 30s, deduplicates by headline hash.
Emits: `news` events with `{ headline, body, source, url, timestamp }`.

### `src/signals/ai-classifier.ts`
Claude Sonnet API classifier with exponential backoff retry (3 attempts).
Returns: `{ impactScore: 0-100, direction: yes|no|neutral, matchedMarkets: string[], reasoning, category }`.

### `src/core/risk-manager.ts`
Position sizing, exposure limits, stop-losses, drawdown protection (20% circuit breaker).
Methods: `checkTrade()`, `calculatePnl()`, `checkStopLoss()`, `getPortfolioRisk()`.

### `src/execution/cli-wrapper.ts` (8KB)
Polymarket CLI wrapper. Key functions: `listMarkets()`, `getMarket()`, `marketOrder()`, `limitOrder()`, `smartOrder()` (spread >3c = limit at midpoint).
Handles JSON string field parsing for outcomes/prices/tokenIds.

### `src/data/supabase.ts`
Supabase client: `initSupabase()`, `insertTrade()`, `updateTrade()`, `upsertDailyPerformance()`.
Needs extension for leader tables.

### `src/utils/logger.ts`
Winston logger with timestamp formatting.

### `src/types/index.ts` (7KB)
TypeScript types: Market, TokenInfo, Trade, Position, RiskLevel, DailyPerformance, etc.
Risk presets: paper (conv>=40, whales>=0), conservative (conv>=65, whales>=2), moderate, aggressive.
Needs extension: Leader, LeaderTrade, CopyTrade types.

## Files to SIMPLIFY and carry over

### `src/signals/glint-adapter.ts`
Maps Glint events to internal signal format. For PATS-Copy, simplify to:
- Whale wallet matching (check if whale is our current leader)
- News signal pass-through for confirmation layer

### `src/core/paper-trading.ts`
Paper trade execution engine. Modify to:
- Remove strategy factory dependency
- Add leader-trade-based execution (copy instead of autonomous)
- Keep: position tracking, P&L calculation, stop-losses, day rollover

### `src/core/config.ts`
Config loader with risk presets. Keep risk presets, drop fusion-specific config.
Add: leaderboard polling interval, confirmation threshold, rotation hysteresis settings.

## Files to DROP (not needed)

- `src/signals/fusion-engine.ts` — signal fusion, replaced by leader's trade
- `src/signals/orderbook-monitor.ts` — never produced data, not needed for copy
- `src/core/strategy-factory.ts` — conviction gates, replaced by leader + confirmation
- `src/signals/whale-monitor.ts` — DIY whale polling, superseded by Glint

## NEW Files to BUILD

- `src/leaderboard/scraper.ts` — poll Polymarket leaderboard, extract trader data
- `src/leaderboard/scorer.ts` — composite score: 40% win rate + 30% profit factor + 15% frequency + 15% recency
- `src/leaderboard/selector.ts` — leader selection with rotation hysteresis
- `src/monitor/wallet-monitor.ts` — detect current leader's new positions via Data API
- `src/confirmation/confirmation-layer.ts` — news + Glint check before copying
- `src/execution/copy-executor.ts` — mirror leader's trades with proportional sizing
- `src/core/runner.ts` — orchestrate everything (new, not carried over from pats-poly)

## package.json Dependencies

```json
{
  "dependencies": {
    "ws": "^8.16.0",
    "puppeteer": "^24.0.0",
    "zod": "^3.22.0",
    "@supabase/supabase-js": "^2.39.0",
    "rss-parser": "^3.13.0",
    "winston": "^3.11.0"
  },
  "devDependencies": {
    "typescript": "^5.3.0",
    "tsx": "^4.7.0",
    "@types/node": "^20.10.0",
    "@types/ws": "^8.5.0"
  }
}
```

## tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```
