import { logger } from '../utils/logger.js';
import { AIClassifier } from '../signals/ai-classifier.js';
import { OrderbookChecker } from '../signals/orderbook-checker.js';
import { categoriseMarket } from '../signals/market-categoriser.js';
import type { GlintAdapter } from '../signals/glint-adapter.js';
import type { LeaderTrade, ConfirmationDecision } from '../types/index.js';
import type { ConfirmationConfig } from '../core/config.js';

/**
 * ConfirmationLayer — validates a leader's trade before we copy it.
 *
 * Decision logic (configurable via env vars):
 *   Rank-1: only veto if AI confidence >= threshold (default 0.85)
 *   Rank 2-5: require N-of-3 corroboration (default 1-of-3)
 */

export interface ConfirmationResult {
  decision: ConfirmationDecision;
  reason: string;
  confidence: number;
  hasOpposingSignals: boolean;
  hasSupportingSignals: boolean;
  latencyMs: number;
}

interface TimestampedDecision {
  timestamp: number;
  decision: ConfirmationDecision;
}

export class ConfirmationLayer {
  private classifier: AIClassifier;
  private orderbookChecker: OrderbookChecker;
  private glintAdapter: GlintAdapter | null;
  private config: ConfirmationConfig;
  private approvedCount = 0;
  private vetoedCount = 0;
  private skippedCount = 0;
  private totalLatencyMs = 0;
  private callCount = 0;
  private recentDecisions: TimestampedDecision[] = [];

  constructor(
    apiKey: string,
    glintAdapter: GlintAdapter | null = null,
    config?: ConfirmationConfig,
  ) {
    this.classifier = new AIClassifier(apiKey);
    this.orderbookChecker = new OrderbookChecker();
    this.glintAdapter = glintAdapter;
    this.config = config ?? {
      vetoConfidenceThreshold: 0.85,
      watcherAiMinConfidence: 0.65,
      watcherOutOfSpecialtyConfidence: 0.75,
      watcherOrderbookThreshold: 0.55,
      watcherMinCorroborations: 1,
      maxTradeAgeMs: 5 * 60 * 1000,
      watcherMaxTradeAgeMs: 15 * 60 * 1000,
    };
  }

  async confirm(trade: LeaderTrade): Promise<ConfirmationResult> {
    const start = Date.now();

    // Skip stale trades
    const isWatcher = trade.rank !== undefined && trade.rank >= 2;
    const maxAge = isWatcher ? this.config.watcherMaxTradeAgeMs : this.config.maxTradeAgeMs;
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
      this.trackDecision('skipped');
      logger.info(`Confirmation SKIPPED: ${result.reason}`);
      return result;
    }

    // Rank 2-5 watchers require corroboration before copying
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

    // Out-of-specialty check for rank-1: use a slightly lower veto threshold
    const tradeCategory = categoriseMarket(trade.marketQuestion);
    const isOutOfSpecialty = trade.specialistCategory != null && trade.specialistCategory !== tradeCategory;
    const effectiveThreshold = isOutOfSpecialty
      ? this.config.vetoConfidenceThreshold * 0.85 // ~0.72 for out-of-specialty rank-1
      : this.config.vetoConfidenceThreshold;

    if (isOutOfSpecialty) {
      logger.info(`ConfirmationLayer: Rank-1 out-of-specialty (${trade.specialistCategory}→${tradeCategory}) — veto threshold lowered to ${effectiveThreshold.toFixed(2)}`);
    }

    if (aiResult.recommendation === 'veto' && aiResult.confidence >= effectiveThreshold) {
      decision = 'vetoed';
      reason = `AI veto (${(aiResult.confidence * 100).toFixed(0)}% confidence${isOutOfSpecialty ? ', out-of-specialty' : ''}): ${aiResult.reasoning}`;
      this.vetoedCount++;
    } else if (aiResult.recommendation === 'veto' && aiResult.confidence < effectiveThreshold) {
      // Weak veto signal — still approve (trust the leader)
      decision = 'approved';
      reason = `Weak veto signal (${(aiResult.confidence * 100).toFixed(0)}% < ${(effectiveThreshold * 100).toFixed(0)}% threshold) — trusting leader. ${aiResult.reasoning}`;
      this.approvedCount++;
    } else {
      decision = 'approved';
      reason = aiResult.reasoning;
      this.approvedCount++;
    }

    const latencyMs = Date.now() - start;
    this.totalLatencyMs += latencyMs;
    this.callCount++;
    this.trackDecision(decision);

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
   * Requires N-of-3 checks (configurable, default 1-of-3).
   */
  private async confirmWatcher(trade: LeaderTrade, start: number): Promise<ConfirmationResult> {
    // Detect specialist/out-of-specialty situation
    const tradeCategory = categoriseMarket(trade.marketQuestion);
    const specialistCategory = trade.specialistCategory;
    const isOutOfSpecialty = specialistCategory != null && specialistCategory !== tradeCategory;
    const aiThreshold = isOutOfSpecialty
      ? this.config.watcherOutOfSpecialtyConfidence
      : this.config.watcherAiMinConfidence;

    if (isOutOfSpecialty) {
      logger.info(`ConfirmationLayer: Out-of-specialty trade — watcher specialises in ${specialistCategory} but trading ${tradeCategory} — AI threshold raised to ${aiThreshold}`);
    }

    logger.info(`ConfirmationLayer: Watcher corroboration check for rank-${trade.rank} "${trade.marketQuestion.slice(0, 50)}"`);

    // Check 1: Glint — any recent signal for this market within 2hr window
    const glintSignals = this.glintAdapter
      ? this.glintAdapter.getSignalsForMarket(trade.marketQuestion)
      : [];
    const glintPass = glintSignals.length > 0;

    // Check 2: AI confidence >= threshold AND not a veto recommendation
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
      aiPass = aiResult.recommendation !== 'veto' && aiResult.confidence >= aiThreshold;
    } catch (err) {
      logger.warn(`ConfirmationLayer: AI check failed for watcher trade: ${err}`);
      aiPass = false;
    }

    // Check 3: Orderbook bid pressure > threshold
    const bidPressure = await this.orderbookChecker.getBidPressure(trade.tokenId);
    const orderbookPass = bidPressure !== null && bidPressure > this.config.watcherOrderbookThreshold;

    const passes = [glintPass, aiPass, orderbookPass].filter(Boolean).length;
    // If orderbook data is unavailable, only 2 checks possible — scale threshold accordingly
    const checksAvailable = bidPressure !== null ? 3 : 2;
    const threshold = Math.min(this.config.watcherMinCorroborations, checksAvailable);

    const glintStr = glintPass ? `Y(${glintSignals.length}sig)` : 'N';
    const aiStr = aiPass ? `Y(${aiConfidence.toFixed(2)})` : `N(${aiConfidence.toFixed(2)},need≥${aiThreshold})`;
    const obStr = bidPressure !== null
      ? (orderbookPass ? `Y(${bidPressure.toFixed(2)})` : `N(${bidPressure.toFixed(2)})`)
      : 'unavail';

    const latencyMs = Date.now() - start;
    this.totalLatencyMs += latencyMs;
    this.callCount++;

    const corrobLog = `Corroboration rank=${trade.rank}: glint=${glintStr} ai=${aiStr} orderbook=${obStr} → ${passes}/${threshold} needed`;

    if (passes >= threshold) {
      this.approvedCount++;
      this.trackDecision('approved');
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
      this.trackDecision('vetoed');
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

  private trackDecision(decision: ConfirmationDecision): void {
    this.recentDecisions.push({ timestamp: Date.now(), decision });
    // Keep only last 24hr
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    this.recentDecisions = this.recentDecisions.filter(d => d.timestamp > cutoff);
    // Warn if veto rate is too high
    const vetoRate = this.getVetoRate24h();
    if (this.recentDecisions.length >= 10 && vetoRate > 0.60) {
      logger.warn(`HIGH VETO RATE: ${(vetoRate * 100).toFixed(1)}% over last 24hr (${this.recentDecisions.length} decisions) — consider tuning thresholds`);
    }
  }

  getVetoRate24h(): number {
    if (this.recentDecisions.length === 0) return 0;
    const vetoed = this.recentDecisions.filter(d => d.decision === 'vetoed').length;
    return vetoed / this.recentDecisions.length;
  }

  getStats() {
    return {
      approved: this.approvedCount,
      vetoed: this.vetoedCount,
      skipped: this.skippedCount,
      total: this.callCount,
      vetoRate24h: this.getVetoRate24h(),
      avgLatencyMs: this.callCount > 0 ? Math.round(this.totalLatencyMs / this.callCount) : 0,
      aiStats: this.classifier.getStats(),
    };
  }
}
