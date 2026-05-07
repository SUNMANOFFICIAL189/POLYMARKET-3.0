import { logger } from '../utils/logger.js';
import { PaperTradingEngine } from '../core/paper-trading.js';
import type { CopyTradeInput, PaperTradeResult } from '../core/paper-trading.js';
import { RiskManager } from '../core/risk-manager.js';
import type { TradingSignal } from '../signals/signal-generator.js';
import type { Trade } from '../types/index.js';
import { categoriseMarket } from '../signals/market-categoriser.js';

/**
 * SignalExecutor — executes trades from the signal-based original trading pipeline.
 *
 * Unlike CopyExecutor (which mirrors leaders), this executor enters positions
 * based on the bot's OWN AI-assessed news signals. Position sizing is based on
 * signal confidence, not leader proportionality.
 */

// BUY sizing (unchanged — penny BUY only at $20)
const BUY_SIZING_TIERS: Array<{ minConf: number; maxDollars: number }> = [
  { minConf: 0.65, maxDollars: 20 },
];

// SELL sizing — scaled up based on 74.3% WR across 35 trades
const SELL_SIZING_TIERS: Array<{ minConf: number; maxDollars: number }> = [
  { minConf: 0.90, maxDollars: 100 },
  { minConf: 0.85, maxDollars: 75 },
  { minConf: 0.75, maxDollars: 50 },
  { minConf: 0.65, maxDollars: 35 },
];

export class SignalExecutor {
  private paperEngine: PaperTradingEngine;
  private riskManager: RiskManager;
  private paperMode: boolean;
  private signalMarketIds: Set<string> = new Set(); // lightweight tracker — paper engine has the trades
  private recentlyClosedMarkets: Map<string, number> = new Map(); // marketId -> close timestamp
  private readonly REENTRY_COOLDOWN_MS = 15 * 60 * 1000; // 15 min cooldown after closing
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

    // Re-entry cooldown: prevent opening on a market we just closed (avoids Supabase race)
    const closedAt = this.recentlyClosedMarkets.get(marketId);
    if (closedAt && Date.now() - closedAt < this.REENTRY_COOLDOWN_MS) {
      return { success: false, reason: `Cooldown: ${marketId.slice(0, 20)} closed ${Math.round((Date.now() - closedAt) / 60000)}m ago` };
    }

    // Signal v2 — global BUY drop. Set SIGNAL_BUY_ENABLED=true to re-enable.
    if (signal.side === 'buy' && process.env.SIGNAL_BUY_ENABLED !== 'true') {
      logger.info(`SignalExecutor: SIGNAL V2 BUY DROP — "${marketQ.slice(0, 40)}" (set SIGNAL_BUY_ENABLED=true to override)`);
      return { success: false, reason: 'Signal v2: BUY disabled by default' };
    }

    // Signal v2 — SELL only on markets resolving within MAX_HOURS_SELL_RESOLUTION.
    // Long-dated SELLs at low entry prices carry asymmetric tail risk that doesn't
    // trigger stop-loss until catastrophic (see 2026-05-07 -$943 BTC trade).
    if (signal.side === 'sell') {
      const maxHours = Number(process.env.MAX_HOURS_SELL_RESOLUTION ?? '24') || 24;
      const endDateStr = signal.market.endDate;
      if (endDateStr) {
        const endTs = new Date(endDateStr).getTime();
        if (!isNaN(endTs)) {
          const hoursToResolution = (endTs - Date.now()) / 3600000;
          if (hoursToResolution > maxHours) {
            logger.info(`SignalExecutor: SIGNAL V2 SELL ENDDATE FILTER — "${marketQ.slice(0, 40)}" resolves in ${hoursToResolution.toFixed(1)}h (>${maxHours}h cap)`);
            return { success: false, reason: `Signal v2: resolution ${hoursToResolution.toFixed(1)}h > ${maxHours}h cap` };
          }
        }
      }
    }

    // Category gate: ban BUY on politics/geopolitical markets (0W/10L in data)
    // SELL on politics stays enabled (proven profitable)
    if (signal.side === 'buy') {
      const category = categoriseMarket(marketQ);
      if (category === 'politics') {
        logger.info(`SignalExecutor: CATEGORY GATE — BUY blocked on politics market: "${marketQ.slice(0, 40)}"`);
        return { success: false, reason: 'Category gate: BUY disabled for politics markets' };
      }
    }

    // Thesis-level dedup + Rule B: cap at 2 positions per thesis cluster
    // A "thesis" = markets sharing 3+ meaningful words (e.g. "US Iran peace deal" variants)
    // Block entry if 2+ existing positions already share the same thesis
    const STOP = new Set(['will','the','and','for','by','on','in','to','of','a','be','or','is']);
    const newWords = new Set(marketQ.toLowerCase().split(/\s+/).filter(w => w.length > 2 && !STOP.has(w)));
    const MAX_THESIS_POSITIONS = Number(process.env.MAX_THESIS_POSITIONS ?? '2') || 2;
    let thesisOverlapCount = 0;
    for (const existingTrade of this.getOpenTrades()) {
      const existingWords = new Set((existingTrade.question || '').toLowerCase().split(/\s+/).filter((w: string) => w.length > 2 && !STOP.has(w)));
      let overlap = 0;
      for (const w of newWords) { if (existingWords.has(w)) overlap++; }
      if (overlap >= 3) {
        thesisOverlapCount++;
        if (thesisOverlapCount >= MAX_THESIS_POSITIONS) {
          logger.info(`SignalExecutor: RULE B — thesis cap (${MAX_THESIS_POSITIONS}) reached for "${marketQ.slice(0, 30)}" — ${thesisOverlapCount} similar positions open`);
          return { success: false, reason: `Rule B: ${thesisOverlapCount} positions on same thesis (max ${MAX_THESIS_POSITIONS})` };
        }
      }
    }

    if (this.signalMarketIds.size >= this.maxOpenSignalPositions) {
      this.blockedCount++;
      return { success: false, reason: `Signal position cap ${this.maxOpenSignalPositions} reached` };
    }

    // Side-aware confidence-based sizing
    const tiers = signal.side === 'sell' ? SELL_SIZING_TIERS : BUY_SIZING_TIERS;
    let ourSize = 20;
    for (const tier of tiers) {
      if (signal.confidence >= tier.minConf) {
        ourSize = tier.maxDollars;
        break;
      }
    }
    const maxSignalSize = Number(process.env.MAX_SIGNAL_DOLLARS ?? '100') || 100;
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

    // Phase 3: minimum entry price floor — markets below $0.03 are near-zero
    // probability and almost always expire worthless. Skip them.
    const MIN_ENTRY_PRICE = Number(process.env.MIN_SIGNAL_ENTRY_PRICE ?? '0.03') || 0.03;
    if (entryPrice > 0 && entryPrice < MIN_ENTRY_PRICE) {
      logger.info('SignalExecutor: PRICE FLOOR — entry ' + entryPrice.toFixed(3) + ' < $' + MIN_ENTRY_PRICE.toFixed(2) + ' min — skipping penny market');
      return { success: false, reason: 'Entry price ' + entryPrice.toFixed(3) + ' below $' + MIN_ENTRY_PRICE.toFixed(2) + ' floor' };
    }

    // Side-specific floor for SELL — the very-cheap (≤0.05) bucket is where the
    // catastrophic class lives. Across 116 historical SELL closures, the ≤0.05
    // bucket netted -$840 driven by a single -$943 event; the 0.05-0.10 bucket
    // was +$104 with no large losses. This floor removes the catastrophic
    // bucket while preserving the profitable mid-cheap one.
    const MIN_SELL_ENTRY_PRICE = Number(process.env.MIN_SELL_ENTRY_PRICE ?? '0.05') || 0.05;
    if (signal.side === 'sell' && entryPrice > 0 && entryPrice < MIN_SELL_ENTRY_PRICE) {
      logger.info(`SignalExecutor: SELL FLOOR — entry ${entryPrice.toFixed(3)} < $${MIN_SELL_ENTRY_PRICE.toFixed(2)} min for SELL — skipping (asymmetric tail risk)`);
      return { success: false, reason: `SELL: entry ${entryPrice.toFixed(3)} below $${MIN_SELL_ENTRY_PRICE.toFixed(2)} SELL-floor` };
    }

    // Rule A: BUY restricted to penny markets only (<$0.05 entry)
    // Non-penny BUY: 19 trades, -$53.27, no edge. Penny BUY: 10 trades, +$236.17 (lottery ticket wins)
    if (signal.side === 'buy' && entryPrice >= 0.05) {
      logger.info('SignalExecutor: RULE A — non-penny BUY blocked (entry $' + entryPrice.toFixed(3) + ' >= $0.05)');
      return { success: false, reason: 'Rule A: BUY only allowed on penny markets (<$0.05)' };
    }

    // Block "Up or Down" coin-flip markets — no edge (50% base rate)
    if (marketQ.toLowerCase().includes('up or down')) {
      logger.info('SignalExecutor: COIN-FLIP BLOCK — "Up or Down" market blocked: "' + marketQ.slice(0, 40) + '"');
      return { success: false, reason: 'Coin-flip market blocked (up or down)' };
    }

    // SELL dead zone: $0.20-0.35 entry has 25% WR — cap at $20
    if (signal.side === 'sell' && entryPrice >= 0.20 && entryPrice < 0.35) {
      ourSize = Math.min(ourSize, 20);
    }

    // Final cap: max-loss-as-percentage-of-balance. For SELL, max-loss-per-share
    // = (1 − entry); at low entries this dramatically exceeds the dollar size.
    // Tunable via MAX_LOSS_PCT_PER_TRADE (default 5%). Returns 0 if the cap
    // would shrink the size below the minimum-economic floor — treat as skip.
    const cappedSize = this.riskManager.capByMaxLoss(ourSize, entryPrice, signal.side);
    if (cappedSize === 0) {
      logger.info(`SignalExecutor: MAX-LOSS CAP — ${signal.side.toUpperCase()} entry ${entryPrice.toFixed(3)} size $${ourSize.toFixed(2)} would exceed max-loss budget — rejecting`);
      return { success: false, reason: `Max-loss cap: ${signal.side} at ${entryPrice.toFixed(3)} too risky for current balance` };
    }
    if (cappedSize < ourSize) {
      logger.info(`SignalExecutor: MAX-LOSS CAP — ${signal.side.toUpperCase()} size reduced $${ourSize.toFixed(2)} → $${cappedSize.toFixed(2)} (entry ${entryPrice.toFixed(3)})`);
      ourSize = cappedSize;
    }

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
        endDate: signal.market.endDate ?? undefined,
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
    this.recentlyClosedMarkets.set(marketId, Date.now());

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

  registerExistingPosition(marketId: string): void {
    this.signalMarketIds.add(marketId);
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
