import { logger } from '../utils/logger.js';
import type { Leader } from '../types/index.js';

/**
 * TraderScorer — computes composite score for leaderboard traders.
 *
 * Formula: 40% win rate (30d) + 30% profit factor (14d) + 15% trade frequency + 15% recency
 *
 * Each component is normalized to 0-100 before weighting.
 */

const WEIGHTS = {
  winRate: 0.40,
  profitFactor: 0.30,
  frequency: 0.15,
  recency: 0.15,
};

// Normalization parameters
const PROFIT_FACTOR_MAX = 5.0;   // Profit factor >= 5 scores 100
const TRADE_FREQ_TARGET = 20;    // 20+ trades/30d scores 100 on frequency
const RECENCY_DECAY_DAYS = 7;    // No trade in 7 days = 0 recency score

export class TraderScorer {
  /**
   * Score a single leader. Returns the leader with compositeScore updated.
   */
  score(leader: Leader): Leader {
    const winRateScore = this.scoreWinRate(leader.winRate30d);
    const profitFactorScore = this.scoreProfitFactor(leader.profitFactor14d);
    const frequencyScore = this.scoreFrequency(leader.tradeCount30d);
    const recencyScore = this.scoreRecency(leader.lastTradeTime);

    let compositeScore =
      winRateScore * WEIGHTS.winRate +
      profitFactorScore * WEIGHTS.profitFactor +
      frequencyScore * WEIGHTS.frequency +
      recencyScore * WEIGHTS.recency;

    // Specialist bonus: domain experts outperform generalists (+3 points)
    if (leader.specialistCategory) {
      compositeScore += 3;
    }

    return {
      ...leader,
      compositeScore: Math.round(compositeScore * 100) / 100,
      updatedAt: new Date().toISOString(),
    };
  }

  /**
   * Score and rank all leaders.
   */
  scoreAndRank(leaders: Leader[]): Leader[] {
    const scored = leaders.map(l => this.score(l));
    scored.sort((a, b) => b.compositeScore - a.compositeScore);
    return scored;
  }

  /**
   * Win rate: 0-1 range → 0-100 score
   * Linear: 0% win rate = 0, 100% win rate = 100
   * But heavily rewards above 60%:
   *   <50% → proportional (0-50)
   *   50-60% → 50-65
   *   60-75% → 65-85
   *   75%+ → 85-100
   */
  private scoreWinRate(winRate: number): number {
    const pct = Math.min(1, Math.max(0, winRate));
    if (pct >= 0.75) return 85 + (pct - 0.75) * (15 / 0.25);
    if (pct >= 0.60) return 65 + (pct - 0.60) * (20 / 0.15);
    if (pct >= 0.50) return 50 + (pct - 0.50) * (15 / 0.10);
    return pct * 100;
  }

  /**
   * Profit factor: total gains / total losses
   * 1.0 = breakeven = 50 score
   * 2.0 = good = 70 score
   * 5.0+ = excellent = 100 score
   * <1.0 = losing money = 0-50 score
   */
  private scoreProfitFactor(profitFactor: number): number {
    if (!profitFactor || profitFactor <= 0) return 0;
    if (profitFactor >= PROFIT_FACTOR_MAX) return 100;
    if (profitFactor >= 1.0) {
      return 50 + ((profitFactor - 1.0) / (PROFIT_FACTOR_MAX - 1.0)) * 50;
    }
    // Below 1.0: losing money (profit factor = 0 to 1)
    return profitFactor * 50;
  }

  /**
   * Trade frequency: rewards active traders
   * 0 trades = 0, TARGET trades = 100
   */
  private scoreFrequency(tradeCount30d: number): number {
    return Math.min(100, (tradeCount30d / TRADE_FREQ_TARGET) * 100);
  }

  /**
   * Recency: penalizes inactive traders
   * Trade today = 100, trade RECENCY_DECAY_DAYS ago = 0
   */
  private scoreRecency(lastTradeTime?: string): number {
    if (!lastTradeTime) return 0;

    try {
      const lastTrade = new Date(lastTradeTime).getTime();
      const now = Date.now();
      const daysSince = (now - lastTrade) / (1000 * 60 * 60 * 24);

      if (daysSince < 0) return 100; // Future timestamp (data error) = treat as recent
      if (daysSince >= RECENCY_DECAY_DAYS) return 0;

      return Math.round(((RECENCY_DECAY_DAYS - daysSince) / RECENCY_DECAY_DAYS) * 100);
    } catch {
      return 0;
    }
  }

  /**
   * Log score breakdown for a leader (debugging).
   */
  logBreakdown(leader: Leader): void {
    const winRateScore = this.scoreWinRate(leader.winRate30d);
    const profitFactorScore = this.scoreProfitFactor(leader.profitFactor14d);
    const frequencyScore = this.scoreFrequency(leader.tradeCount30d);
    const recencyScore = this.scoreRecency(leader.lastTradeTime);

    logger.info(`Scorer breakdown for ${leader.walletAddress.slice(0, 10)}...`, {
      winRate: `${(leader.winRate30d * 100).toFixed(1)}% → ${winRateScore.toFixed(1)}`,
      profitFactor: `${leader.profitFactor14d.toFixed(2)} → ${profitFactorScore.toFixed(1)}`,
      frequency: `${leader.tradeCount30d} trades → ${frequencyScore.toFixed(1)}`,
      recency: `${recencyScore.toFixed(1)}`,
      composite: leader.compositeScore.toFixed(2),
    });
  }
}
