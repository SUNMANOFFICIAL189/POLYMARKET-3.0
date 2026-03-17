import { logger } from '../utils/logger.js';
import { RiskDial } from './config.js';
import { RiskManager } from './risk-manager.js';
import type { Trade, DailyPerformance, RiskLevel, Side } from '../types/index.js';
import { randomUUID } from 'crypto';

export interface CopyTradeInput {
  marketId: string;
  question: string;
  tokenId: string;
  outcome: string;
  side: Side;
  usdcSize: number;
  leaderEntryPrice: number;
  riskLevel: RiskLevel;
}

export interface PaperTradeResult {
  trade: Trade;
  executionPrice: number;
  slippage: number;
}

export class PaperTradingEngine {
  private riskDial: RiskDial;
  private riskManager: RiskManager;
  private balance: number;
  private initialBalance: number;
  private openTrades: Map<string, Trade> = new Map();
  private closedTrades: Trade[] = [];
  private dailyPnl: number = 0;
  private currentDate: string = '';
  private openMarketIds: Set<string> = new Set();

  constructor(balance: number, riskLevel: RiskLevel = 'paper') {
    this.balance = balance;
    this.initialBalance = balance;
    this.riskDial = new RiskDial(riskLevel);
    this.riskManager = new RiskManager(this.riskDial, balance);
    this.currentDate = new Date().toISOString().split('T')[0];
    logger.info('PaperTradingEngine initialized', { balance: `$${balance}`, riskLevel });
  }

  hasOpenPositionForMarket(marketId: string): boolean {
    return this.openMarketIds.has(marketId);
  }

  executeCopyTrade(input: CopyTradeInput): PaperTradeResult | null {
    // One position per market
    if (this.openMarketIds.has(input.marketId)) {
      logger.warn(`Paper: Already have open position for market ${input.marketId.slice(0, 12)}...`);
      return null;
    }

    const riskCheck = this.riskManager.checkTrade(input.usdcSize);
    if (!riskCheck.allowed) {
      logger.warn(`Paper trade blocked: ${riskCheck.reason}`);
      return null;
    }

    // Simulate slippage: 0.1% - 0.5%
    const slippagePct = 0.001 + Math.random() * 0.004;
    const slippage = input.leaderEntryPrice * slippagePct;
    const executionPrice = input.side === 'buy'
      ? input.leaderEntryPrice + slippage
      : input.leaderEntryPrice - slippage;

    const shares = input.usdcSize / executionPrice;

    const trade: Trade = {
      id: randomUUID(),
      marketId: input.marketId,
      question: input.question,
      tokenId: input.tokenId || `paper-${randomUUID().slice(0, 8)}`,
      outcome: input.outcome,
      side: input.side,
      entryPrice: executionPrice,
      size: shares,
      usdcAmount: input.usdcSize,
      convictionScore: 75, // Copy trade — we trust the leader
      riskLevel: input.riskLevel,
      status: 'open',
      stopLoss: this.riskDial.config.stopLossPct,
      signalIds: [],
      entryTime: new Date().toISOString(),
    };

    this.balance -= input.usdcSize;
    this.openTrades.set(trade.id, trade);
    this.openMarketIds.add(input.marketId);
    this.syncState();

    logger.info('Paper copy trade OPENED', {
      id: trade.id.slice(0, 8),
      market: trade.question.slice(0, 50),
      side: trade.side,
      outcome: trade.outcome,
      price: executionPrice.toFixed(4),
      size: `$${input.usdcSize}`,
    });

    return { trade, executionPrice, slippage };
  }

  closeTrade(tradeId: string, currentPrice: number, reason = 'leader_closed'): Trade | null {
    const trade = this.openTrades.get(tradeId);
    if (!trade) { logger.error(`Trade ${tradeId} not found`); return null; }

    const { pnl, pnlPct } = this.riskManager.calculatePnl(trade, currentPrice);
    trade.exitPrice = currentPrice;
    trade.exitTime = new Date().toISOString();
    trade.pnl = pnl;
    trade.pnlPct = pnlPct;
    trade.status = 'closed';

    this.balance += trade.usdcAmount + pnl;
    this.dailyPnl += pnl;
    if (pnl > 0) this.riskDial.recordWin(); else this.riskDial.recordLoss();

    this.openTrades.delete(tradeId);
    this.openMarketIds.delete(trade.marketId);
    this.closedTrades.push(trade);
    this.syncState();

    logger.info(`Paper copy trade CLOSED (${reason})`, {
      id: tradeId.slice(0, 8),
      market: trade.question.slice(0, 40),
      pnl: `$${pnl.toFixed(2)}`,
      pnlPct: `${pnlPct.toFixed(1)}%`,
      balance: `$${this.balance.toFixed(2)}`,
    });

    return trade;
  }

  closeTradeByMarketId(marketId: string, currentPrice: number, reason = 'leader_closed'): Trade | null {
    for (const [tradeId, trade] of this.openTrades) {
      if (trade.marketId === marketId) {
        return this.closeTrade(tradeId, currentPrice, reason);
      }
    }
    return null;
  }

  checkStopLosses(priceMap: Map<string, number>): Trade[] {
    const stopped: Trade[] = [];
    for (const [tradeId, trade] of this.openTrades) {
      const price = priceMap.get(trade.marketId);
      if (price !== undefined && this.riskManager.checkStopLoss(trade, price)) {
        const closed = this.closeTrade(tradeId, price, 'stop-loss');
        if (closed) stopped.push(closed);
      }
    }
    return stopped;
  }

  handleDayRollover(): DailyPerformance | null {
    const today = new Date().toISOString().split('T')[0];
    if (today === this.currentDate) return null;

    const dayTrades = this.closedTrades.filter(t => {
      const exitStr = typeof t.exitTime === 'string' ? t.exitTime : t.exitTime?.toISOString?.() ?? '';
      return exitStr.split('T')[0] === this.currentDate;
    });
    const wins = dayTrades.filter(t => (t.pnl ?? 0) > 0).length;
    const losses = dayTrades.filter(t => (t.pnl ?? 0) <= 0).length;
    const exposure = Array.from(this.openTrades.values()).reduce((s, t) => s + t.usdcAmount, 0);

    const perf: DailyPerformance = {
      date: this.currentDate,
      pnl: this.dailyPnl,
      pnlPct: this.initialBalance > 0 ? (this.dailyPnl / this.initialBalance) * 100 : 0,
      tradesExecuted: dayTrades.length,
      tradesVetoed: 0,
      wins,
      losses,
      winRate: dayTrades.length > 0 ? (wins / dayTrades.length) * 100 : 0,
      maxDrawdown: this.riskManager.getPortfolioRisk().maxDrawdown,
      exposure,
      riskLevel: this.riskDial.level,
    };

    logger.info(`Day ${this.currentDate} rollover`, {
      pnl: `$${this.dailyPnl.toFixed(2)}`,
      trades: dayTrades.length,
      balance: `$${this.balance.toFixed(2)}`,
    });

    this.currentDate = today;
    this.dailyPnl = 0;
    this.riskManager.resetDaily();
    return perf;
  }

  private syncState(): void {
    this.riskManager.updateBalance(this.balance);
    this.riskManager.setOpenTrades(Array.from(this.openTrades.values()));
    this.riskManager.updateDailyPnl(this.dailyPnl);
  }

  getBalance(): number { return this.balance; }
  getOpenTrades(): Trade[] { return Array.from(this.openTrades.values()); }
  getClosedTrades(): Trade[] { return [...this.closedTrades]; }
  getRiskDial(): RiskDial { return this.riskDial; }
  getRiskManager(): RiskManager { return this.riskManager; }

  getStats() {
    const totalTrades = this.closedTrades.length;
    const wins = this.closedTrades.filter(t => (t.pnl ?? 0) > 0).length;
    const totalPnl = this.closedTrades.reduce((s, t) => s + (t.pnl ?? 0), 0);
    return {
      balance: this.balance,
      initialBalance: this.initialBalance,
      totalReturn: ((this.balance - this.initialBalance) / this.initialBalance) * 100,
      totalPnl,
      totalTrades,
      openTrades: this.openTrades.size,
      wins,
      losses: totalTrades - wins,
      winRate: totalTrades > 0 ? (wins / totalTrades) * 100 : 0,
      riskLevel: this.riskDial.level,
      portfolioRisk: this.riskManager.getPortfolioRisk(),
    };
  }
}
