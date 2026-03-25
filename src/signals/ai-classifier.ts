import { logger } from '../utils/logger.js';
import type { AIConfig } from '../core/config.js';

/**
 * AIClassifier — PATS-Copy version.
 *
 * Supports two providers (both OpenAI-compatible):
 *   - groq: Free tier, fast (200ms), llama-3.3-70b-versatile
 *   - ollama: Local, free, no rate limits, llama3.2
 *
 * Two modes:
 *  1. classifyNews(): general news classification
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
  private provider: 'groq' | 'ollama';
  private baseUrl: string;
  private model: string;
  private apiKey: string | null;
  private callCount = 0;
  private errorCount = 0;
  private retryCount = 0;
  private readonly MAX_RETRIES = 3;
  private readonly BASE_RETRY_DELAY_MS = 1000;

  constructor(config?: AIConfig) {
    this.provider = config?.provider ?? (process.env.AI_PROVIDER as 'groq' | 'ollama') ?? 'ollama';
    if (this.provider === 'groq') {
      this.baseUrl = 'https://api.groq.com/openai/v1';
      this.model = config?.groqModel ?? 'llama-3.3-70b-versatile';
      this.apiKey = config?.groqApiKey ?? process.env.GROQ_API_KEY ?? null;
      if (!this.apiKey) {
        logger.warn('AIClassifier: GROQ_API_KEY not set — falling back to Ollama');
        this.provider = 'ollama';
        this.baseUrl = config?.ollamaBaseUrl ?? process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
        this.model = config?.ollamaModel ?? process.env.OLLAMA_MODEL ?? 'llama3.2';
        this.apiKey = null;
      }
    } else {
      this.baseUrl = config?.ollamaBaseUrl ?? process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
      this.model = config?.ollamaModel ?? process.env.OLLAMA_MODEL ?? 'llama3.2';
      this.apiKey = null;
    }
    logger.info(`AIClassifier: Using ${this.provider} (${this.model}) at ${this.baseUrl}`);
  }

  async classifyNews(headline: string, body?: string): Promise<ClassificationResult> {
    const prompt = `Rate this news headline's impact on prediction markets. Respond with ONLY a JSON object, no markdown.

Headline: ${headline}${body ? `\nBody: ${body.slice(0, 200)}` : ''}

JSON format:
{"impactScore": 0-100, "direction": "yes|no|neutral", "confidence": 0.0-1.0, "matchedMarkets": [], "reasoning": "brief", "category": "politics|economics|crypto|other"}`;

    return this.callAPI<ClassificationResult>(prompt, (content) => {
      return JSON.parse(content) as ClassificationResult;
    }, {
      impactScore: 0,
      direction: 'neutral',
      confidence: 0,
      matchedMarkets: [],
      reasoning: 'Classification failed',
      category: 'other',
    });
  }

  async classifyTrade(
    marketQuestion: string,
    leaderSide: 'buy' | 'sell',
    leaderOutcome: string,
    recentNews: Array<{ headline: string; source: string; timestamp: number }>,
  ): Promise<TradeConfirmationResult> {
    const newsContext = recentNews.length > 0
      ? recentNews.slice(0, 10).map(n => `- [${n.source}] ${n.headline}`).join('\n')
      : '(no recent news found for this market)';

    const prompt = `You are a trade confirmation system for a copy-trading bot on Polymarket (a prediction market where shares resolve to $1 if correct, $0 if wrong).

A top-performing trader just opened a position. Your DEFAULT answer is COPY. Only veto when you find clear evidence the trade is wrong.

TRADE DETAILS:
- Market: "${marketQuestion}"
- Outcome: ${leaderOutcome}
- Side: ${leaderSide.toUpperCase()} (${leaderSide === 'buy' ? 'betting YES' : 'betting NO'} on this outcome)

RECENT NEWS (last 2 hours):
${newsContext}

DECISION RULES:
- DEFAULT: recommend COPY. We trust the leader — they are on the leaderboard because they win.
- VETO: ONLY if news proves the predicted outcome has ALREADY been decided against the leader's position.
- A veto should be RARE. Short-term noise, price dips, or uncertainty are NOT reasons to veto.

EXAMPLES:

Example 1 (VETO — outcome already decided):
Market: "Will candidate X win the election?" Leader buys YES.
News: "Candidate X has officially withdrawn from the race."
→ {"recommendation": "veto", "confidence": 0.95, "reasoning": "Candidate withdrew — outcome is decided against YES.", "hasOpposingSignals": true, "hasSupportingSignals": false}

Example 2 (COPY — noise, not contradiction):
Market: "Will BTC hit $100K by June?" Leader buys YES.
News: "BTC drops 3% today on profit-taking."
→ {"recommendation": "copy", "confidence": 0.7, "reasoning": "Short-term price dip does not invalidate the prediction. No strong contradiction.", "hasOpposingSignals": false, "hasSupportingSignals": false}

Example 3 (COPY — no news):
Market: "Will there be a ceasefire by April?" Leader buys YES.
News: (no recent news found for this market)
→ {"recommendation": "copy", "confidence": 0.5, "reasoning": "No contradicting news found. Trusting leader.", "hasOpposingSignals": false, "hasSupportingSignals": false}

Respond with ONLY a JSON object, no markdown:
{"recommendation": "copy|skip|veto", "confidence": 0.0-1.0, "reasoning": "one sentence", "hasOpposingSignals": true|false, "hasSupportingSignals": true|false}`;

    return this.callAPI<TradeConfirmationResult>(prompt, (content) => {
      return JSON.parse(content) as TradeConfirmationResult;
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

        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (this.apiKey) {
          headers['Authorization'] = `Bearer ${this.apiKey}`;
        }

        const url = this.provider === 'ollama'
          ? `${this.baseUrl}/v1/chat/completions`
          : `${this.baseUrl}/chat/completions`;

        const response = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: this.model,
            messages: [{ role: 'user', content: prompt }],
            stream: false,
          }),
        });

        if (!response.ok) {
          const errBody = await response.text().catch(() => '');
          throw new Error(`${this.provider} error: ${response.status} ${response.statusText} — ${errBody.slice(0, 200)}`);
        }

        const data = await response.json() as {
          choices: Array<{ message: { content: string } }>;
        };
        const content = data.choices[0]?.message?.content ?? '';
        const cleaned = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

        const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error('No JSON object found in response');

        try {
          return parser(jsonMatch[0]);
        } catch {
          logger.warn('AI: JSON parse failed, using fallback');
          return fallback;
        }

      } catch (error: any) {
        this.errorCount++;
        const isRetryable = error?.cause?.code === 'ECONNRESET' ||
          error?.cause?.code === 'ETIMEDOUT' ||
          error?.cause?.code === 'ENOTFOUND' ||
          error?.message?.includes('fetch failed') ||
          error?.message?.includes('ECONNREFUSED') ||
          error?.message?.includes('429'); // Rate limit

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
      provider: this.provider,
      model: this.model,
      callCount: this.callCount,
      estimatedCost: 0, // groq free tier / ollama local
      errorCount: this.errorCount,
      retryCount: this.retryCount,
    };
  }
}
