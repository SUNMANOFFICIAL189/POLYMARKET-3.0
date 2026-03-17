import { logger } from '../utils/logger.js';

const CLOB_API_BASE = 'https://clob.polymarket.com';
const TOP_LEVELS = 5; // number of bid/ask levels to sum

/**
 * OrderbookChecker — queries the Polymarket CLOB API for orderbook depth.
 *
 * Returns bid pressure ratio = totalBidSize / (totalBidSize + totalAskSize)
 * using the top N price levels on each side.
 *
 * A ratio > 0.55 indicates more buy pressure than sell pressure.
 * Returns null on any error (treated as corroboration = false by caller).
 */
export class OrderbookChecker {
  async getBidPressure(tokenId: string | undefined): Promise<number | null> {
    if (!tokenId) return null;

    try {
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
      const bids: Array<{ price: string | number; size: string | number }> = data.bids ?? [];
      const asks: Array<{ price: string | number; size: string | number }> = data.asks ?? [];

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
}
