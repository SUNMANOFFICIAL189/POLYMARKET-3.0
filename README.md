# PATS-Copy

Polymarket Autonomous Trading System — Copy-the-Leader strategy with news/whale confirmation.

## Strategy
1. Track Polymarket top traders via leaderboard
2. Identify current #1 by composite score (win rate + profit factor + activity + recency)
3. Monitor their wallet for new positions
4. Confirm each trade against news/Glint intelligence before copying
5. Rotate to new leader when performance shifts

## Quick Start
```bash
npm install
cp .env.example .env
npm run build
npm run paper
```

## Docs
- [PRD](docs/PRD.md) — Full product requirements
- [Context](docs/CONTEXT.md) — Lessons from PATS-Poly
- [Build Guide](docs/BUILD_GUIDE.md) — Implementation plan
