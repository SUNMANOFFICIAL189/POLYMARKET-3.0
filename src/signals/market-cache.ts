/**
 * MarketCache — polls Gamma API for active Polymarket markets and maintains
 * a searchable in-memory cache. Used by the signal generator to match
 * news headlines against open markets.
 *
 * Sports markets are excluded (Phase 1 scope).
 */

import { logger } from '../utils/logger.js';
import { categoriseMarket } from './market-categoriser.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CachedMarket {
  slug: string;
  question: string;
  category: string; // from categoriseMarket()
  outcomes: string[];
  outcomePrices: number[];
  volume24h: number;
  active: boolean;
  endDate: string | null;
  conditionId: string;
  lastUpdated: string;
}

interface MarketCacheOptions {
  pollIntervalMs?: number;
}

/** Shape of a single market object returned by the Gamma API. */
interface GammaMarket {
  slug?: string;
  question?: string;
  outcomes?: string | string[];
  outcomePrices?: string | string[];
  volume24hr?: number;
  active?: boolean;
  endDate?: string;
  conditionId?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GAMMA_URL =
  'https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=500&order=volume24hr&ascending=false';
const FETCH_TIMEOUT_MS = 15_000;
const DEFAULT_POLL_INTERVAL_MS = 300_000; // 5 minutes

// ---------------------------------------------------------------------------
// MarketCache
// ---------------------------------------------------------------------------

export class MarketCache {
  private cache: Map<string, CachedMarket> = new Map();
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private readonly pollIntervalMs: number;
  private lastPollAt: string | null = null;

  constructor(opts: MarketCacheOptions = {}) {
    this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  /** Begin polling the Gamma API on the configured interval. */
  start(): void {
    logger.info(
      `MarketCache: Starting — polling every ${this.pollIntervalMs}ms`,
    );
    void this.poll();
    this.intervalId = setInterval(() => void this.poll(), this.pollIntervalMs);
  }

  /** Stop polling. The current cache remains available for reads. */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    logger.info('MarketCache: Stopped');
  }

  // -----------------------------------------------------------------------
  // Queries
  // -----------------------------------------------------------------------

  /**
   * Fuzzy search markets by keyword matching against the question text.
   * Each query word that appears in the question (case-insensitive) adds 1
   * to the score. Optionally filter by category. Returns the top 10 matches
   * sorted by score descending.
   */
  searchMarkets(query: string, category?: string): CachedMarket[] {
    const words = query
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 0);

    if (words.length === 0) return [];

    const scored: { market: CachedMarket; score: number }[] = [];

    for (const market of this.cache.values()) {
      if (category && market.category !== category) continue;

      const questionLower = market.question.toLowerCase();
      let score = 0;
      for (const word of words) {
        if (questionLower.includes(word)) score++;
      }
      if (score > 0) scored.push({ market, score });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 10).map((s) => s.market);
  }

  /** Exact lookup by slug. Returns null if not found. */
  getMarket(slug: string): CachedMarket | null {
    return this.cache.get(slug) ?? null;
  }

  /** Summary stats for monitoring / health checks. */
  getStats(): {
    totalMarkets: number;
    lastPollAt: string;
    categories: Record<string, number>;
  } {
    const categories: Record<string, number> = {};
    for (const market of this.cache.values()) {
      categories[market.category] = (categories[market.category] ?? 0) + 1;
    }
    return {
      totalMarkets: this.cache.size,
      lastPollAt: this.lastPollAt ?? 'never',
      categories,
    };
  }

  // -----------------------------------------------------------------------
  // Polling internals
  // -----------------------------------------------------------------------

  private async poll(): Promise<void> {
    try {
      const res = await fetch(GAMMA_URL, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if (!res.ok) {
        logger.warn(
          `MarketCache: Gamma API returned ${res.status} — keeping old cache`,
        );
        return;
      }

      const data: GammaMarket[] = (await res.json()) as GammaMarket[];
      const now = new Date().toISOString();
      const nextCache = new Map<string, CachedMarket>();

      for (const raw of data) {
        const parsed = this.parseMarket(raw, now);
        if (!parsed) continue;

        // Phase 1: exclude sports markets
        if (parsed.category === 'sports') continue;

        nextCache.set(parsed.slug, parsed);
      }

      this.cache = nextCache;
      this.lastPollAt = now;

      logger.info(
        `MarketCache: Refreshed — ${nextCache.size} active non-sports markets cached`,
      );
    } catch (err) {
      logger.warn(`MarketCache: Poll failed — ${err}. Keeping old cache`);
    }
  }

  /**
   * Convert a raw Gamma API object into a CachedMarket.
   * Returns null if essential fields are missing.
   */
  private parseMarket(raw: GammaMarket, now: string): CachedMarket | null {
    const slug = raw.slug;
    const question = raw.question;
    if (!slug || !question) return null;

    const outcomes = this.parseStringOrArray(raw.outcomes);
    const outcomePrices = this.parseStringOrArray(raw.outcomePrices).map(Number);

    return {
      slug,
      question,
      category: categoriseMarket(question),
      outcomes,
      outcomePrices,
      volume24h: raw.volume24hr ?? 0,
      active: raw.active ?? true,
      endDate: raw.endDate ?? null,
      conditionId: raw.conditionId ?? '',
      lastUpdated: now,
    };
  }

  /**
   * Gamma API sometimes returns arrays as JSON-encoded strings, sometimes
   * as actual arrays. Handle both.
   */
  private parseStringOrArray(value: string | string[] | undefined): string[] {
    if (!value) return [];
    if (Array.isArray(value)) return value;
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed)
        ? (parsed as string[]).map(String)
        : [];
    } catch {
      return [];
    }
  }
}
