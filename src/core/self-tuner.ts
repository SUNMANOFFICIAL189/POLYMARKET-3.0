import { logger } from '../utils/logger.js';
import * as db from '../data/supabase.js';

/**
 * SelfTuner — daily self-analysis of trading performance.
 *
 * Queries the last 7 days of copy_trades from Supabase and recommends
 * threshold adjustments based on actual results.
 *
 * Rules:
 *   - Win rate < 50% → suggest tightening veto threshold
 *   - Win rate > 65% and veto rate > 50% → suggest loosening veto threshold
 *   - No trades in 48hrs → warn that bot may be over-filtering
 */

export interface TunerResult {
  action: string;
  reason: string;
  metrics: {
    winRate: number;
    totalTrades: number;
    closedTrades: number;
    vetoRate: number;
    avgPnl: number;
  };
}

export class SelfTuner {
  async analyze(): Promise<TunerResult | null> {
    const client = db.getClient();
    if (!client) return null;

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    // Get all trades from last 7 days
    const { data: trades } = await client
      .from('copy_trades')
      .select('status, pnl, confirmation_result, created_at')
      .gte('created_at', sevenDaysAgo);

    if (!trades || trades.length === 0) {
      return {
        action: 'NO_DATA',
        reason: 'No trades in last 7 days — bot may not be running or is over-filtering',
        metrics: { winRate: 0, totalTrades: 0, closedTrades: 0, vetoRate: 0, avgPnl: 0 },
      };
    }

    const executed = trades.filter(t => t.status === 'open' || t.status === 'closed');
    const closed = trades.filter(t => t.status === 'closed' && t.pnl !== null);
    const vetoed = trades.filter(t => t.confirmation_result === 'vetoed');

    const wins = closed.filter(t => (t.pnl ?? 0) > 0);
    const winRate = closed.length > 0 ? wins.length / closed.length : 0;
    const vetoRate = trades.length > 0 ? vetoed.length / trades.length : 0;
    const avgPnl = closed.length > 0
      ? closed.reduce((sum, t) => sum + (t.pnl ?? 0), 0) / closed.length
      : 0;

    const metrics = {
      winRate,
      totalTrades: trades.length,
      closedTrades: closed.length,
      vetoRate,
      avgPnl,
    };

    // Check if bot hasn't executed any trades (over-filtering)
    if (executed.length === 0 && trades.length > 10) {
      return {
        action: 'LOOSEN_THRESHOLDS',
        reason: `${trades.length} trade opportunities seen but 0 executed — veto rate ${(vetoRate * 100).toFixed(0)}% is too high`,
        metrics,
      };
    }

    // Check win rate and suggest adjustments
    if (closed.length >= 5) {
      if (winRate < 0.50) {
        return {
          action: 'TIGHTEN_THRESHOLDS',
          reason: `Win rate ${(winRate * 100).toFixed(0)}% < 50% over ${closed.length} closed trades — consider lowering veto threshold`,
          metrics,
        };
      }

      if (winRate > 0.65 && vetoRate > 0.50) {
        return {
          action: 'LOOSEN_THRESHOLDS',
          reason: `Win rate ${(winRate * 100).toFixed(0)}% is strong but veto rate ${(vetoRate * 100).toFixed(0)}% is high — could trade more aggressively`,
          metrics,
        };
      }
    }

    // Everything looks healthy
    logger.info(`SelfTuner: Performance healthy — WR=${(winRate * 100).toFixed(0)}% VR=${(vetoRate * 100).toFixed(0)}% AvgPnL=$${avgPnl.toFixed(2)} (${closed.length} closed, ${executed.length} executed, ${trades.length} total)`);
    return null;
  }
}
