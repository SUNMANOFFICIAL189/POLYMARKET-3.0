import { logger } from '../utils/logger.js';

/**
 * AIClassifier — PATS-Copy version.
 *
 * Two modes:
 *  1. classifyNews(): general news classification (legacy, used by confirmation layer)
 *  2. classifyTrade(): specific trade confirmation — should we copy this trade?
 */

export interface ClassificationResult {
  impactScore: number;
  direction: 'yes' | 'no' | 'neutral';
  confidence: number;
  matchedMarkets: string[];
  reasoning: string;
  category: string;
}

export interface TradeConfirmationResult {
  recommendation: 'copy' | 'skip' | 'veto';
  confidence: number;
  reasoning: string;
  hasOpposingSignals: boolean;
  hasSupportingSignals: boolean;
}

export class AIClassifier {
  private apiKey: string;
  private callCount = 0;
  private errorCount = 0;
  private retryCount = 0;
  private readonly COST_PER_CALL = 0.003;
  private readonly MAX_RETRIES = 3;
  private readonly BASE_RETRY_DELAY_MS = 1000;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  /**
   * Classify a news headline for general market relevance.
   */
  async classifyNews(headline: string, body?: string): Promise<ClassificationResult> {
    const prompt = `Rate this news headline's impact on prediction markets. Respond with ONLY a JSON object, no markdown.

Headline: ${headline}${body ? `\nBody: ${body.slice(0, 200)}` : ''}

JSON format:
{"impactScore": 0-100, "direction": "yes|no|neutral", "confidence": 0.0-1.0, "matchedMarkets": [], "reasoning": "brief", "category": "politics|economics|crypto|other"}`;

    return this.callAPI<ClassificationResult>(prompt, (content) => {
      const result = JSON.parse(content);
      return result as ClassificationResult;
    }, {
      impactScore: 0,
      direction: 'neutral',
      confidence: 0,
      matchedMarkets: [],
      reasoning: 'Classification failed',
      category: 'other',
    });
  }

  /**
   * Confirm whether to copy a leader's trade given recent news context.
   *
   * Returns:
   *   copy   — no opposing signals found, safe to proceed
   *   skip   — insufficient data to confirm (neutral, no strong signals either way)
   *   veto   — strong opposing signals found, do NOT copy
   */
  async classifyTrade(
    marketQuestion: string,
    leaderSide: 'buy' | 'sell',
    leaderOutcome: string,
    recentNews: Array<{ headline: string; source: string; timestamp: number }>,
  ): Promise<TradeConfirmationResult> {
    const newsContext = recentNews.length > 0
      ? recentNews.slice(0, 10).map(n => `- [${n.source}] ${n.headline}`).join('\n')
      : '(no recent news found for this market)';

    const prompt = `You are a trade confirmation system for a copy-trading bot on Polymarket (prediction market).

A top-performing trader just opened a position. Decide if we should copy it.

TRADE DETAILS:
- Market: "${marketQuestion}"
- Outcome: ${leaderOutcome}
- Side: ${leaderSide.toUpperCase()} (${leaderSide === 'buy' ? 'betting YES' : 'betting NO'} on this outcome)

RECENT NEWS (last 2 hours):
${newsContext}

TASK: Analyze whether any recent news STRONGLY contradicts this trade direction.
- If news clearly contradicts the trade (e.g., trader is buying YES but news says the event already failed): recommend VETO
- If news is neutral or supports the trade: recommend COPY
- If no relevant news at all: recommend COPY (trust the leader)

Respond with ONLY a JSON object, no markdown:
{"recommendation": "copy|skip|veto", "confidence": 0.0-1.0, "reasoning": "one sentence", "hasOpposingSignals": true|false, "hasSupportingSignals": true|false}`;

    return this.callAPI<TradeConfirmationResult>(prompt, (content) => {
      const result = JSON.parse(content);
      return result as TradeConfirmationResult;
    }, {
      recommendation: 'copy',
      confidence: 0.5,
      reasoning: 'Classification failed — defaulting to copy (trust leader)',
      hasOpposingSignals: false,
      hasSupportingSignals: false,
    });
  }

  private async callAPI<T>(prompt: string, parser: (content: string) => T, fallback: T): Promise<T> {
    for (let attempt = 0; attempt <= this.MAX_RETRIES; attempt++) {
      try {
        this.callCount++;

        const response = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': this.apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-6',
            max_tokens: 512,
            messages: [{ role: 'user', content: prompt }],
          }),
        });

        if (!response.ok) {
          throw new Error(`API error: ${response.status} ${response.statusText}`);
        }

        const data = await response.json() as { content: Array<{ text: string }> };
        const content = data.content[0].text;
        const cleaned = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

        try {
          return parser(cleaned);
        } catch {
          // Regex fallback for truncated JSON
          logger.warn('AI: JSON parse failed, attempting regex fallback');
          return fallback;
        }

      } catch (error: any) {
        this.errorCount++;
        const isRetryable = error?.cause?.code === 'ECONNRESET' ||
          error?.cause?.code === 'ETIMEDOUT' ||
          error?.cause?.code === 'ENOTFOUND' ||
          error?.message?.includes('fetch failed') ||
          error?.message?.includes('502') ||
          error?.message?.includes('503') ||
          error?.message?.includes('529');

        if (isRetryable && attempt < this.MAX_RETRIES) {
          this.retryCount++;
          const delay = this.BASE_RETRY_DELAY_MS * Math.pow(2, attempt);
          logger.warn(`AI classifier retry ${attempt + 1}/${this.MAX_RETRIES} in ${delay}ms (${error?.cause?.code || error?.message?.slice(0, 30)})`);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }

        logger.error(`AI classification failed after ${attempt + 1} attempts: ${error?.message?.slice(0, 80)}`);
        return fallback;
      }
    }

    return fallback;
  }

  getStats() {
    return {
      callCount: this.callCount,
      estimatedCost: this.callCount * this.COST_PER_CALL,
      errorCount: this.errorCount,
      retryCount: this.retryCount,
    };
  }
}
