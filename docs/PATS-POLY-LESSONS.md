# Lessons Learned from PATS-Poly (Sessions 1-6)

Every lesson below was discovered through actual failures. Do NOT repeat these mistakes.

## Polymarket CLI Quirks
- CLI returns `outcomes`, `outcomePrices`, `clobTokenIds` as **JSON strings** that must be `JSON.parse()`'d
- `--active true` filter works; `--order` flag conflicts with `--active` — sort client-side by volume
- Token IDs from `clobTokenIds` are 66-char hex strings starting with `0x` (e.g., `0xe0edf18a571908bae...`)
- Micro-bet "Up or Down" 5-min markets should be filtered: `/Up or Down.*\d+:\d+[AP]M/i`
- Markets need vol >= $100 and prices between 0.01-0.99 to be tradeable

## Glint.trade WebSocket Protocol
- URL: `wss://api.glint.trade/ws`
- All frames: `{ data: ..., room: "feed"|"whale_trades"|"health_check"|"red_alerts"|"flight_events" }`
- Feed signals: `data.news.headline`, `data.tweet.body`, `data.telegram.text`
- Whale trades: `data.wallet`, `data.side`, `data.amount`, `data.market.slug/question`
- Health check pings arrive every ~5 seconds (use for liveness detection)
- Auth: Google OAuth via Privy — stored in Puppeteer `userDataDir`, NOT cookies
- `cookies.length === 0` is normal — auth persists through browser profile
- First run requires `GLINT_HEADLESS=false` for manual Google login
- WS drops after 4-8 hours — MUST implement page-refresh reconnect + liveness watchdog
- Three-layer reconnect: page refresh (primary) -> browser restart (after 5 failures) -> liveness watchdog (catches silent death)

## AI Classifier (Claude Sonnet API)
- Must strip markdown code fences before JSON.parse (triple backtick json)
- Prompt must explicitly request raw JSON, no markdown
- ECONNRESET errors kill the scanner permanently without retry logic
- Solution: exponential backoff (3 attempts, 1s/2s/4s delays), catch per-headline not per-batch
- `max_tokens: 512` prevents response truncation
- Regex fallback extracts partial data from truncated responses

## Supabase
- CHECK constraint on `trades.risk_level` must include `'paper'` as valid value
- Service key required (not anon key) for server-side inserts
- Schema needs migration when adding new risk levels or tables

## Environment & Config
- `PAPER_MODE=true` in `.env` must force-override `RISK_LEVEL` env var
- Always `git pull && npm run build` before running — multiple sessions ran stale code
- Use `tee` for log capture: `npm run paper 2>&1 | tee ~/Desktop/pats-copy.log`
- macOS grep uses `-oE` not `-P` (GNU only) for regex extraction

## General Development Principles
- Self-verify code before returning to user — compile check, logic trace, edge cases
- Log first N raw messages of any new protocol for format debugging
- Don't add aggressive filters without logging what gets filtered
- The WS token hex filter regression (`/^[0-9a-fA-F]+$/` rejected `0x...` prefixed IDs) wasted an entire overnight run
- Per-market position dedup prevents opening 2 positions on the same market
- TypeScript with ES2022 target, NodeNext module resolution
- Zod for config validation catches issues early
