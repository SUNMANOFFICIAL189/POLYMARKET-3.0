/**
 * Execution-cost model — paper-vs-live fidelity Tier 1 (2026-06-28).
 *
 * Makes paper fills carry the spread/slippage and Polymarket taker fees that
 * LIVE trading actually incurs, so paper P&L is an honest rehearsal of live
 * rather than a frictionless best case.
 *
 * FEE model verified against docs.polymarket.com/trading/fees (2026-06-28):
 *   fee = shares * feeRate * p * (1-p)   (USDC, symmetric, peaks at p=0.5)
 *   - MAKERS (limit fills) pay 0; only TAKERS pay.
 *   - GEOPOLITICS / world-events markets are completely fee-free.
 *   - Per-category taker feeRate: crypto 0.07 | sports 0.03 |
 *     finance/politics/tech/mentions 0.04 | economics/culture/weather/other 0.05.
 *
 * Deliberate, documented approximations (conservative = errs toward paper
 * looking WORSE, which is the goal of a faithful rehearsal):
 *   - We model TAKER fees (assume market orders). Real cost is LOWER when the
 *     bot's smartOrder routes to a maker (limit) fill on wide spreads.
 *   - Geopolitics is keyed off pipelineId (StarMaster trades geopolitics/world
 *     events). The bot's categoriser has no 'geopolitics' label, so a SIGNAL
 *     trade on a market Polymarket classifies as geopolitics may be slightly
 *     over-charged (small + conservative).
 *   - Resolution/settlement closes (price at 0/1) incur NO exit slippage and NO
 *     exit-leg fee — they are on-chain redemptions, not taker trades.
 *
 * All behaviour is env-toggleable so it can be tuned or reverted without code:
 *   PAPER_SLIPPAGE_ENABLED=false  → no slippage (old behaviour)
 *   PAPER_FEES_ENABLED=false      → no fees
 *   SLIP_PCT_* / -                → tune the per-band slippage
 */

import { categoriseMarket, type MarketCategory } from '../signals/market-categoriser.js';
import type { PipelineId } from '../types/index.js';

function envNum(key: string, dflt: number): number {
  const v = process.env[key];
  const n = v !== undefined ? Number(v) : NaN;
  return Number.isFinite(n) ? n : dflt;
}

/**
 * Effective one-side slippage (half-spread + impact) as a FRACTION of price,
 * by price band. The previous model was a price-AGNOSTIC uniform 0.1-0.5%, far
 * too low for cheap/thin markets (a 1-2c spread on a 5c market is 20-40% of
 * price). Deterministic (no RNG) so paper runs are reproducible.
 */
export function slippagePctForPrice(price: number): number {
  const p = Math.min(Math.max(price, 0.001), 0.999);
  if (p < 0.10) return envNum('SLIP_PCT_LONGSHOT', 0.04); // cheap/thin: 4%
  if (p < 0.30) return envNum('SLIP_PCT_LOW', 0.015);     // 1.5%
  if (p < 0.70) return envNum('SLIP_PCT_MID', 0.006);     // 0.6%
  if (p < 0.90) return envNum('SLIP_PCT_HIGH', 0.004);    // 0.4%
  return envNum('SLIP_PCT_NEARCERT', 0.006);              // near-cert thin: 0.6%
}

/** Adverse ENTRY slippage: a BUY crosses up to the ask, a SELL down to the bid. */
export function applyEntrySlippage(basePrice: number, side: 'buy' | 'sell'): number {
  if (process.env.PAPER_SLIPPAGE_ENABLED === 'false') return basePrice;
  const s = basePrice * slippagePctForPrice(basePrice);
  const out = side === 'buy' ? basePrice + s : basePrice - s;
  return Math.min(Math.max(out, 0.0001), 0.9999);
}

/**
 * Adverse EXIT slippage. Closing a BUY = SELLING into the bid (receive LESS →
 * lower exit). Closing a SELL = BUYING back at the ask (pay MORE → higher exit).
 * `side` is the ORIGINAL position side. Settlement closes (price at 0/1) get no
 * slippage — handled by the caller via isSettlementPrice().
 */
export function applyExitSlippage(midPrice: number, side: 'buy' | 'sell'): number {
  if (process.env.PAPER_SLIPPAGE_ENABLED === 'false') return midPrice;
  const s = midPrice * slippagePctForPrice(midPrice);
  const out = side === 'buy' ? midPrice - s : midPrice + s;
  return Math.min(Math.max(out, 0), 1);
}

/** A close at 0/1 is an on-chain redemption (no spread, no taker fee), not a trade. */
export function isSettlementPrice(price: number): boolean {
  return price <= 0.001 || price >= 0.999;
}

// Polymarket taker fee rate by the bot's MarketCategory (docs verified 2026-06-28).
// economics/culture/weather/other → 0.05, mapped onto the bot's 'other'.
const TAKER_FEE_RATE: Record<MarketCategory, number> = {
  crypto: 0.07,
  sports: 0.03,
  politics: 0.04,
  finance: 0.04,
  other: 0.05,
};

function legFee(shares: number, price: number, rate: number): number {
  const p = Math.min(Math.max(price, 0), 1);
  return shares * rate * p * (1 - p);
}

/**
 * Round-trip Polymarket taker fee (entry leg + exit leg) in USDC.
 * Geopolitics pipeline = fee-free. Exit leg = 0 when the close is a settlement
 * redemption (exitIsSettlement). Returns a 2-dp rounded dollar figure.
 */
export function tradeFees(
  shares: number,
  entryPrice: number,
  exitPrice: number,
  question: string,
  pipelineId: PipelineId | undefined,
  exitIsSettlement: boolean,
): number {
  if (pipelineId === 'geopolitics') return 0;
  if (process.env.PAPER_FEES_ENABLED === 'false') return 0;
  const rate = TAKER_FEE_RATE[categoriseMarket(question)] ?? 0.05;
  if (rate === 0) return 0;
  const entryLeg = legFee(shares, entryPrice, rate);
  const exitLeg = exitIsSettlement ? 0 : legFee(shares, exitPrice, rate);
  return Math.round((entryLeg + exitLeg) * 100) / 100;
}
