import { logger } from '../utils/logger.js';
import { AIClassifier } from '../signals/ai-classifier.js';
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

const MAX_TRADE_AGE_MS = 5 * 60 * 1000; // Skip trades older than 5 minutes
const VETO_CONFIDENCE_THRESHOLD = 0.70;  // AI must be this confident to veto

export class ConfirmationLayer {
  private classifier: AIClassifier;
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
    this.glintAdapter = glintAdapter;
  }

  async confirm(trade: LeaderTrade): Promise<ConfirmationResult> {
    const start = Date.now();

    // Skip stale trades
    const tradeAge = Date.now() - new Date(trade.timestamp).getTime();
    if (tradeAge > MAX_TRADE_AGE_MS) {
      const result: ConfirmationResult = {
        decision: 'skipped',
        reason: `Trade too old (${(tradeAge / 60000).toFixed(1)}min > ${MAX_TRADE_AGE_MS / 60000}min max)`,
        confidence: 1.0,
        hasOpposingSignals: false,
        hasSupportingSignals: false,
        latencyMs: Date.now() - start,
      };
      this.skippedCount++;
      logger.info(`Confirmation SKIPPED: ${result.reason}`);
      return result;
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
