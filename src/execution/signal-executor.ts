import { logger } from '../utils/logger.js';
import { PaperTradingEngine } from '../core/paper-trading.js';
import type { CopyTradeInput, PaperTradeResult } from '../core/paper-trading.js';
import { RiskManager } from '../core/risk-manager.js';
import type { TradingSignal } from '../signals/signal-generator.js';
import type { Trade } from '../types/index.js';

/**
 * SignalExecutor — executes trades from the signal-based original trading pipeline.
 *
 * Unlike CopyExecutor (which mirrors leaders), this executor enters positions
 * based on the bot's OWN AI-assessed news signals. Position sizing is based on
 * signal confidence, not leader proportionality.
 */

const SIZING_TIERS: Array<{ minConf: number; maxDollars: number }> = [
  { minConf: 0.95, maxDollars: 50 },
  { minConf: 0.90, maxDollars: 35 },
  { minConf: 0.80, maxDollars: 20 },
];

export class SignalExecutor {
  private paperEngine: PaperTradingEngine;
  private riskManager: RiskManager;
  private paperMode: boolean;
  private signalMarketIds: Set<string> = new Set(); // lightweight tracker — paper engine has the trades
  private executedCount = 0;
  private blockedCount = 0;
  private maxOpenSignalPositions: number;

  constructor(opts: {
    paperEngine: PaperTradingEngine;
    riskManager: RiskManager;
    paperMode: boolean;
    maxOpenSignalPositions?: number;
  }) {
    this.paperEngine = opts.paperEngine;
    this.riskManager = opts.riskManager;
    this.paperMode = opts.paperMode;
    this.maxOpenSignalPositions = opts.maxOpenSignalPositions
      ?? (Number(process.env.MAX_SIGNAL_POSITIONS ?? '15') || 5);
  }

  async execute(signal: TradingSignal): Promise<{ success: boolean; reason: string; trade?: Trade }> {
    const marketId = signal.market.slug;
    const marketQ = signal.market.question;

    if (this.signalMarketIds.has(marketId) || this.paperEngine.hasOpenPosition(marketId)) {
      return { success: false, reason: `Already have position in ${marketId.slice(0, 20)}` };
    }

    // Thesis-level dedup: skip if any open position shares 3+ meaningful words
    // Prevents 7 positions on "US x Iran peace deal" variants
    const STOP = new Set(['will','the','and','for','by','on','in','to','of','a','be','or','is']);
    const newWords = new Set(marketQ.toLowerCase().split(/\s+/).filter(w => w.length > 2 && !STOP.has(w)));
    for (const existingTrade of this.getOpenTrades()) {
      const existingWords = new Set((existingTrade.question || '').toLowerCase().split(/\s+/).filter((w: string) => w.length > 2 && !STOP.has(w)));
      let overlap = 0;
      for (const w of newWords) { if (existingWords.has(w)) overlap++; }
      if (overlap >= 3) {
        return { success: false, reason: `Thesis dedup: "${marketQ.slice(0, 30)}" overlaps with existing position` };
      }
    }

    if (this.signalMarketIds.size >= this.maxOpenSignalPositions) {
      this.blockedCount++;
      return { success: false, reason: `Signal position cap ${this.maxOpenSignalPositions} reached` };
    }

    // Confidence-based sizing
    let ourSize = 20;
    for (const tier of SIZING_TIERS) {
      if (signal.confidence >= tier.minConf) {
        ourSize = tier.maxDollars;
        break;
      }
    }
    const maxSignalSize = Number(process.env.MAX_SIGNAL_DOLLARS ?? '50') || 50;
    if (ourSize > maxSignalSize) ourSize = maxSignalSize;

    const riskCheck = this.riskManager.checkTrade(ourSize);
    if (!riskCheck.allowed) {
      this.blockedCount++;
      logger.info(`SignalExecutor: Risk blocked — ${riskCheck.reason}`);
      return { success: false, reason: `Risk: ${riskCheck.reason}` };
    }

    const outcomeIdx = signal.market.outcomes.findIndex(
      o => o.toLowerCase() === 'yes' || o.toLowerCase() === signal.side
    );
    const entryPrice = outcomeIdx >= 0 && outcomeIdx < signal.market.outcomePrices.length
      ? signal.market.outcomePrices[outcomeIdx]
      : 0.5;

    logger.info(`SignalExecutor: ${this.paperMode ? '[PAPER]' : '[LIVE]'} SIGNAL TRADE`, {
      market: marketQ.slice(0, 50),
      side: signal.side,
      confidence: `${(signal.confidence * 100).toFixed(0)}%`,
      size: `$${ourSize.toFixed(2)}`,
      price: entryPrice.toFixed(3),
      news: signal.newsHeadline.slice(0, 60),
    });

    if (this.paperMode) {
      const input: CopyTradeInput = {
        marketId,
        question: marketQ,
        tokenId: signal.market.conditionId,
        outcome: signal.market.outcomes[outcomeIdx] ?? 'Yes',
        side: signal.side,
        usdcSize: ourSize,
        leaderEntryPrice: entryPrice,
        riskLevel: 'paper',
      };

      const result: PaperTradeResult | null = this.paperEngine.executeCopyTrade(input);
      if (result) {
        this.signalMarketIds.add(marketId);
        this.executedCount++;
        logger.info(`SignalExecutor: SIGNAL TRADE EXECUTED — $${ourSize.toFixed(2)} on "${marketQ.slice(0, 40)}" (${(signal.confidence * 100).toFixed(0)}% confidence)`);
        return { success: true, reason: 'Signal trade executed', trade: result.trade };
      }

      return { success: false, reason: 'Paper engine rejected trade' };
    }

    return { success: false, reason: 'Signal trading is paper-only for now' };
  }

  closePosition(marketId: string, exitPrice: number, reason: string): Trade | null {
    if (!this.signalMarketIds.has(marketId)) return null;

    if (this.paperMode) {
      const closed = this.paperEngine.closeTradeByMarketId(marketId, exitPrice, reason);
      if (closed) {
        this.signalMarketIds.delete(marketId);
        logger.info(`SignalExecutor: Signal position closed — "${marketId.slice(0, 30)}" pnl=$${closed.pnl?.toFixed(2) ?? 'n/a'} (${reason})`);
        return closed;
      }
    }

    this.signalMarketIds.delete(marketId);
    return null;
  }

  getOpenTrades(): Trade[] {
    // Paper engine is sole source of truth. We just know which IDs are ours.
    const paperTrades = this.paperEngine.getOpenTradesList();
    // Purge IDs for trades the paper engine no longer has
    for (const id of this.signalMarketIds) {
      if (!this.paperEngine.hasOpenPosition(id)) {
        this.signalMarketIds.delete(id);
      }
    }
    return paperTrades.filter(t => this.signalMarketIds.has(t.marketId));
  }

  getStats() {
    return {
      executed: this.executedCount,
      blocked: this.blockedCount,
      openPositions: this.signalMarketIds.size,
      maxPositions: this.maxOpenSignalPositions,
    };
  }
}
