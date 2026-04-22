import { logger } from '../utils/logger.js';
import { sendTelegramAlert } from '../utils/telegram.js';
import type { CopyTrade } from '../types/index.js';

const GAMMA_API_BASE = 'https://gamma-api.polymarket.com';

interface MarketStatus {
  slug: string;
  closed: boolean;
  active: boolean;
  acceptingOrders: boolean;
  endDate: string | null;
  outcomePrices: string; // JSON string like "[\"0.3\", \"0.7\"]"
  outcomes: string; // JSON string like "[\"Yes\", \"No\"]"
}

interface PositionCloseRequest {
  marketId: string;
  reason: string;
  exitPrice: number;
}

type ClosePositionFn = (marketId: string, exitPrice: number, reason: string) => Promise<CopyTrade | null>;
type GetOpenTradesFn = () => CopyTrade[];
type PersistCloseFn = (trade: CopyTrade) => Promise<void>;

/**
 * PositionLifecycleManager
 *
 * Runs periodic checks to auto-close positions that should no longer be open:
 * 1. Market Resolution — checks Polymarket API for resolved/closed markets
 * 2. Position TTL — closes positions older than configurable max age
 * 3. Stop-Loss — closes positions that have moved against us past threshold
 *
 * This is the permanent fix for "stale trades" — positions that stay open
 * after markets resolve because the bot only relied on leader-exit detection.
 */
export class PositionLifecycleManager {
  private resolutionTimer: ReturnType<typeof setInterval> | null = null;
  private ttlTimer: ReturnType<typeof setInterval> | null = null;
  private stopLossTimer: ReturnType<typeof setInterval> | null = null;

  private readonly RESOLUTION_CHECK_MS: number;
  private readonly TTL_CHECK_MS: number;
  private readonly STOP_LOSS_CHECK_MS: number;
  private readonly MAX_POSITION_AGE_MS: number;
  private readonly STOP_LOSS_PCT: number;

  private closePosition: ClosePositionFn;
  private getOpenTrades: GetOpenTradesFn;
  private persistClose: PersistCloseFn;

  // Cache to avoid hammering Gamma API for same market
  private marketStatusCache: Map<string, { status: MarketStatus; fetchedAt: number }> = new Map();
  private readonly CACHE_TTL_MS = 5 * 60 * 1000; // 5 min cache

  constructor(opts: {
    closePosition: ClosePositionFn;
    getOpenTrades: GetOpenTradesFn;
    persistClose: PersistCloseFn;
    resolutionCheckMs?: number;
    ttlCheckMs?: number;
    stopLossCheckMs?: number;
    maxPositionAgeMs?: number;
    stopLossPct?: number;
  }) {
    this.closePosition = opts.closePosition;
    this.getOpenTrades = opts.getOpenTrades;
    this.persistClose = opts.persistClose;

    this.RESOLUTION_CHECK_MS = opts.resolutionCheckMs ?? 5 * 60 * 1000;   // 5 min
    this.TTL_CHECK_MS = opts.ttlCheckMs ?? 30 * 60 * 1000;                // 30 min
    this.STOP_LOSS_CHECK_MS = opts.stopLossCheckMs ?? 60 * 1000;           // 60 sec
    this.MAX_POSITION_AGE_MS = opts.maxPositionAgeMs ?? 24 * 60 * 60 * 1000; // 24 hours (was 48h — too long for sports markets that resolve in hours)
    this.STOP_LOSS_PCT = opts.stopLossPct ?? 0.30; // 30% loss = close
  }

  start(): void {
    logger.info(`PositionLifecycleManager starting — resolution every ${this.RESOLUTION_CHECK_MS / 1000}s, TTL every ${this.TTL_CHECK_MS / 1000}s, stop-loss every ${this.STOP_LOSS_CHECK_MS / 1000}s`);

    // Run initial checks after a short delay (let bot hydrate first)
    setTimeout(() => this.checkResolutions(), 30_000);
    setTimeout(() => this.checkTTL(), 60_000);

    this.resolutionTimer = setInterval(() => this.checkResolutions(), this.RESOLUTION_CHECK_MS);
    this.ttlTimer = setInterval(() => this.checkTTL(), this.TTL_CHECK_MS);
    this.stopLossTimer = setInterval(() => this.checkStopLosses(), this.STOP_LOSS_CHECK_MS);
  }

  stop(): void {
    if (this.resolutionTimer) clearInterval(this.resolutionTimer);
    if (this.ttlTimer) clearInterval(this.ttlTimer);
    if (this.stopLossTimer) clearInterval(this.stopLossTimer);
    logger.info('PositionLifecycleManager stopped');
  }

  /**
   * Layer 1: Market Resolution Checker
   * Queries Gamma API for each open position's market. If market is closed/resolved,
   * close our position at the settlement price.
   */
  private async checkResolutions(): Promise<void> {
    const openTrades = this.getOpenTrades();
    if (openTrades.length === 0) return;

    let closedCount = 0;
    for (const trade of openTrades) {
      const marketId = trade.marketId ?? '';
      try {
        const status = await this.fetchMarketStatus(marketId);
        if (!status) {
          const ageH = trade.entryTime
            ? ((Date.now() - new Date(trade.entryTime).getTime()) / 3600000).toFixed(1)
            : '?';
          logger.debug(`PositionLifecycle: Skipping resolution check for "${marketId.slice(0, 30)}" (${ageH}h old) — market not found on Gamma`);
          continue;
        }

        if (status.closed && !status.acceptingOrders) {
          // Market resolved — determine settlement price
          const exitPrice = this.getSettlementPrice(status, trade.outcome);
          if (exitPrice < 0) { logger.warn(`PositionLifecycle: Skipping close for "${marketId}" — could not determine settlement price`); continue; }
          logger.info(`PositionLifecycle: Market "${marketId}" RESOLVED. Outcome prices: ${status.outcomePrices}. Our outcome: ${trade.outcome}. Exit price: ${exitPrice}`);

          const closed = await this.closePosition(marketId, exitPrice, 'market_resolved');
          if (closed) {
            closedCount++;
            await this.persistClose(closed);
            const pnl = closed.pnl?.toFixed(2) ?? 'n/a';
            logger.info(`PositionLifecycle: Auto-closed resolved position on "${marketId}" — pnl: $${pnl}`);
            sendTelegramAlert(`📊 <b>MARKET RESOLVED</b>\n${marketId.slice(0, 50)}\nP&L: $${pnl}`);
          }
        }
      } catch (err) {
        logger.warn(`PositionLifecycle: Resolution check failed for ${marketId}: ${err}`);
      }
    }

    if (closedCount > 0) {
      logger.info(`PositionLifecycle: Resolution sweep closed ${closedCount} position(s)`);
    }
  }

  /**
   * Layer 2: Position TTL Checker
   * Any position older than MAX_POSITION_AGE_MS gets auto-closed.
   */
  private async checkTTL(): Promise<void> {
    const openTrades = this.getOpenTrades();
    if (openTrades.length === 0) return;

    const now = Date.now();
    let closedCount = 0;

    for (const trade of openTrades) {
      const marketId = trade.marketId ?? '';
      const entryTime = new Date(trade.entryTime ?? '').getTime();
      if (isNaN(entryTime)) continue;

      const ageMs = now - entryTime;
      if (ageMs > this.MAX_POSITION_AGE_MS) {
        logger.info(`PositionLifecycle: Position "${marketId}" is ${(ageMs / 3600000).toFixed(1)}h old (max: ${this.MAX_POSITION_AGE_MS / 3600000}h) — auto-closing`);

        // Try to get current price from market status
        let exitPrice = 0.5; // default fallback
        try {
          const status = await this.fetchMarketStatus(marketId);
          if (status) {
            exitPrice = this.getCurrentPrice(status, trade.outcome);
          }
        } catch { /* use fallback */ }

        const closed = await this.closePosition(marketId, exitPrice, 'ttl_expired');
        if (closed) {
          closedCount++;
          await this.persistClose(closed);
        }
      }
    }

    if (closedCount > 0) {
      logger.info(`PositionLifecycle: TTL sweep closed ${closedCount} stale position(s)`);
    }
  }

  /**
   * Layer 3: Stop-Loss Checker
   * Queries current prices and closes if loss exceeds threshold.
   */
  private async checkStopLosses(): Promise<void> {
    const openTrades = this.getOpenTrades();
    if (openTrades.length === 0) return;

    for (const trade of openTrades) {
      const marketId = trade.marketId ?? '';
      try {
        const status = await this.fetchMarketStatus(marketId);
        if (!status || status.closed) continue; // skip resolved markets (handled by resolution checker)

        const currentPrice = this.getCurrentPrice(status, trade.outcome);
        const entryPrice = trade.ourEntryPrice ?? (trade as any).entryPrice ?? 0.5;

        if (entryPrice <= 0) continue;

        const lossPct = (entryPrice - currentPrice) / entryPrice;
        if (lossPct >= this.STOP_LOSS_PCT) {
          logger.warn(`PositionLifecycle: STOP-LOSS triggered for "${marketId}" — entry: ${entryPrice.toFixed(3)}, current: ${currentPrice.toFixed(3)}, loss: ${(lossPct * 100).toFixed(1)}%`);

          const closed = await this.closePosition(marketId, currentPrice, 'stop_loss');
          if (closed) {
            await this.persistClose(closed);
            sendTelegramAlert(`🛑 <b>STOP-LOSS</b>\n${marketId.slice(0, 50)}\nLoss: ${(lossPct * 100).toFixed(1)}% | P&L: $${closed.pnl?.toFixed(2) ?? 'n/a'}`);
          }
        }
      } catch (err) {
        logger.warn(`PositionLifecycle: Stop-loss check failed for ${marketId}: ${err}`);
      }
    }
  }

  /**
   * Fetch market status from Gamma API with caching.
   *
   * Tries multiple lookup strategies because marketId stored in copy_trades
   * can be a slug, a condition_id (hex hash), or a short-form ID — and the
   * Gamma API only reliably matches on slug. If slug lookup fails, falls
   * back to condition_id lookup. Logs failures so silent-skip is visible.
   */
  private async fetchMarketStatus(marketId: string): Promise<MarketStatus | null> {
    // Check cache first
    const cached = this.marketStatusCache.get(marketId);
    if (cached && Date.now() - cached.fetchedAt < this.CACHE_TTL_MS) {
      return cached.status;
    }

    // Strategy 1: lookup by slug (works when marketId is a human-readable slug)
    const status = await this._gammaLookup(`slug=${encodeURIComponent(marketId)}`);
    if (status) {
      this.marketStatusCache.set(marketId, { status, fetchedAt: Date.now() });
      return status;
    }

    // Strategy 2: lookup by condition_id (works when marketId is a hex hash
    // or contains the condition_id format)
    if (marketId.startsWith('0x') || marketId.length > 40) {
      const status2 = await this._gammaLookup(`condition_id=${encodeURIComponent(marketId)}`);
      if (status2) {
        this.marketStatusCache.set(marketId, { status: status2, fetchedAt: Date.now() });
        return status2;
      }
    }

    // Strategy 3: broad text search as last resort
    const status3 = await this._gammaLookup(`slug_contains=${encodeURIComponent(marketId.slice(0, 30))}`);
    if (status3) {
      this.marketStatusCache.set(marketId, { status: status3, fetchedAt: Date.now() });
      return status3;
    }

    logger.warn(`PositionLifecycle: Could not find market "${marketId.slice(0, 40)}" on Gamma API (tried slug, condition_id, text search)`);
    return null;
  }

  private async _gammaLookup(query: string): Promise<MarketStatus | null> {
    try {
      const res = await fetch(`${GAMMA_API_BASE}/markets?${query}`, {
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) return null;

      const markets = (await res.json()) as MarketStatus[];
      if (!markets || markets.length === 0) return null;
      return markets[0];
    } catch {
      return null;
    }
  }

  /**
   * Get settlement price for a resolved market.
   * outcomePrices is like "[\"0\", \"1\"]" and outcomes is like "[\"Yes\", \"No\"]"
   * If our outcome won, price = 1.0. If lost, price = 0.0.
   */
  private getSettlementPrice(status: MarketStatus, ourOutcome?: string): number {
    try {
      const prices = JSON.parse(status.outcomePrices) as string[];
      const outcomes = JSON.parse(status.outcomes) as string[];

      if (!ourOutcome || !outcomes.length) return -1; // signal: skip close

      const idx = outcomes.findIndex(o =>
        o.toLowerCase() === ourOutcome.toLowerCase()
      );

      if (idx >= 0 && idx < prices.length) {
        return parseFloat(prices[idx]);
      }

      return -1; // signal: skip close (unknown outcome)
    } catch {
      return -1; // signal: skip close (parse error)
    }
  }

  /**
   * Get current live price for an active market.
   */
  private getCurrentPrice(status: MarketStatus, ourOutcome?: string): number {
    return this.getSettlementPrice(status, ourOutcome); // Same logic, prices are live
  }
}
