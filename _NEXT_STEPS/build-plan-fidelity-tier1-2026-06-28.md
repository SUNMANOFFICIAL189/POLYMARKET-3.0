# PATS Fidelity Tier 1 — Build Plan (2026-06-28)

Goal: make PAPER mode a faithful rehearsal of LIVE so go-live holds no surprises. From the 10-agent adversarially-verified fidelity audit (memory `project_pats_paper_live_fidelity_2026_06_27.md`).
Branch `fidelity/paper-live-tier1` · rollback tag `pre-fidelity-tier1-2026-06-28` (on c81438c).
**Deploy is GATED on: proof-check (adversarial review) + Hetzner snapshot + 10-min post-deploy health check.** Expect paper P&L to DROP after this lands — that is it becoming honest, not a regression.

## Fee refinement (VERIFIED vs docs.polymarket.com/trading/fees, 2026-06-28)
Polymarket fee = `shares × feeRate × p × (1−p)` (peaks at p=0.5, ~0 at extremes). **Makers (limit fills) pay 0. Geopolitics/world-events markets are FEE-FREE.** Taker rates: crypto 0.07 · sports 0.03 · finance/politics/tech/mentions 0.04 · economics/culture/weather/other 0.05.
→ So the **fee fix is small + category-aware** (geo=0, keyed off `pipelineId` because the bot's categoriser has no 'geopolitics' label; conservative taker assumption). **Spread/slippage is the real Tier-1 lever, NOT fees.** The audit's original "flat 2%" was wrong (verifier-corrected).

## Batches (each = separate commit; don't bundle risky fixes)
- **[DONE] 1a — execution realism.** `src/core/execution-costs.ts` (new) + `src/core/paper-trading.ts`: deterministic price-tier slippage on entry AND exit (replaces price-agnostic uniform 0.1-0.5%), round-trip category-aware taker fee (geo=0), settlement-close guard (no slippage/fee on 0/1 redemptions). Env toggles: `PAPER_SLIPPAGE_ENABLED`, `PAPER_FEES_ENABLED`, `SLIP_PCT_*`. tsc clean.
- **[DONE 87a1b2b] 1b — no fabricated prices.** TTL + both leader-close 0.5 fallbacks replaced + `getCurrentPrice` −1 guarded → DEFER the close when no real price; never invent 0.5.
- **[ ] 2 — wire signal+copy RM gates.** Mirror geopolitics (`updateBalance`/`setOpenTrades`/`updateDailyPnl`) so per-pipeline drawdown/exposure/daily/max-loss track real balance. **NOTE: entangled with the capital-partition fix (Tier-2 e) — do them TOGETHER; verifier rated real impact LOW today (global RM backstops; signal sizing sits below the frozen caps; only the per-pipeline drawdown breaker is genuinely uncovered). Higher-risk surgery → proof-check first.**
- **3 — geopolitics restart persistence (ACTIVE, geo funded):** [DONE 1b4dd3f] **3.1** deduct reserved capital after `hydrateOpenTrades` · [ ] **3.2** persist per-pipeline `peakBalance` (currently signal-only + inert) · [ ] **3.3** persist + prune-on-load `stopLossCooldown` / `recentBuysByWallet` (48h consensus) / `recentlyClosedMarkets`.

## Out of scope here (Tier 2/3, or rejected)
Capital partition warn→throw + stale-comment (T2). Non-fill modeling (T2). Honest-restart-balance / realized-vs-unrealized reporting (T2). Gas + latency-lag + copy-revival gates (T3). The "2% fee", "signal-close-never-persisted", "global-cap-too-tight" findings were verifier-killed. Local `.env` plaintext keys = gitignored, not a leak (L14 keychain item, low urgency).
