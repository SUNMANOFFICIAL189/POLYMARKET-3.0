/**
 * SignalGenerator — generates original trading signals from news events.
 *
 * Listens for incoming news items, matches them against active Polymarket
 * markets via MarketCache, then runs a dedicated AI prompt to determine
 * whether the news creates a clear directional trading opportunity.
 *
 * This is SEPARATE from the copy-trading confirmation layer. Copy-trading
 * validates someone else's trade; this module generates our OWN signals
 * when news has clear, specific implications for a market outcome.
 *
 * Deduplication: no two signals for the same market within 30 minutes.
 */

import { EventEmitter } from 'node:events';
import { logger } from '../utils/logger.js';
import type { CachedMarket, MarketCache } from './market-cache.js';
import type { AIClassifier } from './ai-classifier.js';

// ─── Types ────────────────────────────────────────────────────────

export interface TradingSignal {
  type: 'news-driven';
  market: CachedMarket;
  side: 'buy' | 'sell';
  confidence: number;
  reasoning: string;
  newsHeadline: string;
  newsSource: string;
  generatedAt: string;
}

export interface NewsInput {
  headline: string;
  source: string;
  timestamp: number | string;
  body?: string;
}

interface AISignalAssessment {
  action: 'buy' | 'sell' | 'skip';
  confidence: number;
  reasoning: string;
}

// ─── AI Provider Config ───────────────────────────────────────────

const PRIMARY_URL = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
const PRIMARY_MODEL = process.env.OLLAMA_MODEL ?? 'llama3.2';
const PRIMARY_KEY = process.env.CEREBRAS_API_KEY ?? '';

// ─── Constants ────────────────────────────────────────────────────

const DEFAULT_MIN_CONFIDENCE = 0.80;
const DEDUP_WINDOW_MS = 30 * 60 * 1000; // 30 minutes
const MAX_MATCHES = 5;
const AI_TIMEOUT_MS = 15_000;
const MAX_BODY_CHARS = 300;

// ─── SignalGenerator ──────────────────────────────────────────────

export class SignalGenerator extends EventEmitter {
  private readonly marketCache: MarketCache;
  private readonly classifier: AIClassifier;
  private readonly minConfidence: number;

  // Stats counters
  private signalsGenerated = 0;
  private newsProcessed = 0;
  private marketsMatched = 0;

  // Deduplication: marketId → last signal timestamp
  private readonly recentSignals = new Map<string, number>();

  constructor(opts: {
    marketCache: MarketCache;
    classifier: AIClassifier;
    minConfidence?: number;
  }) {
    super();
    this.marketCache = opts.marketCache;
    this.classifier = opts.classifier;
    this.minConfidence = opts.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  }

  /**
   * Main entry point — called when a news item arrives.
   * Matches against active markets and emits signals for clear opportunities.
   * Never throws — a single news item failure must not crash the system.
   */
  async processNewsItem(item: NewsInput): Promise<void> {
    this.newsProcessed++;

    try {
      const headline = item.headline?.trim();
      if (!headline) {
        logger.debug('SignalGenerator: empty headline, skipping');
        return;
      }

      // 1. Search marketCache for top matches (already sorted by relevance)
      const matches = this.marketCache.searchMarkets(headline);
      const topMatches = matches.slice(0, MAX_MATCHES);

      if (topMatches.length === 0) {
        logger.debug(`SignalGenerator: no market matches for "${headline.slice(0, 60)}"`);
        return;
      }

      this.marketsMatched += topMatches.length;
      logger.info(
        `SignalGenerator: ${topMatches.length} market match(es) for "${headline.slice(0, 60)}"`,
      );

      // 2. Assess each matched market via AI
      for (const market of topMatches) {
        try {
          await this.assessAndEmit(item, market);
        } catch (err) {
          logger.warn(
            `SignalGenerator: assessment failed for market ${market.conditionId ?? 'unknown'}: ${err}`,
          );
        }
      }
    } catch (err) {
      logger.error(`SignalGenerator: processNewsItem failed: ${err}`);
    }
  }

  /**
   * Returns aggregate stats for monitoring/dashboard.
   */
  getStats(): { signalsGenerated: number; newsProcessed: number; marketsMatched: number } {
    return {
      signalsGenerated: this.signalsGenerated,
      newsProcessed: this.newsProcessed,
      marketsMatched: this.marketsMatched,
    };
  }

  // ─── Private Methods ──────────────────────────────────────────

  /**
   * Assess a single market against the news item and emit a signal if warranted.
   */
  private async assessAndEmit(item: NewsInput, market: CachedMarket): Promise<void> {
    // Deduplication check — skip if we already signalled this market recently
    const marketKey = market.conditionId ?? market.question;
    const lastSignalTs = this.recentSignals.get(marketKey);
    if (lastSignalTs && Date.now() - lastSignalTs < DEDUP_WINDOW_MS) {
      logger.debug(
        `SignalGenerator: dedup — skipping "${market.question.slice(0, 50)}" (signalled ${Math.round((Date.now() - lastSignalTs) / 60_000)}m ago)`,
      );
      return;
    }

    // Extract current price string for the AI prompt
    const priceStr = this.formatMarketPrices(market);

    // Call the dedicated signal-assessment AI prompt
    const assessment = await this.assessSignal(
      item.headline,
      item.body?.slice(0, MAX_BODY_CHARS),
      market.question,
      priceStr,
    );

    if (assessment.action === 'skip') {
      logger.debug(
        `SignalGenerator: AI skip for "${market.question.slice(0, 50)}" — ${assessment.reasoning}`,
      );
      return;
    }

    if (assessment.confidence < this.minConfidence) {
      logger.debug(
        `SignalGenerator: confidence ${assessment.confidence.toFixed(2)} < ${this.minConfidence} for "${market.question.slice(0, 50)}"`,
      );
      return;
    }

    // Emit the trading signal
    const signal: TradingSignal = {
      type: 'news-driven',
      market,
      side: assessment.action,
      confidence: assessment.confidence,
      reasoning: assessment.reasoning,
      newsHeadline: item.headline,
      newsSource: item.source,
      generatedAt: new Date().toISOString(),
    };

    this.recentSignals.set(marketKey, Date.now());
    this.signalsGenerated++;
    this.pruneDedup();

    logger.info(
      `SignalGenerator: SIGNAL ${assessment.action.toUpperCase()} ` +
      `(${(assessment.confidence * 100).toFixed(0)}%) — "${market.question.slice(0, 60)}" ` +
      `| news: "${item.headline.slice(0, 50)}"`,
    );

    this.emit('signal', signal);
  }

  /**
   * Dedicated AI prompt for signal assessment.
   *
   * COMPLETELY DIFFERENT from the copy-trading confirmation prompt.
   * This one asks: "Does this news event create a NEW trading opportunity?"
   * rather than "Should we copy someone else's trade?"
   */
  private async assessSignal(
    headline: string,
    bodySnippet: string | undefined,
    marketQuestion: string,
    marketPrices: string,
  ): Promise<AISignalAssessment> {
    const skipFallback: AISignalAssessment = {
      action: 'skip',
      confidence: 0,
      reasoning: 'AI unavailable — defaulting to skip',
    };

    const prompt = `You are a prediction market analyst. A news event just occurred. Determine if it creates a trading opportunity on this specific prediction market.

NEWS EVENT:
- Headline: ${headline}${bodySnippet ? `\n- Body snippet: ${bodySnippet}` : ''}

PREDICTION MARKET:
- Question: ${marketQuestion}
- Current prices: ${marketPrices}

INSTRUCTIONS:
1. Analyse the causal chain: Does this news directly and specifically affect the outcome of this market?
2. If YES, determine the direction:
   - BUY = news makes the market outcome MORE likely (price should go UP)
   - SELL = news makes the market outcome LESS likely (price should go DOWN)
3. If the connection is vague, tangential, or requires multiple uncertain assumptions, choose SKIP.

IMPORTANT:
- SKIP is the DEFAULT. Only choose buy/sell when the news has CLEAR, SPECIFIC implications.
- You must explain the causal chain: "News X implies Y, therefore buy/sell on this market."
- High confidence (0.85-1.0) requires direct, unambiguous impact.
- Medium confidence (0.70-0.84) requires strong but not certain implications.
- Low confidence (<0.70) should be SKIP — we do not trade on weak signals.

Respond with ONLY a JSON object, no markdown:
{"action": "buy"|"sell"|"skip", "confidence": 0.0-1.0, "reasoning": "one sentence explaining the causal chain"}`;

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (PRIMARY_KEY) headers['Authorization'] = `Bearer ${PRIMARY_KEY}`;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);

      let response: Response;
      try {
        response = await fetch(`${PRIMARY_URL}/v1/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: PRIMARY_MODEL,
            messages: [{ role: 'user', content: prompt }],
            stream: false,
          }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
      }

      if (!response.ok) {
        const errBody = await response.text().catch(() => '');
        logger.warn(
          `SignalGenerator AI: ${response.status} ${response.statusText} — ${errBody.slice(0, 150)}`,
        );
        return skipFallback;
      }

      const data = await response.json() as {
        choices: Array<{ message: { content: string } }>;
      };

      const raw = data.choices[0]?.message?.content ?? '';
      return this.parseAssessmentResponse(raw);
    } catch (err) {
      logger.warn(`SignalGenerator AI call failed: ${err}`);
      return skipFallback;
    }
  }

  /**
   * Parse the AI response into a structured assessment.
   * Tolerates markdown code fences and extraneous text.
   */
  private parseAssessmentResponse(raw: string): AISignalAssessment {
    const skipFallback: AISignalAssessment = {
      action: 'skip',
      confidence: 0,
      reasoning: 'Failed to parse AI response',
    };

    try {
      const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        logger.debug('SignalGenerator: no JSON found in AI response');
        return skipFallback;
      }

      const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;

      // Validate action
      const action = String(parsed.action ?? 'skip').toLowerCase();
      if (action !== 'buy' && action !== 'sell' && action !== 'skip') {
        return skipFallback;
      }

      // Validate confidence
      const confidence = Number(parsed.confidence ?? 0);
      if (isNaN(confidence) || confidence < 0 || confidence > 1) {
        return skipFallback;
      }

      const reasoning = String(parsed.reasoning ?? '').slice(0, 500);

      return { action: action as 'buy' | 'sell' | 'skip', confidence, reasoning };
    } catch {
      logger.debug('SignalGenerator: JSON parse error in AI response');
      return skipFallback;
    }
  }

  /**
   * Format outcome prices from the CachedMarket for the AI prompt.
   * Handles various shapes the data might take.
   */
  private formatMarketPrices(market: CachedMarket): string {
    try {
      const prices = market.outcomePrices;
      if (!prices || !Array.isArray(prices) || prices.length === 0) {
        return 'unavailable';
      }

      const outcomes = market.outcomes;
      if (outcomes && Array.isArray(outcomes) && outcomes.length === prices.length) {
        return outcomes
          .map((name, i) => `${name}: ${(Number(prices[i]) * 100).toFixed(1)}%`)
          .join(', ');
      }

      // Fallback: just list the prices
      return prices.map((p, i) => `Outcome ${i + 1}: ${(Number(p) * 100).toFixed(1)}%`).join(', ');
    } catch {
      return 'unavailable';
    }
  }

  /**
   * Prune stale entries from the dedup map to prevent unbounded growth.
   * Runs opportunistically after each signal emission.
   */
  private pruneDedup(): void {
    const cutoff = Date.now() - DEDUP_WINDOW_MS * 2;
    this.recentSignals.forEach((ts, key) => {
      if (ts < cutoff) this.recentSignals.delete(key);
    });
  }
}
