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

export class CopyExecutor {
  private paperEngine: PaperTradingEngine;
  private riskManager: RiskManager;
  private paperMode: boolean;
  private ourPortfolio: number;
  private riskLevel: RiskLevel;
  private openCopyTrades: Map<string, CopyTrade> = new Map(); // marketId → CopyTrade
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

    // Already have a position in this market
    if (this.hasOpenPositionForMarket(leaderTrade.marketId)) {
      this.blockedCount++;
      return { success: false, reason: `Already have open position in market ${leaderTrade.marketId.slice(0, 12)}` };
    }

    // Calculate proportional size
    const ourSize = this.calculateSize(leaderTrade.size, leaderPortfolioSize);

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
    };

    this.openCopyTrades.set(leaderTrade.marketId, copyTrade);
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
   */
  async closePosition(marketId: string, currentPrice: number, reason = 'leader_closed'): Promise<boolean> {
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
        return true;
      }
    } else {
      // Live mode: execute sell order
      if (copyTrade?.tokenId) {
        try {
          await cliWrapper.smartOrder(copyTrade.tokenId, 'sell', copyTrade.ourSize);
          copyTrade.status = 'closed';
          this.openCopyTrades.delete(marketId);
          return true;
        } catch (err) {
          logger.error(`CopyExecutor: Live close failed for market ${marketId}: ${err}`);
        }
      }
    }

    return false;
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
