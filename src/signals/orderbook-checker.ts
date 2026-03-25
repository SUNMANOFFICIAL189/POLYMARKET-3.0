import { logger } from '../utils/logger.js';

const CLOB_API_BASE = 'https://clob.polymarket.com';
const TOP_LEVELS = 5; // number of bid/ask levels to sum

export interface SlippageEstimate {
  slippagePct: number;
  avgPrice: number;
  filled: number;
}

/**
 * OrderbookChecker — queries the Polymarket CLOB API for orderbook depth.
 *
 * Returns bid pressure ratio = totalBidSize / (totalBidSize + totalAskSize)
 * using the top N price levels on each side.
 *
 * Also provides slippage estimation for pre-trade liquidity checks.
 */
export class OrderbookChecker {
  async getBidPressure(tokenId: string | undefined): Promise<number | null> {
    if (!tokenId) return null;

    try {
      const book = await this.fetchBook(tokenId);
      if (!book) return null;

      const { bids, asks } = book;
      if (bids.length === 0 && asks.length === 0) return null;

      const totalBid = bids
        .slice(0, TOP_LEVELS)
        .reduce((sum, level) => sum + Number(level.size), 0);

      const totalAsk = asks
        .slice(0, TOP_LEVELS)
        .reduce((sum, level) => sum + Number(level.size), 0);

      const total = totalBid + totalAsk;
      if (total === 0) return null;

      const pressure = totalBid / total;
      logger.debug(`OrderbookChecker: tokenId ${tokenId.slice(0, 12)}... bid=${totalBid.toFixed(0)} ask=${totalAsk.toFixed(0)} pressure=${pressure.toFixed(3)}`);
      return pressure;

    } catch (err) {
      logger.debug(`OrderbookChecker: fetch failed for ${tokenId?.slice(0, 12)}...: ${err}`);
      return null;
    }
  }

  /**
   * Estimate slippage for a given trade size by walking the orderbook.
   * For a BUY, walks asks from lowest to highest.
   * For a SELL, walks bids from highest to lowest.
   * Returns null if orderbook data is unavailable.
   */
  async estimateSlippage(
    tokenId: string | undefined,
    side: 'buy' | 'sell',
    usdcAmount: number,
  ): Promise<SlippageEstimate | null> {
    if (!tokenId) return null;

    try {
      const book = await this.fetchBook(tokenId);
      if (!book) return null;

      // For a buy, we consume asks; for a sell, we consume bids
      const levels = side === 'buy' ? book.asks : book.bids;
      if (levels.length === 0) return null;

      const bestPrice = Number(levels[0].price);
      if (bestPrice <= 0) return null;

      let remaining = usdcAmount;
      let totalShares = 0;
      let totalCost = 0;

      for (const level of levels) {
        if (remaining <= 0) break;
        const price = Number(level.price);
        const size = Number(level.size);
        if (price <= 0 || size <= 0) continue;

        const levelUsdc = price * size;
        const fill = Math.min(remaining, levelUsdc);
        const sharesFilled = fill / price;

        totalShares += sharesFilled;
        totalCost += fill;
        remaining -= fill;
      }

      if (totalShares === 0) return null;

      const avgPrice = totalCost / totalShares;
      const slippagePct = Math.abs(avgPrice - bestPrice) / bestPrice;

      logger.debug(`OrderbookChecker: Slippage estimate for $${usdcAmount.toFixed(0)} ${side}: avg=${avgPrice.toFixed(4)} best=${bestPrice.toFixed(4)} slippage=${(slippagePct * 100).toFixed(2)}%`);

      return {
        slippagePct,
        avgPrice,
        filled: totalCost,
      };
    } catch (err) {
      logger.debug(`OrderbookChecker: slippage estimation failed for ${tokenId?.slice(0, 12)}...: ${err}`);
      return null;
    }
  }

  private async fetchBook(tokenId: string): Promise<{
    bids: Array<{ price: string | number; size: string | number }>;
    asks: Array<{ price: string | number; size: string | number }>;
  } | null> {
    const url = `${CLOB_API_BASE}/book?token_id=${encodeURIComponent(tokenId)}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);

    let res: Response;
    try {
      res = await fetch(url, { signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }

    if (!res.ok) {
      logger.debug(`OrderbookChecker: ${res.status} for tokenId ${tokenId.slice(0, 12)}...`);
      return null;
    }

    const data = await res.json();
    return {
      bids: data.bids ?? [],
      asks: data.asks ?? [],
    };
  }
}
