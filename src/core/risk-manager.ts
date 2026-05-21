import { logger } from '../utils/logger.js';
import { RiskDial } from './config.js';
import type { PipelineId, Trade } from '../types/index.js';

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

/**
 * Drawdown circuit breaker state. Fired on TRIP and RELEASE transitions so
 * the runner can emit a Telegram alert. Phase 1.4 (2026-05-21) — added after
 * the geopolitics breaker silently blocked 100+ Car trades for 3 days because
 * nothing was watching it.
 */
export interface BreakerStateChange {
  pipelineId: PipelineId | 'global';
  transition: 'trip' | 'release';
  peakBalance: number;
  currentBalance: number;
  drawdownPct: number;
  limitPct: number;
}

export interface BreakerState {
  tripped: boolean;
  peakBalance: number;
  currentBalance: number;
  drawdownPct: number;
  limitPct: number;
}

export class RiskManager {
  /**
   * The pipeline this RiskManager belongs to. Each pipeline holds its own
   * isolated risk state — balance, peakBalance, drawdown, position cap.
   * A loss on one pipeline does NOT affect another's risk gates.
   * (Option D, 2026-05-10. See vault Decision Log.)
   *
   * The literal 'signal'|'copy'|'geopolitics' values come from the PipelineId
   * type; the literal 'global' is reserved for PaperTradingEngine's internal
   * summary instance which tracks the bot-wide cash ledger across pipelines.
   */
  readonly pipelineId: PipelineId | 'global';

  private riskDial: RiskDial;
  private balance: number;
  private openTrades: Trade[] = [];
  private dailyPnl: number = 0;
  private peakBalance: number;
  private maxDrawdown: number = 0;
  private onPeakBalanceChange?: (peak: number) => void;
  private breakerTripped: boolean = false;
  private onBreakerStateChange?: (change: BreakerStateChange) => void;

  constructor(pipelineId: PipelineId | 'global', riskDial: RiskDial, balance: number, opts?: {
    restoredPeakBalance?: number;
    onPeakBalanceChange?: (peak: number) => void;
    onBreakerStateChange?: (change: BreakerStateChange) => void;
  }) {
    this.pipelineId = pipelineId;
    this.riskDial = riskDial;
    this.balance = balance;
    this.onPeakBalanceChange = opts?.onPeakBalanceChange;
    this.onBreakerStateChange = opts?.onBreakerStateChange;
    this.peakBalance = Math.max(balance, opts?.restoredPeakBalance ?? balance);
    if (this.peakBalance > balance) {
      logger.info(`RiskManager[${pipelineId}]: Restored peakBalance $${this.peakBalance.toFixed(2)} from persistence (current: $${balance.toFixed(2)}, DD: ${(((this.peakBalance - balance) / this.peakBalance) * 100).toFixed(1)}%)`);
    }
  }

  /**
   * Phase 1.4 (2026-05-21): one-shot peakBalance reset. Used at boot via
   * the GEOPOLITICS_RESET_PEAK_ON_BOOT env flag to re-arm the breaker after
   * the early-soak balthazar losses tripped it permanently. Safe to call at
   * any time but typically only at controlled boot.
   */
  resetPeakBalance(newPeak: number): void {
    const oldPeak = this.peakBalance;
    const oldTripped = this.breakerTripped;
    this.peakBalance = newPeak;
    this.maxDrawdown = 0;
    this.breakerTripped = false;
    this.onPeakBalanceChange?.(this.peakBalance);
    logger.info(`RiskManager[${this.pipelineId}]: peakBalance manually reset $${oldPeak.toFixed(2)} → $${newPeak.toFixed(2)} (DD now 0%, breaker armed=${!this.breakerTripped})`);
    if (oldTripped) {
      const limitPct = Number(process.env.DRAWDOWN_LIMIT_PCT ?? '0.14') || 0.14;
      this.onBreakerStateChange?.({
        pipelineId: this.pipelineId,
        transition: 'release',
        peakBalance: newPeak,
        currentBalance: this.balance,
        drawdownPct: 0,
        limitPct,
      });
    }
  }

  getBreakerState(): BreakerState {
    const limitPct = Number(process.env.DRAWDOWN_LIMIT_PCT ?? '0.14') || 0.14;
    const drawdownPct = this.peakBalance > 0
      ? (this.peakBalance - this.balance) / this.peakBalance
      : 0;
    return {
      tripped: this.breakerTripped,
      peakBalance: this.peakBalance,
      currentBalance: this.balance,
      drawdownPct,
      limitPct,
    };
  }

  /**
   * Recompute breaker state from current balance/peak and fire transitions.
   * Called whenever balance changes and from checkTrade() so the state stays
   * coherent. Skipped for the 'global' RM (paper-engine ledger) — see Option D.
   */
  private updateBreakerState(): void {
    if (this.pipelineId === 'global') return;
    const limitPct = Number(process.env.DRAWDOWN_LIMIT_PCT ?? '0.14') || 0.14;
    const drawdownPct = this.peakBalance > 0
      ? (this.peakBalance - this.balance) / this.peakBalance
      : 0;
    const shouldBeTripped = drawdownPct > limitPct;
    if (shouldBeTripped && !this.breakerTripped) {
      this.breakerTripped = true;
      this.onBreakerStateChange?.({
        pipelineId: this.pipelineId,
        transition: 'trip',
        peakBalance: this.peakBalance,
        currentBalance: this.balance,
        drawdownPct,
        limitPct,
      });
    } else if (!shouldBeTripped && this.breakerTripped) {
      this.breakerTripped = false;
      this.onBreakerStateChange?.({
        pipelineId: this.pipelineId,
        transition: 'release',
        peakBalance: this.peakBalance,
        currentBalance: this.balance,
        drawdownPct,
        limitPct,
      });
    }
  }

  updateBalance(balance: number): void {
    this.balance = balance;
    if (balance > this.peakBalance) {
      this.peakBalance = balance;
      this.onPeakBalanceChange?.(this.peakBalance);
    }
    const drawdown = (this.peakBalance - balance) / this.peakBalance;
    if (drawdown > this.maxDrawdown) this.maxDrawdown = drawdown;
    this.updateBreakerState();
  }

  setOpenTrades(trades: Trade[]): void { this.openTrades = trades; }
  updateDailyPnl(pnl: number): void { this.dailyPnl = pnl; }
  resetDaily(): void { this.dailyPnl = 0; logger.info(`RiskManager[${this.pipelineId}]: Daily risk counters reset`); }

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
    // Drawdown circuit breaker — pipeline-scoped only. Skip for the 'global'
    // RM (paper-engine cash ledger). Bot-wide DD bleeding across pipelines
    // breaks Option D isolation — see vault Decision Log 2026-05-12.
    // Phase 1.4 (2026-05-21): state transitions emit via onBreakerStateChange.
    if (this.pipelineId !== 'global') {
      this.updateBreakerState();
      const DRAWDOWN_LIMIT = Number(process.env.DRAWDOWN_LIMIT_PCT ?? '0.14') || 0.14;
      const currentDrawdown = (this.peakBalance - this.balance) / this.peakBalance;
      if (currentDrawdown > DRAWDOWN_LIMIT) {
        return {
          allowed: false,
          reason: `Drawdown circuit breaker [${this.pipelineId}] ${(currentDrawdown * 100).toFixed(1)}% > ${(DRAWDOWN_LIMIT * 100).toFixed(0)}% limit`,
        };
      }
    }
    return { allowed: true };
  }

  /**
   * Cap a proposed position size by max-loss-as-percentage-of-balance.
   *
   * For BUY: max loss per share = entry price (loss if YES → 0).
   * For SELL: max loss per share = (1 − entry price) (loss if YES → 1).
   *   At low entry prices, SELL exposure is asymmetrically large: a $75 SELL
   *   at entry 0.04 carries up to ~$1,800 max-loss exposure (24× the dollar
   *   size). The 2026-05-07 BTC-80k −$943 trade was exactly this class.
   *
   * Returns the (possibly reduced) size. Returns 0 if the cap would shrink
   * the position below the minimum-economic-size floor — caller should treat
   * 0 as "skip, not worth opening at this size."
   *
   * Tunable via MAX_LOSS_PCT_PER_TRADE (default 0.05 = 5% of balance).
   * Calibrated against 116 historical SELL closures: 5% rejects the
   * catastrophic ≤$0.05 entry-price bucket while allowing the slightly
   * profitable $0.05–$0.10 bucket through. See BACKLOG entry for analysis.
   */
  capByMaxLoss(rawSize: number, entryPrice: number, side: 'buy' | 'sell', minSize = 5): number {
    if (rawSize <= 0 || entryPrice <= 0 || entryPrice >= 1) return rawSize;
    const maxLossPct = Number(process.env.MAX_LOSS_PCT_PER_TRADE ?? '0.05') || 0.05;
    const maxLossDollars = maxLossPct * this.balance;
    const maxLossPerShare = side === 'sell' ? 1 - entryPrice : entryPrice;
    const shares = rawSize / entryPrice;
    const proposedMaxLoss = maxLossPerShare * shares;
    if (proposedMaxLoss <= maxLossDollars) return rawSize;
    const allowedShares = maxLossDollars / maxLossPerShare;
    const allowedSize = allowedShares * entryPrice;
    return allowedSize < minSize ? 0 : Math.floor(allowedSize * 100) / 100;
  }

  checkStopLoss(trade: Trade, currentPrice: number): boolean {
    if (trade.side === 'buy') {
      const stopPrice = trade.entryPrice * (1 - trade.stopLoss);
      if (currentPrice <= stopPrice) {
        logger.warn(`Stop loss hit for ${trade.id} [${this.pipelineId}]`, { entry: trade.entryPrice, current: currentPrice, stop: stopPrice });
        return true;
      }
    } else {
      const stopPrice = trade.entryPrice * (1 + trade.stopLoss);
      if (currentPrice >= stopPrice) {
        logger.warn(`Stop loss hit for ${trade.id} [${this.pipelineId}]`, { entry: trade.entryPrice, current: currentPrice, stop: stopPrice });
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
