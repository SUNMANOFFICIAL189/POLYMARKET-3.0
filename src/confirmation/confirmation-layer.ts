import { logger } from '../utils/logger.js';
import { AIClassifier } from '../signals/ai-classifier.js';
import { OrderbookChecker } from '../signals/orderbook-checker.js';
import type { GlintAdapter } from '../signals/glint-adapter.js';
import type { LeaderTrade, ConfirmationDecision } from '../types/index.js';

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
}

const MAX_TRADE_AGE_MS = 5 * 60 * 1000;         // Skip rank-1 trades older than 5 minutes
const WATCHER_MAX_TRADE_AGE_MS = 15 * 60 * 1000; // Rank 2-5: corroboration gate is the filter, 15min ok
const VETO_CONFIDENCE_THRESHOLD = 0.70;  // AI must be this confident to veto (rank 1)
const WATCHER_AI_MIN_CONFIDENCE = 0.75;  // AI confidence needed to count as corroboration (rank 2-5)
const WATCHER_ORDERBOOK_THRESHOLD = 0.55; // bid pressure ratio needed to count as corroboration
const WATCHER_MIN_CORROBORATIONS = 2;    // out of 3 checks must pass for rank 2-5 trades

export class ConfirmationLayer {
  private classifier: AIClassifier;
  private orderbookChecker: OrderbookChecker;
  private glintAdapter: GlintAdapter | null;
  private approvedCount = 0;
  private vetoedCount = 0;
  private skippedCount = 0;
  private totalLatencyMs = 0;
  private callCount = 0;

  constructor(
    apiKey: string,
    glintAdapter: GlintAdapter | null = null,
  ) {
    this.classifier = new AIClassifier(apiKey);
    this.orderbookChecker = new OrderbookChecker();
    this.glintAdapter = glintAdapter;
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
      };
      this.skippedCount++;
      logger.info(`Confirmation SKIPPED: ${result.reason}`);
      return result;
    }

    // Rank 2-5 watchers require 2-of-3 corroboration before copying
    if (trade.rank !== undefined && trade.rank >= 2) {
      return this.confirmWatcher(trade, start);
    }

    // Gather recent news signals for this market
    const recentSignals = this.glintAdapter
      ? this.glintAdapter.getSignalsForMarket(trade.marketQuestion)
      : [];

    const newsContext = recentSignals.map(s => ({
      headline: s.headline,
      source: s.source,
      timestamp: s.timestamp,
    }));

    logger.info(`ConfirmationLayer: Checking trade "${trade.marketQuestion.slice(0, 50)}" side=${trade.side} outcome=${trade.outcome}`, {
      glintSignals: recentSignals.length,
    });

    // Run AI confirmation
    let aiResult;
    try {
      aiResult = await this.classifier.classifyTrade(
        trade.marketQuestion,
        trade.side,
        trade.outcome,
        newsContext,
      );
    } catch (err) {
      logger.warn(`ConfirmationLayer: AI classifier failed: ${err} — defaulting to approve`);
      aiResult = {
        recommendation: 'copy' as const,
        confidence: 0.5,
        reasoning: 'AI failed — defaulting to copy (trust leader)',
        hasOpposingSignals: false,
        hasSupportingSignals: false,
      };
    }

    // Map AI recommendation to decision
    let decision: ConfirmationDecision;
    let reason: string;

    if (aiResult.recommendation === 'veto' && aiResult.confidence >= VETO_CONFIDENCE_THRESHOLD) {
      decision = 'vetoed';
      reason = `AI veto (${(aiResult.confidence * 100).toFixed(0)}% confidence): ${aiResult.reasoning}`;
      this.vetoedCount++;
    } else if (aiResult.recommendation === 'veto' && aiResult.confidence < VETO_CONFIDENCE_THRESHOLD) {
      // Weak veto signal — still approve (trust the leader)
      decision = 'approved';
      reason = `Weak veto signal (${(aiResult.confidence * 100).toFixed(0)}% < ${VETO_CONFIDENCE_THRESHOLD * 100}% threshold) — trusting leader. ${aiResult.reasoning}`;
      this.approvedCount++;
    } else {
      decision = 'approved';
      reason = aiResult.reasoning;
      this.approvedCount++;
    }

    const latencyMs = Date.now() - start;
    this.totalLatencyMs += latencyMs;
    this.callCount++;

    logger.info(`Confirmation ${decision.toUpperCase()}: ${reason.slice(0, 100)}`, {
      market: trade.marketQuestion.slice(0, 40),
      latencyMs,
    });

    return {
      decision,
      reason,
      confidence: aiResult.confidence,
      hasOpposingSignals: aiResult.hasOpposingSignals,
      hasSupportingSignals: aiResult.hasSupportingSignals,
      latencyMs,
    };
  }

  /**
   * Corroboration gate for rank 2-5 watcher trades.
   * Requires ≥2 of 3 checks: Glint signal match, AI confidence ≥0.75, orderbook bid pressure > 55%.
   */
  private async confirmWatcher(trade: LeaderTrade, start: number): Promise<ConfirmationResult> {
    logger.info(`ConfirmationLayer: Watcher corroboration check for rank-${trade.rank} "${trade.marketQuestion.slice(0, 50)}"`);

    // Check 1: Glint — any recent signal for this market within 2hr window
    const glintSignals = this.glintAdapter
      ? this.glintAdapter.getSignalsForMarket(trade.marketQuestion)
      : [];
    const glintPass = glintSignals.length > 0;

    // Check 2: AI confidence ≥ 0.75 AND not a veto recommendation
    let aiPass = false;
    let aiConfidence = 0;
    let aiReasoning = '';
    try {
      const newsContext = glintSignals.map(s => ({
        headline: s.headline,
        source: s.source,
        timestamp: s.timestamp,
      }));
      const aiResult = await this.classifier.classifyTrade(
        trade.marketQuestion,
        trade.side,
        trade.outcome,
        newsContext,
      );
      aiConfidence = aiResult.confidence;
      aiReasoning = aiResult.reasoning;
      aiPass = aiResult.recommendation !== 'veto' && aiResult.confidence >= WATCHER_AI_MIN_CONFIDENCE;
    } catch (err) {
      logger.warn(`ConfirmationLayer: AI check failed for watcher trade: ${err}`);
      aiPass = false;
    }

    // Check 3: Orderbook bid pressure > 55%
    const bidPressure = await this.orderbookChecker.getBidPressure(trade.tokenId);
    const orderbookPass = bidPressure !== null && bidPressure > WATCHER_ORDERBOOK_THRESHOLD;

    const passes = [glintPass, aiPass, orderbookPass].filter(Boolean).length;
    // If orderbook data is unavailable (tokenId missing or market not on CLOB), only 2 checks
    // are possible. In that case require 1/2 instead of 2/3 to avoid permanently blocking all
    // watcher trades from markets that don't have CLOB coverage (e.g. sports prediction markets).
    const checksAvailable = bidPressure !== null ? 3 : 2;
    const threshold = checksAvailable === 2 ? 1 : WATCHER_MIN_CORROBORATIONS;

    const glintStr = glintPass ? `Y(${glintSignals.length}sig)` : 'N';
    const aiStr = aiPass ? `Y(${aiConfidence.toFixed(2)})` : `N(${aiConfidence.toFixed(2)})`;
    const obStr = bidPressure !== null
      ? (orderbookPass ? `Y(${bidPressure.toFixed(2)})` : `N(${bidPressure.toFixed(2)})`)
      : 'unavail';

    const latencyMs = Date.now() - start;
    this.totalLatencyMs += latencyMs;
    this.callCount++;

    const corrobLog = `Corroboration rank=${trade.rank}: glint=${glintStr} ai=${aiStr} orderbook=${obStr} → ${passes}/${threshold} needed`;

    if (passes >= threshold) {
      this.approvedCount++;
      const reason = `${corrobLog} — APPROVED`;
      logger.info(`Confirmation APPROVED (watcher): ${reason}`);
      return {
        decision: 'approved',
        reason,
        confidence: aiConfidence,
        hasOpposingSignals: false,
        hasSupportingSignals: glintPass,
        latencyMs,
      };
    } else {
      this.vetoedCount++;
      const reason = `${corrobLog} — insufficient corroboration (${passes}/${threshold})`;
      logger.info(`Confirmation VETOED (watcher): ${reason}`);
      return {
        decision: 'vetoed',
        reason,
        confidence: aiConfidence,
        hasOpposingSignals: true,
        hasSupportingSignals: glintPass,
        latencyMs,
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
