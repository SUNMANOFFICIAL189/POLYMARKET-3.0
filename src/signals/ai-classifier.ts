import { logger } from '../utils/logger.js';

/**
 * AIClassifier — PATS-Copy version.
 *
 * Uses Mistral (free tier, 1B tokens/month) via its OpenAI-compatible endpoint.
 *
 * KEY FIX: Static single-lane queue serialises ALL Mistral calls with a 700ms
 * minimum gap between requests. Mistral free tier allows ~1 req/s — without
 * this queue, a burst of 11 simultaneous trades fires 11 concurrent HTTP requests
 * and all get 429 rate-limited, causing a 99% veto rate.
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
  aiUnavailable?: boolean; // true when API was unreachable — confirmation layer uses orderbook fallback
}


export interface ChallengeResult {
  proceed: boolean;
  reason: string;
}

// Primary: Mistral (free tier, 1B tokens/month)
const PRIMARY_URL = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
const PRIMARY_MODEL = process.env.OLLAMA_MODEL ?? 'llama3.2';
const PRIMARY_KEY = process.env.CEREBRAS_API_KEY ?? '';

// Fallback: OpenRouter Gemma 4 (~$0.40/month at our volume)
const FALLBACK_URL = process.env.FALLBACK_AI_URL ?? 'https://openrouter.ai/api';
const FALLBACK_MODEL = process.env.FALLBACK_AI_MODEL ?? 'google/gemma-4-27b-it';
const FALLBACK_KEY = process.env.OPENROUTER_API_KEY ?? '';

export class AIClassifier {
  // Static queue shared across ALL instances — ensures at most 1 Mistral call at a time.
  // Each call holds the lock for its duration + MIN_GAP_MS after completion.
  private static _queueTail: Promise<void> = Promise.resolve();
  private static readonly MIN_GAP_MS = 700; // 700ms gap = safely under Mistral free tier 1 req/s limit

  private callCount = 0;
  private errorCount = 0;
  private retryCount = 0;
  private fallbackCount = 0;
  private readonly MAX_RETRIES = 1; // Quick fail on primary — fallback handles overflow
  private readonly BASE_RETRY_DELAY_MS = 1500;

  constructor(_apiKey?: string) {}

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
      return JSON.parse(content) as TradeConfirmationResult;
    }, {
      recommendation: 'veto',
      confidence: 1.0,
      reasoning: 'AI unavailable or malformed response — safe-fail veto',
      hasOpposingSignals: true,
      hasSupportingSignals: false,
      aiUnavailable: true,
    });
  }

  /**
   * Acquires a slot in the single-lane queue, executes the API call,
   * then holds the slot for MIN_GAP_MS before releasing to the next caller.
   */
  private async callAPI<T>(prompt: string, parser: (content: string) => T, fallback: T): Promise<T> {
    let releaseSlot!: () => void;

    // Chain onto the existing queue tail — our call starts when the previous finishes
    const prevTail = AIClassifier._queueTail;
    AIClassifier._queueTail = new Promise<void>(resolve => { releaseSlot = resolve; });

    await prevTail; // wait for our turn

    try {
      return await this._executeCall(prompt, parser, fallback);
    } finally {
      // Hold the slot for MIN_GAP_MS after completion before allowing the next call
      setTimeout(releaseSlot, AIClassifier.MIN_GAP_MS);
    }
  }

  private async _executeCall<T>(prompt: string, parser: (content: string) => T, fallback: T): Promise<T> {
    // Try primary (Mistral) first
    try {
      this.callCount++;
      const result = await this._callProvider(PRIMARY_URL, PRIMARY_MODEL, PRIMARY_KEY, prompt);
      return this._parseResponse(result, parser, fallback);
    } catch (error: any) {
      this.errorCount++;
      const is429 = error?.message?.includes('429');
      const isTransient = is429 ||
        error?.cause?.code === 'ECONNRESET' ||
        error?.cause?.code === 'ETIMEDOUT' ||
        error?.message?.includes('fetch failed');

      // On 429 or transient error → immediate failover to OpenRouter (no retry delay)
      if (isTransient && FALLBACK_KEY) {
        this.fallbackCount++;
        logger.info(`AI: Primary ${is429 ? 'rate-limited' : 'failed'} — failover to OpenRouter Gemma 4`);
        try {
          const result = await this._callProvider(FALLBACK_URL, FALLBACK_MODEL, FALLBACK_KEY, prompt);
          return this._parseResponse(result, parser, fallback);
        } catch (fbError: any) {
          logger.error(`AI: Fallback also failed: ${fbError?.message?.slice(0, 80)}`);
          return fallback;
        }
      }

      // Non-transient error or no fallback configured
      logger.error(`AI classification failed: ${error?.message?.slice(0, 80)}`);
      return fallback;
    }
  }

  private async _callProvider(baseUrl: string, model: string, apiKey: string, prompt: string): Promise<string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        stream: false,
      }),
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      throw new Error(`AI error: ${response.status} ${response.statusText} — ${errBody.slice(0, 200)}`);
    }

    const data = await response.json() as {
      choices: Array<{ message: { content: string } }>;
    };
    return data.choices[0]?.message?.content ?? '';
  }

  private _parseResponse<T>(raw: string, parser: (content: string) => T, fallback: T): T {
    const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON object found in response');
    try {
      return parser(jsonMatch[0]);
    } catch {
      logger.warn('AI: JSON parse failed, using fallback');
      return fallback;
    }
  }


  /**
   * Devil's advocate — challenges a trade decision with wallet context.
   * Inspired by Dexter's self-validation pattern.
   * Returns PROCEED (no concrete objection) or CHALLENGE (specific risk identified).
   */
  async challengeTrade(
    marketQuestion: string,
    side: 'buy' | 'sell',
    outcome: string,
    entryPrice: number,
    walletWR: number,
    walletTradeCount: number,
  ): Promise<ChallengeResult> {
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const prompt = `You are a strict risk assessor for a prediction market copy-trading bot. You MUST challenge trades that have poor risk profiles. You are the last line of defence before real money is deployed.

TODAY'S DATE: ${today}

TRADE:
- Market: "${marketQuestion}"
- Side: ${side.toUpperCase()} on ${outcome}
- Entry price: ${entryPrice.toFixed(3)} (${(entryPrice * 100).toFixed(1)}% implied probability)

WALLET PERFORMANCE:
- This trader has won ${(walletWR * 100).toFixed(0)}% of their last ${walletTradeCount} trades
${walletWR < 0.20 ? '- ⚠️ CRITICAL: This wallet has BELOW 20% win rate — they are losing 4 out of 5 trades' : walletWR < 0.35 ? '- ⚠️ WARNING: This wallet has a poor win rate — losing more than they win' : ''}

YOU MUST CHALLENGE (output proceed=false) if ANY of these apply:
1. The market question contains a date that has ALREADY PASSED (today is ${today}). Example: "Will X happen by April 7?" and today is April 8 → CHALLENGE.
2. The wallet win rate is below 20% over 5+ trades — this is a proven losing trader. CHALLENGE.
3. The wallet win rate is below 30% over 8+ trades — consistent underperformance. CHALLENGE.
4. The event has already been decided, resolved, or is physically impossible.
5. The entry price is below 0.01 (near-worthless token, likely expired market).

You SHOULD PROCEED (output proceed=true) if:
- The wallet has above 35% WR, the market date hasn't passed, and no factual contradictions exist.
- The trade is a longshot (< 0.25 entry) from a wallet with decent WR — high risk but valid strategy.

Respond with ONLY a JSON object, no markdown:
{"proceed": true, "reason": "brief reason"} OR {"proceed": false, "reason": "brief reason"}`;

    return this.callAPI<ChallengeResult>(prompt, (content) => {
      const parsed = JSON.parse(content) as ChallengeResult;
      return { proceed: parsed.proceed !== false, reason: parsed.reason || '' };
    }, {
      proceed: false,
      reason: 'Challenge unavailable — blocking trade (safety default)',
    });
  }

  getStats() {
    return {
      callCount: this.callCount,
      estimatedCost: 0,
      errorCount: this.errorCount,
      retryCount: this.retryCount,
      fallbackCount: this.fallbackCount,
    };
  }
}
