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

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
const OLLAMA_MODEL    = process.env.OLLAMA_MODEL    ?? 'llama3.2';
const OLLAMA_API_KEY  = process.env.CEREBRAS_API_KEY ?? '';

export class AIClassifier {
  // Static queue shared across ALL instances — ensures at most 1 Mistral call at a time.
  // Each call holds the lock for its duration + MIN_GAP_MS after completion.
  private static _queueTail: Promise<void> = Promise.resolve();
  private static readonly MIN_GAP_MS = 700; // 700ms gap = safely under Mistral free tier 1 req/s limit

  private callCount = 0;
  private errorCount = 0;
  private retryCount = 0;
  private readonly MAX_RETRIES = 2; // Reduced from 3 — queue prevents burst, fewer retries needed
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
      recommendation: 'copy',
      confidence: 0.5,
      reasoning: 'AI unavailable (rate limited) — using orderbook fallback',
      hasOpposingSignals: false,
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
    for (let attempt = 0; attempt <= this.MAX_RETRIES; attempt++) {
      try {
        this.callCount++;

        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (OLLAMA_API_KEY) headers['Authorization'] = `Bearer ${OLLAMA_API_KEY}`;

        const response = await fetch(`${OLLAMA_BASE_URL}/v1/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: OLLAMA_MODEL,
            messages: [{ role: 'user', content: prompt }],
            stream: false,
          }),
        });

        if (!response.ok) {
          const errBody = await response.text().catch(() => '');
          throw new Error(`Ollama error: ${response.status} ${response.statusText} — ${errBody.slice(0, 200)}`);
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
          error?.message?.includes('429');

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
    const prompt = `You are a risk assessor for a prediction market copy-trading bot. Your job is to find a SPECIFIC, CONCRETE reason NOT to take this trade. Generic warnings don't count.

TRADE:
- Market: "${marketQuestion}"
- Side: ${side.toUpperCase()} on ${outcome}
- Entry price: ${entryPrice.toFixed(3)} (${(entryPrice * 100).toFixed(1)}% implied probability)

WALLET CONTEXT:
- This trader has won ${(walletWR * 100).toFixed(0)}% of their last ${walletTradeCount} trades

RULES:
- If entry price < 0.25 (longshot): these are HIGH-RISK HIGH-REWARD. Only challenge if the event has ALREADY been decided or is physically impossible.
- If the wallet WR is below 30%: flag this as a concern but still PROCEED unless there's a factual reason not to.
- Do NOT give generic risk warnings like "markets are uncertain" or "past performance doesn't guarantee future results".
- ONLY output CHALLENGE if you can name a specific factual reason (e.g., "this event already happened", "this team has been eliminated", "this market has already resolved").

Respond with ONLY a JSON object:
{"proceed": true, "reason": "no concrete objection"} OR {"proceed": false, "reason": "specific factual reason"}`;

    return this.callAPI<ChallengeResult>(prompt, (content) => {
      const parsed = JSON.parse(content) as ChallengeResult;
      return { proceed: parsed.proceed !== false, reason: parsed.reason || '' };
    }, {
      proceed: true,
      reason: 'Challenge unavailable — defaulting to proceed',
    });
  }

  getStats() {
    return {
      callCount: this.callCount,
      estimatedCost: 0,
      errorCount: this.errorCount,
      retryCount: this.retryCount,
    };
  }
}
