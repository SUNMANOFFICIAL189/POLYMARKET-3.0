/**
 * MarketMovementScanner — detects significant price movements on Polymarket
 * and generates trading signals from them.
 *
 * Scans every 10 min. When a market moves >= 8% since last scan, runs an
 * AI assessment: is this move justified or an overreaction? If overreaction,
 * trade against (mean reversion). If justified momentum, trade with it.
 */

import { EventEmitter } from 'node:events';
import { logger } from '../utils/logger.js';
import type { CachedMarket, MarketCache } from './market-cache.js';
import type { TradingSignal } from './signal-generator.js';

const PRIMARY_URL = process.env.FALLBACK_AI_URL ?? 'https://openrouter.ai/api';
const PRIMARY_MODEL = process.env.FALLBACK_AI_MODEL ?? 'google/gemma-4-31b-it';
const PRIMARY_KEY = process.env.OPENROUTER_API_KEY ?? '';

const SCAN_INTERVAL_MS = Number(process.env.MOVEMENT_SCAN_MS ?? '600000') || 600000;
const MOVE_THRESHOLD_UP = Number(process.env.MOVEMENT_THRESHOLD_UP ?? '0.08') || 0.08;
const MOVE_THRESHOLD_DOWN = Number(process.env.MOVEMENT_THRESHOLD_DOWN ?? '0.05') || 0.05; // lower for SELL — 63% WR
const MIN_CONFIDENCE = 0.65;
const COOLDOWN_MS = 60 * 60 * 1000;

interface PriceAssessment {
  action: 'buy' | 'sell' | 'skip';
  confidence: number;
  reasoning: string;
}

export class MarketMovementScanner extends EventEmitter {
  private marketCache: MarketCache;
  private previousPrices: Map<string, number> = new Map();
  private cooldowns: Map<string, number> = new Map();
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private signalsEmitted = 0;
  private scansCompleted = 0;
  private movementsDetected = 0;

  constructor(opts: { marketCache: MarketCache }) {
    super();
    this.marketCache = opts.marketCache;
  }

  start(): void {
    logger.info(
      'MarketMovementScanner: Starting — scan every ' +
      (SCAN_INTERVAL_MS / 1000) + 's, threshold ' +
      (MOVE_THRESHOLD_UP * 100).toFixed(0) + '%/' + (MOVE_THRESHOLD_DOWN * 100).toFixed(0) + '% (up/down)'
    );
    setTimeout(() => this.scan(), 120_000);
    this.intervalId = setInterval(() => this.scan(), SCAN_INTERVAL_MS);
  }

  stop(): void {
    if (this.intervalId) { clearInterval(this.intervalId); this.intervalId = null; }
    logger.info('MarketMovementScanner: Stopped');
  }

  getStats() {
    return {
      scansCompleted: this.scansCompleted,
      movementsDetected: this.movementsDetected,
      signalsEmitted: this.signalsEmitted,
    };
  }

  private async scan(): Promise<void> {
    try {
      const cacheStats = this.marketCache.getStats();
      if (cacheStats.totalMarkets === 0) return;

      // Fetch fresh prices from Gamma API directly for all cached markets
      const markets = await this.fetchCurrentPrices();
      let movedCount = 0;

      for (const market of markets) {
        const slug = market.slug;
        const currentPrice = market.outcomePrices[0] ?? 0.5;
        const previousPrice = this.previousPrices.get(slug);

        this.previousPrices.set(slug, currentPrice);
        if (previousPrice === undefined) continue;

        const cooldownUntil = this.cooldowns.get(slug) ?? 0;
        if (Date.now() < cooldownUntil) continue;

        const move = Math.abs(currentPrice - previousPrice);
        const movePct = previousPrice > 0 ? move / previousPrice : 0;

        // Skip penny markets — moves on $0.001 prices are noise, not signals
        if (currentPrice < 0.02 && previousPrice < 0.02) continue;

        const direction = currentPrice > previousPrice ? 'up' : 'down';
        const threshold = direction === 'down' ? MOVE_THRESHOLD_DOWN : MOVE_THRESHOLD_UP;
        if (movePct >= threshold) {
          movedCount++;
          this.movementsDetected++;
          logger.info(
            'MarketMovementScanner: ' + market.question.slice(0, 50) +
            ' moved ' + direction + ' ' + (movePct * 100).toFixed(1) +
            '% (' + previousPrice.toFixed(3) + ' -> ' + currentPrice.toFixed(3) + ')'
          );
          await this.assessMovement(market, previousPrice, currentPrice, direction, movePct);
        }
      }

      this.scansCompleted++;
      if (movedCount > 0) {
        logger.info(
          'MarketMovementScanner: Scan #' + this.scansCompleted +
          ' — ' + movedCount + ' movement(s) from ' + markets.length + ' markets'
        );
      } else if (this.scansCompleted % 6 === 0) {
        logger.info(
          'MarketMovementScanner: Scan #' + this.scansCompleted +
          ' — no significant movements in ' + markets.length + ' markets'
        );
      }
    } catch (err) {
      logger.warn('MarketMovementScanner: scan error: ' + err);
    }
  }

  private async fetchCurrentPrices(): Promise<CachedMarket[]> {
    // Use the market cache's data — it already polls Gamma every 5 min
    // We just need to iterate all cached markets
    const results: CachedMarket[] = [];
    const categories = ['politics', 'crypto', 'finance', 'other'];
    const seen = new Set<string>();

    for (const cat of categories) {
      // searchMarkets with common political/crypto terms to get markets per category
      const terms = cat === 'crypto' ? ['bitcoin', 'ethereum', 'crypto', 'token', 'defi']
        : cat === 'politics' ? ['trump', 'president', 'election', 'congress', 'senate']
        : cat === 'finance' ? ['fed', 'rate', 'inflation', 'gdp', 'tariff']
        : ['iran', 'ceasefire', 'war', 'ukraine', 'china', 'pope'];

      for (const term of terms) {
        const matches = this.marketCache.searchMarkets(term, cat);
        for (const m of matches) {
          if (!seen.has(m.slug)) {
            seen.add(m.slug);
            results.push(m);
          }
        }
      }
    }
    return results;
  }

  private async assessMovement(
    market: CachedMarket,
    prevPrice: number,
    curPrice: number,
    direction: string,
    movePct: number,
  ): Promise<void> {
    const prompt =
      'You are a prediction market analyst. A market on Polymarket just experienced a significant price movement. Determine if this creates a trading opportunity.\n\n' +
      'MARKET: "' + market.question + '"\n' +
      'CATEGORY: ' + market.category + '\n' +
      'PRICE MOVEMENT: ' + direction.toUpperCase() + ' ' + (movePct * 100).toFixed(1) + '% (from ' + prevPrice.toFixed(3) + ' to ' + curPrice.toFixed(3) + ')\n' +
      'CURRENT YES PRICE: ' + curPrice.toFixed(3) + ' (' + (curPrice * 100).toFixed(1) + '% implied probability)\n\n' +
      'ANALYSIS REQUIRED:\n' +
      '1. Is this move likely justified by real events, or is it an overreaction / thin-market noise?\n' +
      '2. If overreaction: the price may revert — trade AGAINST the move (mean reversion)\n' +
      '3. If justified momentum: the move may continue — trade WITH the move (momentum)\n' +
      '4. If uncertain: SKIP\n\n' +
      'Respond with ONLY a JSON object:\n' +
      '{"action": "buy"|"sell"|"skip", "confidence": 0.0-1.0, "reasoning": "one sentence explaining the trade thesis"}';

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (PRIMARY_KEY) headers['Authorization'] = 'Bearer ' + PRIMARY_KEY;

      const res = await fetch(PRIMARY_URL + '/v1/chat/completions', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: PRIMARY_MODEL,
          messages: [{ role: 'user', content: prompt }],
          stream: false,
        }),
        signal: AbortSignal.timeout(15_000),
      });

      if (!res.ok) {
        logger.warn('MarketMovementScanner: AI ' + res.status + ' for "' + market.question.slice(0, 30) + '"');
        return;
      }

      const data = await res.json() as { choices: Array<{ message: { content: string } }> };
      const raw = data.choices[0]?.message?.content ?? '';
      const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return;

      const result = JSON.parse(jsonMatch[0]) as PriceAssessment;

      if (result.action === 'skip' || result.confidence < MIN_CONFIDENCE) {
        logger.info('MarketMovementScanner: AI skip for "' + market.question.slice(0, 40) + '" — ' + result.reasoning);
        return;
      }

      if (result.action === 'buy' || result.action === 'sell') {
        this.signalsEmitted++;
        this.cooldowns.set(market.slug, Date.now() + COOLDOWN_MS);

        const signal: TradingSignal = {
          type: 'news-driven',
          market,
          side: result.action,
          confidence: result.confidence,
          reasoning: '[MOVE ' + direction + ' ' + (movePct * 100).toFixed(1) + '%] ' + result.reasoning,
          newsHeadline: 'Price ' + direction + ' ' + (movePct * 100).toFixed(1) + '%: ' + market.question.slice(0, 60),
          newsSource: 'market-movement',
          generatedAt: new Date().toISOString(),
        };

        logger.info(
          'MarketMovementScanner: SIGNAL — ' + result.action.toUpperCase() +
          ' "' + market.question.slice(0, 40) + '" @ ' + curPrice.toFixed(3) +
          ' (' + (result.confidence * 100).toFixed(0) + '% confidence)'
        );
        this.emit('signal', signal);
      }
    } catch (err) {
      logger.warn('MarketMovementScanner: assessment failed for "' + market.question.slice(0, 30) + '": ' + err);
    }
  }
}
