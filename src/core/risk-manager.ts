import { logger } from '../utils/logger.js';
import { RiskDial } from './config.js';
import type { Trade } from '../types/index.js';

export interface RiskCheck {
  allowed: boolean;
  reason?: string;
  maxAllowedSize?: number;
}

export interface PortfolioRisk {
  totalExposure: number;
  exposurePct: number;
  openPositions: number;
  dailyPnl: number;
  dailyPnlPct: number;
  maxDrawdown: number;
  riskUtilization: number;
}

export class RiskManager {
  private riskDial: RiskDial;
  private balance: number;
  private openTrades: Trade[] = [];
  private dailyPnl: number = 0;
  private peakBalance: number;
  private maxDrawdown: number = 0;

  constructor(riskDial: RiskDial, balance: number) {
    this.riskDial = riskDial;
    this.balance = balance;
    this.peakBalance = balance;
  }

  updateBalance(balance: number): void {
    this.balance = balance;
    if (balance > this.peakBalance) this.peakBalance = balance;
    const drawdown = (this.peakBalance - balance) / this.peakBalance;
    if (drawdown > this.maxDrawdown) this.maxDrawdown = drawdown;
  }

  setOpenTrades(trades: Trade[]): void { this.openTrades = trades; }
  updateDailyPnl(pnl: number): void { this.dailyPnl = pnl; }
  resetDaily(): void { this.dailyPnl = 0; logger.info('Daily risk counters reset'); }

  checkTrade(usdcAmount: number): RiskCheck {
    const preset = this.riskDial.config;
    const maxPosition = this.riskDial.maxPositionSize(this.balance);
    if (usdcAmount > maxPosition) {
      return { allowed: false, reason: `Position $${usdcAmount.toFixed(2)} exceeds max $${maxPosition.toFixed(2)}`, maxAllowedSize: maxPosition };
    }
    if (this.openTrades.length >= preset.maxOpenPositions) {
      return { allowed: false, reason: `Max open positions (${this.openTrades.length}/${preset.maxOpenPositions})` };
    }
    const currentExposure = this.openTrades.reduce((sum, t) => sum + t.usdcAmount, 0);
    const maxExposure = this.riskDial.maxExposure(this.balance);
    if (currentExposure + usdcAmount > maxExposure) {
      return { allowed: false, reason: `Exposure limit exceeded`, maxAllowedSize: Math.max(0, maxExposure - currentExposure) };
    }
    const maxDailyLoss = this.riskDial.maxDailyLoss(this.balance);
    if (this.dailyPnl <= -maxDailyLoss) {
      return { allowed: false, reason: `Daily loss limit reached` };
    }
    const DRAWDOWN_LIMIT = Number(process.env.DRAWDOWN_LIMIT_PCT ?? '0.14') || 0.14;
    const currentDrawdown = (this.peakBalance - this.balance) / this.peakBalance;
    if (currentDrawdown > DRAWDOWN_LIMIT) {
      return {
        allowed: false,
        reason: `Drawdown circuit breaker ${(currentDrawdown * 100).toFixed(1)}% > ${(DRAWDOWN_LIMIT * 100).toFixed(0)}% limit`,
      };
    }
    return { allowed: true };
  }

  checkStopLoss(trade: Trade, currentPrice: number): boolean {
    if (trade.side === 'buy') {
      const stopPrice = trade.entryPrice * (1 - trade.stopLoss);
      if (currentPrice <= stopPrice) {
        logger.warn(`Stop loss hit for ${trade.id}`, { entry: trade.entryPrice, current: currentPrice, stop: stopPrice });
        return true;
      }
    } else {
      const stopPrice = trade.entryPrice * (1 + trade.stopLoss);
      if (currentPrice >= stopPrice) {
        logger.warn(`Stop loss hit for ${trade.id}`, { entry: trade.entryPrice, current: currentPrice, stop: stopPrice });
        return true;
      }
    }
    return false;
  }

  calculatePnl(trade: Trade, currentPrice: number): { pnl: number; pnlPct: number } {
    const pnl = trade.side === 'buy'
      ? (currentPrice - trade.entryPrice) * trade.size
      : (trade.entryPrice - currentPrice) * trade.size;
    return { pnl: Math.round(pnl * 100) / 100, pnlPct: Math.round((pnl / trade.usdcAmount) * 10000) / 100 };
  }

  getPortfolioRisk(): PortfolioRisk {
    const totalExposure = this.openTrades.reduce((sum, t) => sum + t.usdcAmount, 0);
    const maxExposure = this.riskDial.maxExposure(this.balance);
    return {
      totalExposure,
      exposurePct: this.balance > 0 ? (totalExposure / this.balance) * 100 : 0,
      openPositions: this.openTrades.length,
      dailyPnl: this.dailyPnl,
      dailyPnlPct: this.balance > 0 ? (this.dailyPnl / this.balance) * 100 : 0,
      maxDrawdown: this.maxDrawdown * 100,
      riskUtilization: maxExposure > 0 ? totalExposure / maxExposure : 0,
    };
  }
}
