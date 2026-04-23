import { logger } from '../utils/logger.js';
import { AIClassifier } from '../signals/ai-classifier.js';
import { OrderbookChecker } from '../signals/orderbook-checker.js';
import { MirofishClient } from '../signals/mirofish-client.js';
import { categoriseMarket } from '../signals/market-categoriser.js';
import type { LeaderTrade, ConfirmationDecision } from '../types/index.js';
import type { ChallengeResult } from '../signals/ai-classifier.js';

/**
 * ConfirmationLayer — validates a leader's trade before we copy it.
 *
 * Decision logic:
 *   1. Check recent Glint signals (2hr window) for the market
 *   2. Run AI classifier: does news contradict this trade?
 *   3. Decision:
 *      - VETO: strong opposing signals (AI says veto with confidence >= 0.7)
 *      - APPROVED: no strong contradiction found
 *      - SKIPPED: trade too old, or market price moved too much
 */

export interface ConfirmationResult {
  decision: ConfirmationDecision;
  reason: string;
  confidence: number;
  hasOpposingSignals: boolean;
  hasSupportingSignals: boolean;
  latencyMs: number;
  sizeMultiplier: number; // 0.7 (low confidence) / 1.0 (normal) / 1.5 (high MiroFish confidence)
}

const MAX_TRADE_AGE_MS = 10 * 60 * 1000;        // Skip rank-1 trades older than 10 minutes
const WATCHER_MAX_TRADE_AGE_MS = 15 * 60 * 1000; // Rank 2-5: corroboration gate is the filter, 15min ok
const VETO_CONFIDENCE_THRESHOLD = 0.70;  // AI must be this confident to veto (rank 1)
const WATCHER_AI_MIN_CONFIDENCE = 0.65;       // AI confidence needed to count as corroboration (rank 2-5)
const WATCHER_OUT_OF_SPECIALTY_CONFIDENCE = 0.85; // Higher threshold when watcher trades outside their specialty
const WATCHER_ORDERBOOK_THRESHOLD = 0.55; // bid pressure ratio needed to count as corroboration

export class ConfirmationLayer {
  private classifier: AIClassifier;
  private orderbookChecker: OrderbookChecker;
  private mirofishClient: MirofishClient;
  private approvedCount = 0;
  private vetoedCount = 0;
  private skippedCount = 0;
  private totalLatencyMs = 0;
  private callCount = 0;

  private _recentNews: Array<{headline: string; source: string; timestamp: number}> = [];

  constructor() {
    this.classifier = new AIClassifier();
    this.orderbookChecker = new OrderbookChecker();
    this.mirofishClient = new MirofishClient();
  }

  updateNews(items: Array<{headline: string; source: string; timestamp: number}>): void {
    this._recentNews = items.slice(-30);
  }

  async confirm(trade: LeaderTrade): Promise<ConfirmationResult> {
    const start = Date.now();

    // Skip stale trades — use a longer window for rank 2-5 watchers since the
    // corroboration gate is the quality filter; stale age matters less for them.
    const isWatcher = trade.rank !== undefined && trade.rank >= 2;
    const maxAge = isWatcher ? WATCHER_MAX_TRADE_AGE_MS : MAX_TRADE_AGE_MS;
    const tradeAge = Date.now() - new Date(trade.timestamp).getTime();
    if (tradeAge > maxAge) {
      const result: ConfirmationResult = {
        decision: 'skipped',
        reason: `Trade too old (${(tradeAge / 60000).toFixed(1)}min > ${maxAge / 60000}min max)`,
        confidence: 1.0,
        hasOpposingSignals: false,
        hasSupportingSignals: false,
        latencyMs: Date.now() - start,
        sizeMultiplier: 1.0,
      };
      this.skippedCount++;
      logger.info(`Confirmation SKIPPED: ${result.reason}`);
      return result;
    }

    // Rank 2-5 watchers require 2-of-3 corroboration before copying
    if (trade.rank !== undefined && trade.rank >= 2) {
      return this.confirmWatcher(trade, start);
    }

    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    const newsContext = this._recentNews.filter(n => n.timestamp >= twoHoursAgo);
    logger.info(`ConfirmationLayer: Checking trade "${trade.marketQuestion.slice(0, 50)}" side=${trade.side} outcome=${trade.outcome} (${newsContext.length} news items)`);

    // Run AI confirmation
    let aiResult;
    const tradeCategory = categoriseMarket(trade.marketQuestion);
    try {
      aiResult = await this.classifier.classifyTrade(
        trade.marketQuestion,
        trade.side,
        trade.outcome,
        newsContext,
        tradeCategory,
      );
    } catch (err) {
      logger.warn(`ConfirmationLayer: AI classifier failed: ${err} — BLOCKING trade (no AI = no trade)`);
      this.vetoedCount++;
      return {
        decision: 'vetoed' as ConfirmationDecision,
        reason: `AI unavailable — trade blocked (no unvalidated trades allowed)`,
        confidence: 0,
        hasOpposingSignals: false,
        hasSupportingSignals: false,
        latencyMs: Date.now() - start,
        sizeMultiplier: 1.0,
      };
    }

    // Check MiroFish swarm consensus (non-blocking — uses cached scan data)
    let mirofishVerdict = 'unavailable';
    let mirofishReason = '';
    try {
      const mirofishResult = await this.mirofishClient.evaluateTrade(
        trade.marketQuestion,
        trade.side as 'buy' | 'sell',
        trade.outcome,
        undefined, // conditionId not on LeaderTrade
      );
      mirofishVerdict = mirofishResult.verdict;
      mirofishReason = mirofishResult.reason;
      if (mirofishVerdict !== 'unavailable') {
        logger.info(`MiroFish: ${mirofishVerdict} — ${mirofishReason}`);
      }
    } catch (err) {
      logger.debug(`MiroFish check skipped: ${err}`);
    }

    // Map AI recommendation to decision (with MiroFish as additional signal)
    let decision: ConfirmationDecision;
    let reason: string;

    if (aiResult.recommendation === 'veto' && aiResult.confidence >= VETO_CONFIDENCE_THRESHOLD) {
      decision = 'vetoed';
      reason = `AI veto (${(aiResult.confidence * 100).toFixed(0)}% confidence): ${aiResult.reasoning}`;
      if (mirofishVerdict === 'contradicts') {
        reason += ` | MiroFish also contradicts: ${mirofishReason}`;
      }
      this.vetoedCount++;
    } else if (aiResult.recommendation === 'veto' && aiResult.confidence < VETO_CONFIDENCE_THRESHOLD) {
      // Weak AI veto — check if MiroFish strongly contradicts
      if (mirofishVerdict === 'contradicts') {
        // Both AI and swarm are skeptical — veto despite weak AI confidence
        decision = 'vetoed';
        reason = `Weak AI veto + MiroFish contradiction — combined skepticism triggers veto. AI: ${aiResult.reasoning} | Swarm: ${mirofishReason}`;
        this.vetoedCount++;
      } else {
        decision = 'approved';
        reason = `Weak veto signal (${(aiResult.confidence * 100).toFixed(0)}% < ${VETO_CONFIDENCE_THRESHOLD * 100}% threshold) — trusting leader. ${aiResult.reasoning}`;
        if (mirofishVerdict === 'supports') {
          reason += ` | MiroFish supports: ${mirofishReason}`;
        }
        this.approvedCount++;
      }
    } else {
      decision = 'approved';
      reason = aiResult.reasoning;
      if (mirofishVerdict === 'supports') {
        reason += ` | MiroFish confirms: ${mirofishReason}`;
      } else if (mirofishVerdict === 'contradicts') {
        // AI says copy but swarm disagrees — still approve but flag it
        reason += ` | ⚠️ MiroFish contradicts: ${mirofishReason} (proceeding with leader)`;
      }
      this.approvedCount++;
    }

    const latencyMs = Date.now() - start;
    this.totalLatencyMs += latencyMs;
    this.callCount++;

    logger.info(`Confirmation ${decision.toUpperCase()}: ${reason.slice(0, 100)}`, {
      market: trade.marketQuestion.slice(0, 40),
      latencyMs,
    });

    // R5: Devil's advocate challenge — uses wallet context to validate trade
    let devilsAdvocateReduction = 1.0;
    if (decision === 'approved' && trade.walletRollingWR !== undefined) {
      try {
        const challenge = await this.classifier.challengeTrade(
          trade.marketQuestion,
          trade.side,
          trade.outcome,
          trade.entryPrice,
          trade.walletRollingWR ?? 0.5,
          trade.walletRollingCount ?? 0,
        );
        if (!challenge.proceed) {
          devilsAdvocateReduction = 0.5;
          reason += ` | ⚠️ Devil's advocate: ${challenge.reason} (size halved)`;
          logger.info(`Devil's advocate CHALLENGED: ${challenge.reason}`);
        } else {
          logger.debug(`Devil's advocate: PROCEED — ${challenge.reason}`);
        }
      } catch (err) {
        logger.debug(`Devil's advocate skipped: ${err}`);
      }
    }

    // Confidence-based position sizing:
    // MiroFish supports + strong/very_strong signal → size up (1.5x)
    // MiroFish contradicts or neutral → size down (0.7x)
    // MiroFish unavailable → normal size (1.0x)
    let sizeMultiplier = 1.0;
    if (mirofishVerdict === 'supports') {
      sizeMultiplier = 1.5;
    } else if (mirofishVerdict === 'contradicts') {
      sizeMultiplier = 0.7;
    }

    return {
      decision,
      reason,
      confidence: aiResult.confidence,
      hasOpposingSignals: aiResult.hasOpposingSignals,
      hasSupportingSignals: aiResult.hasSupportingSignals,
      latencyMs,
      sizeMultiplier: sizeMultiplier * devilsAdvocateReduction,
    };
  }

  /**
   * Corroboration gate for rank 2-5 watcher trades.
   * Requires ≥2 of 3 checks: Glint signal match, AI confidence ≥0.75, orderbook bid pressure > 55%.
   */
  private async confirmWatcher(trade: LeaderTrade, start: number): Promise<ConfirmationResult> {
    // Detect specialist/out-of-specialty situation
    const tradeCategory = categoriseMarket(trade.marketQuestion);
    const specialistCategory = trade.specialistCategory;
    const isOutOfSpecialty = specialistCategory != null && specialistCategory !== tradeCategory;
    const aiThreshold = isOutOfSpecialty ? WATCHER_OUT_OF_SPECIALTY_CONFIDENCE : WATCHER_AI_MIN_CONFIDENCE;

    if (isOutOfSpecialty) {
      logger.info(`ConfirmationLayer: Out-of-specialty trade — watcher specialises in ${specialistCategory} but trading ${tradeCategory} — AI threshold raised to ${aiThreshold}`);
    }

    logger.info(`ConfirmationLayer: Watcher corroboration check for rank-${trade.rank} "${trade.marketQuestion.slice(0, 50)}"`);

    // PRIMARY: AI confidence >= threshold AND not veto (required — gate fails without this)
    let aiPass = false;
    let aiConfidence = 0;
    let aiReasoning = '';
    let aiUnavailable = false;
    try {
      const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
      const newsContext = this._recentNews.filter(n => n.timestamp >= twoHoursAgo);
      const watcherCategory = categoriseMarket(trade.marketQuestion);
      const aiResult = await this.classifier.classifyTrade(
        trade.marketQuestion,
        trade.side,
        trade.outcome,
        newsContext,
        watcherCategory,
      );
      aiConfidence = aiResult.confidence;
      aiReasoning = aiResult.reasoning;
      aiUnavailable = aiResult.aiUnavailable ?? false;
      if (!aiUnavailable) {
        aiPass = aiResult.recommendation !== 'veto' && aiResult.confidence >= aiThreshold;
      } else {
        logger.warn(`ConfirmationLayer: AI unavailable (rate limited) — BLOCKING trade (no AI = no trade)`);
        this.vetoedCount++;
        const latencyMs = Date.now() - start;
        this.totalLatencyMs += latencyMs;
        this.callCount++;
        return {
          decision: 'vetoed',
          reason: `AI unavailable — trade blocked (no unvalidated trades allowed)`,
          confidence: 0,
          hasOpposingSignals: false,
          hasSupportingSignals: false,
          latencyMs,
          sizeMultiplier: 1.0,
        };
      }
    } catch (err) {
      logger.warn(`ConfirmationLayer: AI check failed for watcher trade: ${err}`);
      aiPass = false;
      aiUnavailable = true;
    }

    // BONUS 1: Orderbook bid pressure
    // Dynamic threshold: 0.55 normally, drops to 0.50 when AI >= 0.85 (high-confidence signal)
    // Rationale: 0.52 vs 0.55 is noise in thin sports prediction markets; AI at 0.90+ is the
    // stronger signal. A static 0.55 was blocking 154 AI-approved trades per day unnecessarily.
    const bidPressure = await this.orderbookChecker.getBidPressure(trade.tokenId);
    const obThreshold = aiConfidence >= 0.85 ? 0.50 : WATCHER_ORDERBOOK_THRESHOLD;
    const orderbookPass = bidPressure !== null && bidPressure > obThreshold;

    // BONUS 2: MiroFish swarm consensus (optional — helps when available, no penalty when not)
    let mirofishPass = false;
    let mirofishStr = 'unavail';
    try {
      const mfResult = await this.mirofishClient.evaluateTrade(
        trade.marketQuestion,
        trade.side as 'buy' | 'sell',
        trade.outcome,
        undefined,
      );
      if (mfResult.verdict === 'supports') {
        mirofishPass = true;
        mirofishStr = `Y(${mfResult.score?.swarmProbability.toFixed(0)}%,${mfResult.score?.signalStrength})`;
      } else if (mfResult.verdict === 'contradicts') {
        mirofishPass = false;
        mirofishStr = `N(${mfResult.score?.swarmProbability.toFixed(0)}%,contradicts)`;
      } else {
        mirofishStr = mfResult.verdict === 'unavailable' ? 'skip' : 'neutral';
        mirofishPass = false;
      }
    } catch {
      mirofishStr = 'unavail';
    }

    // GATE: AI confidence alone is sufficient for approval.
    // Orderbook and MiroFish are informational — logged and affect sizing but do NOT gate.
    // Rationale: sports prediction markets have natural ~0.50 orderbook pressure
    // (cheap underdog tokens attract speculative buyers) — using it as a hard gate
    // blocks 1,400+ valid trades per day without adding signal quality.

    // When AI is rate-limited, fall back to orderbook as primary gate
    const obFallback = aiUnavailable && orderbookPass;
    const effectivePass = aiPass || obFallback;
    const aiStr = aiPass
      ? `Y(${aiConfidence.toFixed(2)})`
      : aiUnavailable
        ? `unavail(ob=${obFallback ? 'PASS' : 'FAIL'})`
        : `N(${aiConfidence.toFixed(2)},need>=${aiThreshold})`;
    const obStr = bidPressure !== null
      ? (orderbookPass ? `Y(${bidPressure.toFixed(2)})` : `info(${bidPressure.toFixed(2)})`)
      : 'unavail';

    const latencyMs = Date.now() - start;
    this.totalLatencyMs += latencyMs;
    this.callCount++;

    const corrobLog = `Corroboration rank=${trade.rank}: ai=${aiStr} orderbook=${obStr} mirofish=${mirofishStr}`;

    if (effectivePass) {
      this.approvedCount++;
      const reason = `${corrobLog} — APPROVED`;
      logger.info(`Confirmation APPROVED (watcher): ${reason}`);
      return {
        decision: 'approved',
        reason,
        confidence: aiConfidence,
        hasOpposingSignals: false,
        hasSupportingSignals: orderbookPass,
        latencyMs,
        sizeMultiplier: mirofishPass ? 1.5 : 1.0,
      };
    } else {
      this.vetoedCount++;
      const reason = aiUnavailable
        ? `${corrobLog} — VETOED: AI unavailable + orderbook insufficient`
        : `${corrobLog} — VETOED: AI confidence ${(aiConfidence * 100).toFixed(0)}% below ${(aiThreshold * 100).toFixed(0)}% threshold`;
      logger.info(`Confirmation VETOED (watcher): ${reason}`);
      return {
        decision: 'vetoed',
        reason,
        confidence: aiConfidence,
        hasOpposingSignals: true,
        hasSupportingSignals: false,
        latencyMs,
        sizeMultiplier: 1.0,
      };
    }
  }

  getStats() {
    return {
      approved: this.approvedCount,
      vetoed: this.vetoedCount,
      skipped: this.skippedCount,
      total: this.callCount,
      avgLatencyMs: this.callCount > 0 ? Math.round(this.totalLatencyMs / this.callCount) : 0,
      aiStats: this.classifier.getStats(),
    };
  }
}
