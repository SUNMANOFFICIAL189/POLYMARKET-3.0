import { logger } from '../utils/logger.js';
import { PaperTradingEngine } from '../core/paper-trading.js';
import { RiskManager } from '../core/risk-manager.js';
import * as cliWrapper from './cli-wrapper.js';
import type { LeaderTrade, CopyTrade, ConfirmationDecision, RiskLevel } from '../types/index.js';

/**
 * CopyExecutor — mirrors a leader's trade with proportional position sizing.
 *
 * Sizing formula:
 *   our_size = (leader_size / leader_portfolio) * our_portfolio
 *   Capped at risk manager's maxPositionSize
 *
 * Paper mode: uses PaperTradingEngine
 * Live mode: uses Polymarket CLI (Phase 3)
 */

export interface ExecutionResult {
  success: boolean;
  copyTrade?: CopyTrade;
  reason?: string;
}

const RANK_MULTIPLIERS: Record<number, number> = {
  1: 1.00,
  2: 0.60,
  3: 0.50,
  4: 0.40,
  5: 0.30,
};

// Watcher trades will not fill beyond (maxPositions - RANK1_RESERVED) slots.
// Ensures the rank-1 leader always has capacity to copy when they trade.
const RANK1_RESERVED_SLOTS = 2;

// Skip near-certainty bets: price > this threshold or < (1 - threshold) have
// near-zero alpha — the edge is already fully priced in.
const MAX_WATCHER_PRICE = 0.92;
const MIN_WATCHER_PRICE = 0.08;

// Edge floor: prices within 6% of 0.5 (0.44–0.56) represent genuine uncertainty —
// no measurable directional edge. Top performers enter at ≥6% deviation from consensus
// (PANews 112K wallet study; min edge = 6-11% from midpoint).
const EDGE_FLOOR_DISTANCE = 0.06;

export class CopyExecutor {
  private paperEngine: PaperTradingEngine;
  private riskManager: RiskManager;
  private paperMode: boolean;
  private ourPortfolio: number;
  private riskLevel: RiskLevel;
  private openCopyTrades: Map<string, CopyTrade> = new Map(); // marketId → CopyTrade
  // marketId → rank of the watcher who opened the position (for collision detection)
  private watcherPositions: Map<string, number> = new Map();
  private executedCount = 0;
  private blockedCount = 0;

  constructor(opts: {
    paperEngine: PaperTradingEngine;
    riskManager: RiskManager;
    paperMode: boolean;
    ourPortfolio: number;
    riskLevel: RiskLevel;
  }) {
    this.paperEngine = opts.paperEngine;
    this.riskManager = opts.riskManager;
    this.paperMode = opts.paperMode;
    this.ourPortfolio = opts.ourPortfolio;
    this.riskLevel = opts.riskLevel;
  }

  updatePortfolio(balance: number): void {
    this.ourPortfolio = balance;
  }

  /**
   * Hydrate open positions from Supabase rows so that close detection works after restart.
   */
  hydrateOpenTrades(rows: Array<Record<string, unknown>>): void {
    for (const row of rows) {
      const marketId = row.market_id as string;
      if (!marketId || this.openCopyTrades.has(marketId)) continue;
      const copyTrade: CopyTrade = {
        id: row.id as string,
        leaderWallet: row.leader_wallet as string,
        leaderTradeId: row.leader_trade_id as string | undefined,
        marketId,
        marketQuestion: row.market_question as string,
        tokenId: row.token_id as string | undefined,
        outcome: row.outcome as string,
        side: row.side as 'buy' | 'sell',
        leaderEntryPrice: row.leader_entry_price as number,
        ourEntryPrice: row.our_entry_price as number | undefined,
        ourSize: row.our_size as number,
        confirmationResult: row.confirmation_result as ConfirmationDecision,
        confirmationReason: row.confirmation_reason as string | undefined,
        status: 'open',
        riskLevel: row.risk_level as RiskLevel,
        entryTime: row.entry_time as string,
        createdAt: row.created_at as string | undefined,
      };
      this.openCopyTrades.set(marketId, copyTrade);
    }
    logger.info(`CopyExecutor: Hydrated ${this.openCopyTrades.size} open positions from Supabase`);
  }

  hasOpenPositionForMarket(marketId: string): boolean {
    return this.openCopyTrades.has(marketId) || this.paperEngine.hasOpenPositionForMarket(marketId);
  }

  /**
   * Execute a copy of the leader's trade.
   */
  async execute(
    leaderTrade: LeaderTrade,
    confirmation: ConfirmationDecision,
    confirmationReason: string,
    leaderPortfolioSize: number,
  ): Promise<ExecutionResult> {

    if (confirmation !== 'approved') {
      const copyTrade: CopyTrade = {
        leaderWallet: leaderTrade.leaderWallet,
        leaderTradeId: leaderTrade.tradeId,
        marketId: leaderTrade.marketId,
        marketQuestion: leaderTrade.marketQuestion,
        tokenId: leaderTrade.tokenId,
        outcome: leaderTrade.outcome,
        side: leaderTrade.side,
        leaderEntryPrice: leaderTrade.entryPrice,
        ourSize: 0,
        confirmationResult: confirmation,
        confirmationReason,
        status: 'vetoed',
        riskLevel: this.riskLevel,
        entryTime: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      };
      this.blockedCount++;
      return { success: false, copyTrade, reason: confirmationReason };
    }

    // Rank-1 collision: if a watcher opened this market, close it and re-enter at full rank-1 size
    const isRank1 = !leaderTrade.rank || leaderTrade.rank === 1;
    if (isRank1 && this.watcherPositions.has(leaderTrade.marketId)) {
      const watcherRank = this.watcherPositions.get(leaderTrade.marketId)!;
      logger.info(`CopyExecutor: Rank-1 collision — closing rank-${watcherRank} watcher position for ${leaderTrade.marketId.slice(0, 12)}, re-entering at rank-1 size`);
      await this.closePosition(leaderTrade.marketId, leaderTrade.entryPrice, 'rank1_override');
      this.watcherPositions.delete(leaderTrade.marketId);
    }

    // For rank 2-5 watcher trades: apply extra filters before using a position slot
    if (leaderTrade.rank && leaderTrade.rank >= 2) {
      // Filter 1: near-certainty bets have near-zero alpha — skip them
      const price = leaderTrade.entryPrice;
      if (price > MAX_WATCHER_PRICE || price < MIN_WATCHER_PRICE) {
        this.blockedCount++;
        logger.info(`CopyExecutor: Watcher trade skipped — near-certainty price $${price.toFixed(3)} outside [${MIN_WATCHER_PRICE}, ${MAX_WATCHER_PRICE}] range`);
        return { success: false, reason: `Near-certainty price $${price.toFixed(3)} — no alpha to copy` };
      }

      // Filter 2: edge floor — dead zone within 6% of 0.5 has no measurable directional edge
      if (Math.abs(price - 0.5) < EDGE_FLOOR_DISTANCE) {
        this.blockedCount++;
        logger.info(`CopyExecutor: Watcher trade skipped — dead zone price $${price.toFixed(3)} (within ${EDGE_FLOOR_DISTANCE} of 0.5, no measurable edge)`);
        return { success: false, reason: `Dead zone price $${price.toFixed(3)} — within ${EDGE_FLOOR_DISTANCE * 100}% of 0.5, no measurable edge` };
      }

      // Filter 3: reserve slots for rank-1 leader
      // watcherPositions tracks open positions opened by rank 2-5 trades
      const maxPos = parseInt(process.env.MAX_OPEN_POSITIONS ?? '10');
      const watcherLimit = Math.max(1, maxPos - RANK1_RESERVED_SLOTS);
      if (this.watcherPositions.size >= watcherLimit) {
        this.blockedCount++;
        logger.debug(`CopyExecutor: Watcher slot limit reached (${this.watcherPositions.size}/${watcherLimit}) — reserving ${RANK1_RESERVED_SLOTS} for rank-1`);
        return { success: false, reason: `Watcher slot limit ${watcherLimit} reached — slots reserved for rank-1` };
      }
    }

    // Reject trades with no market identifier — can't track or close them reliably
    if (!leaderTrade.marketId) {
      this.blockedCount++;
      logger.warn(`CopyExecutor: Trade has empty marketId — skipping (market="${leaderTrade.marketQuestion.slice(0, 40)}")`);
      return { success: false, reason: 'Trade missing marketId — cannot open position' };
    }

    // Already have a position in this market (from rank-1 trade or unresolved state)
    if (this.hasOpenPositionForMarket(leaderTrade.marketId)) {
      this.blockedCount++;
      return { success: false, reason: `Already have open position in market ${leaderTrade.marketId.slice(0, 12)}` };
    }

    // Calculate proportional size, then apply rank multiplier for rank 2-5
    let ourSize = this.calculateSize(leaderTrade.size, leaderPortfolioSize);
    const rank = leaderTrade.rank ?? 1;
    const multiplier = RANK_MULTIPLIERS[rank] ?? RANK_MULTIPLIERS[5];
    if (rank > 1) {
      ourSize = Math.round(ourSize * multiplier * 100) / 100;
      logger.info(`CopyExecutor: Rank-scaled: rank=${rank} multiplier=${multiplier} → $${ourSize.toFixed(2)}`);
    }

    if (ourSize < 1) {
      this.blockedCount++;
      return { success: false, reason: `Computed size $${ourSize.toFixed(2)} too small (min $1)` };
    }

    logger.info(`CopyExecutor: ${this.paperMode ? '[PAPER]' : '[LIVE]'} Copying trade`, {
      market: leaderTrade.marketQuestion.slice(0, 50),
      side: leaderTrade.side,
      outcome: leaderTrade.outcome,
      leaderSize: `$${leaderTrade.size.toFixed(2)}`,
      ourSize: `$${ourSize.toFixed(2)}`,
      price: leaderTrade.entryPrice.toFixed(4),
    });

    if (this.paperMode) {
      return this.executePaper(leaderTrade, ourSize, confirmation, confirmationReason);
    } else {
      return this.executeLive(leaderTrade, ourSize, confirmation, confirmationReason);
    }
  }

  private executePaper(
    leaderTrade: LeaderTrade,
    ourSize: number,
    confirmation: ConfirmationDecision,
    confirmationReason: string,
  ): ExecutionResult {
    const result = this.paperEngine.executeCopyTrade({
      marketId: leaderTrade.marketId,
      question: leaderTrade.marketQuestion,
      tokenId: leaderTrade.tokenId || '',
      outcome: leaderTrade.outcome,
      side: leaderTrade.side,
      usdcSize: ourSize,
      leaderEntryPrice: leaderTrade.entryPrice,
      riskLevel: this.riskLevel,
    });

    if (!result) {
      this.blockedCount++;
      return { success: false, reason: 'Paper engine blocked trade (risk limits)' };
    }

    const copyTrade: CopyTrade = {
      id: result.trade.id,
      leaderWallet: leaderTrade.leaderWallet,
      leaderTradeId: leaderTrade.tradeId,
      marketId: leaderTrade.marketId,
      marketQuestion: leaderTrade.marketQuestion,
      tokenId: leaderTrade.tokenId,
      outcome: leaderTrade.outcome,
      side: leaderTrade.side,
      leaderEntryPrice: leaderTrade.entryPrice,
      ourEntryPrice: result.executionPrice,
      ourSize,
      confirmationResult: confirmation,
      confirmationReason,
      status: 'open',
      riskLevel: this.riskLevel,
      entryTime: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      watcherRank: leaderTrade.rank,
    };

    this.openCopyTrades.set(leaderTrade.marketId, copyTrade);
    if (leaderTrade.rank && leaderTrade.rank > 1) {
      this.watcherPositions.set(leaderTrade.marketId, leaderTrade.rank);
    }
    this.executedCount++;

    return { success: true, copyTrade };
  }

  private async executeLive(
    leaderTrade: LeaderTrade,
    ourSize: number,
    confirmation: ConfirmationDecision,
    confirmationReason: string,
  ): Promise<ExecutionResult> {
    try {
      if (!leaderTrade.tokenId) {
        return { success: false, reason: 'No tokenId for live execution' };
      }

      const result = await cliWrapper.smartOrder(leaderTrade.tokenId, leaderTrade.side, ourSize);

      if (!result.success) {
        this.blockedCount++;
        return { success: false, reason: `CLI order failed` };
      }

      const copyTrade: CopyTrade = {
        leaderWallet: leaderTrade.leaderWallet,
        leaderTradeId: leaderTrade.tradeId,
        marketId: leaderTrade.marketId,
        marketQuestion: leaderTrade.marketQuestion,
        tokenId: leaderTrade.tokenId,
        outcome: leaderTrade.outcome,
        side: leaderTrade.side,
        leaderEntryPrice: leaderTrade.entryPrice,
        ourEntryPrice: leaderTrade.entryPrice,
        ourSize,
        confirmationResult: confirmation,
        confirmationReason,
        status: 'open',
        riskLevel: this.riskLevel,
        entryTime: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      };

      this.openCopyTrades.set(leaderTrade.marketId, copyTrade);
      this.executedCount++;
      return { success: true, copyTrade };

    } catch (err) {
      this.blockedCount++;
      return { success: false, reason: `Live execution error: ${err}` };
    }
  }

  /**
   * Close our copy position when the leader closes theirs.
   * Returns the closed CopyTrade (with pnl filled in) on success, null if no position found.
   */
  async closePosition(marketId: string, currentPrice: number, reason = 'leader_closed'): Promise<CopyTrade | null> {
    const copyTrade = this.openCopyTrades.get(marketId);

    if (this.paperMode) {
      const closed = this.paperEngine.closeTradeByMarketId(marketId, currentPrice, reason);
      if (closed) {
        if (copyTrade) {
          copyTrade.status = 'closed';
          copyTrade.pnl = closed.pnl;
          copyTrade.exitTime = typeof closed.exitTime === 'string' ? closed.exitTime : closed.exitTime?.toISOString();
          this.openCopyTrades.delete(marketId);
        }
        this.watcherPositions.delete(marketId);
        return copyTrade ?? null;
      }
    } else {
      // Live mode: execute sell order
      if (copyTrade?.tokenId) {
        try {
          await cliWrapper.smartOrder(copyTrade.tokenId, 'sell', copyTrade.ourSize);
          copyTrade.status = 'closed';
          this.openCopyTrades.delete(marketId);
          this.watcherPositions.delete(marketId);
          return copyTrade;
        } catch (err) {
          logger.error(`CopyExecutor: Live close failed for market ${marketId}: ${err}`);
        }
      }
    }

    return null;
  }

  /**
   * Proportional sizing: (leader_size / leader_portfolio) * our_portfolio
   * Capped at risk manager's max position size.
   */
  private calculateSize(leaderSize: number, leaderPortfolio: number): number {
    if (leaderPortfolio <= 0) {
      // Fallback: use 2% of our portfolio
      return this.ourPortfolio * 0.02;
    }

    const ratio = leaderSize / leaderPortfolio;
    const rawSize = ratio * this.ourPortfolio;

    const maxSize = this.riskManager.checkTrade(rawSize).maxAllowedSize ?? rawSize;
    const capped = Math.min(rawSize, maxSize);

    // Also respect our max position size from risk dial
    const riskCheck = this.riskManager.checkTrade(capped);
    if (!riskCheck.allowed && riskCheck.maxAllowedSize !== undefined) {
      return riskCheck.maxAllowedSize;
    }

    return Math.round(capped * 100) / 100;
  }

  getOpenTrades(): CopyTrade[] { return Array.from(this.openCopyTrades.values()); }

  getStats() {
    return {
      executed: this.executedCount,
      blocked: this.blockedCount,
      openPositions: this.openCopyTrades.size,
      paperMode: this.paperMode,
    };
  }
}
