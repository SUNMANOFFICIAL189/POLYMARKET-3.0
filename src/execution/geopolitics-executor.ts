import { logger } from '../utils/logger.js';
import { PaperTradingEngine } from '../core/paper-trading.js';
import { RiskManager } from '../core/risk-manager.js';
import { categoriseMarket } from '../signals/market-categoriser.js';
import * as cliWrapper from './cli-wrapper.js';
import { findSpecialist } from '../geopolitics/watchlist.js';
import type { LeaderTrade, CopyTrade, RiskLevel, ConfirmationDecision } from '../types/index.js';

/**
 * GeopoliticsExecutor — flat-sized mirror of pre-vetted geopolitics specialists.
 *
 * Differs from CopyExecutor by design (Branch 3 spec, 2026-05-11 sprint):
 *   - Fixed flat $75 sizing (env-overridable). No proportional / rank scaling.
 *   - No AI confirmation gate. Specialists are pre-vetted via Phase 2 v3 screen.
 *   - No watcher rank hierarchy. Every Tier-1 specialist is equal.
 *   - No rolling-WR penalty / hot-wallet elevation. Static list, refresh quarterly.
 *   - BUY-only. SELL-mirroring is out of scope for v1 (would mean opening shorts;
 *     specialists' edge is in low-price entry, not exit timing).
 *   - Politics-category only. Anything else from the same specialists is filtered
 *     (they trade other categories opportunistically).
 *
 * Inherits from CopyExecutor's playbook:
 *   - Light safety filters (expired/dead market, near-certainty price band)
 *   - Per-trade max-loss cap via RiskManager.capByMaxLoss
 *   - Capital deployment cap (env-overridable, default 80%)
 *   - Position count cap
 *   - Dedup per market
 *   - Stop-loss cooldown to prevent immediate re-entry
 */

export interface ExecutionResult {
  success: boolean;
  copyTrade?: CopyTrade;
  reason?: string;
}

// Sizing (env-overridable)
const DEFAULT_FLAT_SIZE_USDC = parseFloat(process.env.GEOPOLITICS_FLAT_SIZE ?? '75');
// Safety bands — same defaults as CopyExecutor's all-rank gates
const MAX_ENTRY_PRICE = 0.85;       // skip if leader entered above this (margin of safety + tail risk on YES)
const MIN_ENTRY_PRICE = 0.03;       // skip dust/near-zero (likely dead market)
const EDGE_FLOOR_DISTANCE = 0.05;   // skip prices in (0.45, 0.55) — coin-flip zone, no edge
// Risk gates
const MAX_OPEN_POSITIONS = parseInt(process.env.GEOPOLITICS_MAX_OPEN ?? '8');
const CAPITAL_CAP_PCT = parseFloat(process.env.GEOPOLITICS_CAPITAL_CAP_PCT ?? '0.80');
const STOP_LOSS_COOLDOWN_MS = 60 * 60 * 1000; // 60 min

export class GeopoliticsExecutor {
  private paperEngine: PaperTradingEngine;
  private riskManager: RiskManager;
  private paperMode: boolean;
  private flatSizeUsdc: number;
  private capitalPool: number;
  private riskLevel: RiskLevel;
  private openTrades: Map<string, CopyTrade> = new Map(); // marketId → CopyTrade
  private stopLossCooldown: Map<string, number> = new Map();
  private executedCount = 0;
  private blockedCount = 0;

  constructor(opts: {
    paperEngine: PaperTradingEngine;
    riskManager: RiskManager;
    paperMode: boolean;
    capitalPool: number;
    riskLevel: RiskLevel;
    flatSizeUsdc?: number;
  }) {
    this.paperEngine = opts.paperEngine;
    this.riskManager = opts.riskManager;
    this.paperMode = opts.paperMode;
    this.capitalPool = opts.capitalPool;
    this.riskLevel = opts.riskLevel;
    this.flatSizeUsdc = opts.flatSizeUsdc ?? DEFAULT_FLAT_SIZE_USDC;
  }

  /** Hydrate open positions from Supabase on startup (geopolitics-pipeline trades only) */
  hydrateOpenTrades(rows: Array<Record<string, unknown>>): void {
    for (const row of rows) {
      const marketId = row.market_id as string;
      if (!marketId || this.openTrades.has(marketId)) continue;
      const trade: CopyTrade = {
        id: row.id as string,
        pipeline: 'geopolitics',
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
        confirmationResult: (row.confirmation_result as ConfirmationDecision | undefined) ?? 'skipped',
        confirmationReason: (row.confirmation_reason as string | undefined) ?? 'geopolitics specialist (pre-vetted)',
        status: 'open',
        riskLevel: (row.risk_level as RiskLevel | undefined) ?? this.riskLevel,
        entryTime: row.entry_time as string,
        createdAt: row.created_at as string | undefined,
      };
      this.openTrades.set(marketId, trade);
    }
    if (this.openTrades.size > 0) {
      logger.info(`GeopoliticsExecutor: Hydrated ${this.openTrades.size} open positions from Supabase`);
    }
  }

  hasOpenPositionForMarket(marketId: string): boolean {
    return this.openTrades.has(marketId) || this.paperEngine.hasOpenPositionForMarket(marketId);
  }

  getTradeByMarket(marketId: string): CopyTrade | undefined {
    return this.openTrades.get(marketId);
  }

  rollbackTrade(marketId: string): void {
    const trade = this.openTrades.get(marketId);
    if (trade) {
      this.openTrades.delete(marketId);
      this.paperEngine.closeTradeByMarketId(marketId, trade.ourEntryPrice ?? 0, 'rollback');
      this.executedCount = Math.max(0, this.executedCount - 1);
      logger.warn(`GeopoliticsExecutor: Rolled back trade for ${marketId.slice(0, 20)} (Supabase write failed)`);
    }
  }

  /**
   * Try to mirror a specialist's trade. Returns success=false with a reason if
   * the trade was filtered (caller logs/records as appropriate).
   */
  async execute(leaderTrade: LeaderTrade): Promise<ExecutionResult> {
    const specialist = findSpecialist(leaderTrade.leaderWallet);
    const specialistTag = specialist ? `${specialist.name}(${specialist.tier})` : 'unknown';

    // ─── Zero-capital guard ───
    // Avoids the edge case where the pipeline is GEOPOLITICS_ENABLED=true
    // but GEOPOLITICS_CAPITAL=0 (e.g. flag flipped before capital set).
    // The deployment cap check below would pass with capitalPool=0 (division
    // by zero shortcut), letting trades fire against zero allocated funds.
    if (this.capitalPool <= 0) {
      return { success: false, reason: `Geopolitics pipeline has no capital allocated (set GEOPOLITICS_CAPITAL)` };
    }

    // ─── BUY-only ───
    if (leaderTrade.side !== 'buy') {
      return { success: false, reason: `Geopolitics v1 is BUY-only; ${specialistTag} ${leaderTrade.side.toUpperCase()} ignored` };
    }

    // ─── Politics-category only (specialists trade other things too) ───
    const category = categoriseMarket(leaderTrade.marketQuestion);
    if (category !== 'politics') {
      return { success: false, reason: `Not politics market (categorised '${category}'): "${leaderTrade.marketQuestion.slice(0, 60)}"` };
    }

    // ─── Stop-loss cooldown ───
    const cooldownStart = this.stopLossCooldown.get(leaderTrade.marketId);
    if (cooldownStart && Date.now() - cooldownStart < STOP_LOSS_COOLDOWN_MS) {
      const remainingMin = Math.ceil((STOP_LOSS_COOLDOWN_MS - (Date.now() - cooldownStart)) / 60000);
      return { success: false, reason: `Stop-loss cooldown active (${remainingMin}min remaining)` };
    } else if (cooldownStart) {
      this.stopLossCooldown.delete(leaderTrade.marketId);
    }

    // ─── Dedup ───
    if (this.hasOpenPositionForMarket(leaderTrade.marketId)) {
      return { success: false, reason: `Already have open position in ${leaderTrade.marketId.slice(0, 20)}` };
    }

    // ─── Reject missing marketId ───
    if (!leaderTrade.marketId) {
      return { success: false, reason: 'Trade missing marketId' };
    }

    // ─── Price band filters ───
    const entryPrice = leaderTrade.entryPrice;
    if (entryPrice < MIN_ENTRY_PRICE) {
      this.blockedCount++;
      return { success: false, reason: `Dead market: price ${entryPrice.toFixed(4)} < ${MIN_ENTRY_PRICE}` };
    }
    if (entryPrice > MAX_ENTRY_PRICE) {
      this.blockedCount++;
      return { success: false, reason: `Near-certainty: price ${entryPrice.toFixed(3)} > ${MAX_ENTRY_PRICE}` };
    }
    if (Math.abs(entryPrice - 0.5) < EDGE_FLOOR_DISTANCE) {
      this.blockedCount++;
      return { success: false, reason: `Coin-flip zone: price ${entryPrice.toFixed(3)} within ${EDGE_FLOOR_DISTANCE} of 0.50` };
    }

    // ─── Expired market detection (date in title has passed) ───
    const expired = this.detectExpired(leaderTrade.marketQuestion);
    if (expired) {
      this.blockedCount++;
      return { success: false, reason: `Expired market: ${expired}` };
    }

    // ─── Position count cap ───
    if (this.openTrades.size >= MAX_OPEN_POSITIONS) {
      this.blockedCount++;
      return { success: false, reason: `Position cap reached (${this.openTrades.size}/${MAX_OPEN_POSITIONS})` };
    }

    // ─── Capital deployment cap ───
    const totalDeployed = Array.from(this.openTrades.values()).reduce((s, t) => s + (t.ourSize ?? 0), 0);
    const deployedPct = this.capitalPool > 0 ? totalDeployed / this.capitalPool : 0;
    if (deployedPct >= CAPITAL_CAP_PCT) {
      this.blockedCount++;
      return { success: false, reason: `Capital cap: ${(deployedPct * 100).toFixed(1)}% deployed (max ${(CAPITAL_CAP_PCT * 100).toFixed(0)}%)` };
    }

    // ─── Flat sizing — start with configured flat size ───
    let ourSize = this.flatSizeUsdc;

    // ─── Max-loss cap (asymmetric tail risk on BUY: max loss = entryPrice × shares) ───
    const cappedSize = this.riskManager.capByMaxLoss(ourSize, entryPrice, 'buy');
    if (cappedSize === 0) {
      this.blockedCount++;
      return { success: false, reason: `Max-loss cap rejected size $${ourSize.toFixed(2)} at entry ${entryPrice.toFixed(3)}` };
    }
    if (cappedSize < ourSize) {
      logger.info(`GeopoliticsExecutor: MAX-LOSS CAP — size reduced $${ourSize.toFixed(2)} → $${cappedSize.toFixed(2)}`);
      ourSize = cappedSize;
    }

    // ─── Min size floor ───
    if (ourSize < 1) {
      this.blockedCount++;
      return { success: false, reason: `Final size $${ourSize.toFixed(2)} below $1 floor` };
    }

    logger.info(`GeopoliticsExecutor: ${this.paperMode ? '[PAPER]' : '[LIVE]'} Copying ${specialistTag}`, {
      market: leaderTrade.marketQuestion.slice(0, 50),
      side: leaderTrade.side,
      outcome: leaderTrade.outcome,
      leaderSize: `$${leaderTrade.size.toFixed(2)}`,
      ourSize: `$${ourSize.toFixed(2)}`,
      entryPrice: entryPrice.toFixed(4),
    });

    return this.paperMode
      ? this.executePaper(leaderTrade, ourSize, specialistTag)
      : this.executeLive(leaderTrade, ourSize, specialistTag);
  }

  private executePaper(leaderTrade: LeaderTrade, ourSize: number, specialistTag: string): ExecutionResult {
    const result = this.paperEngine.executeCopyTrade({
      marketId: leaderTrade.marketId,
      question: leaderTrade.marketQuestion,
      tokenId: leaderTrade.tokenId || '',
      outcome: leaderTrade.outcome,
      side: leaderTrade.side,
      usdcSize: ourSize,
      leaderEntryPrice: leaderTrade.entryPrice,
      riskLevel: this.riskLevel,
      pipelineId: 'geopolitics',
    });

    if (!result) {
      this.blockedCount++;
      return { success: false, reason: 'Paper engine blocked trade (risk limits)' };
    }

    const trade: CopyTrade = {
      id: result.trade.id,
      pipeline: 'geopolitics',
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
      confirmationResult: 'skipped',
      confirmationReason: `Pre-vetted geopolitics specialist: ${specialistTag}`,
      status: 'open',
      riskLevel: this.riskLevel,
      entryTime: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    };

    this.openTrades.set(leaderTrade.marketId, trade);
    this.executedCount++;
    return { success: true, copyTrade: trade };
  }

  private async executeLive(leaderTrade: LeaderTrade, ourSize: number, specialistTag: string): Promise<ExecutionResult> {
    try {
      if (!leaderTrade.tokenId) {
        return { success: false, reason: 'No tokenId for live execution' };
      }
      const result = await cliWrapper.smartOrder(leaderTrade.tokenId, leaderTrade.side, ourSize);
      if (!result.success) {
        this.blockedCount++;
        return { success: false, reason: 'CLI order failed' };
      }
      const trade: CopyTrade = {
        pipeline: 'geopolitics',
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
        confirmationResult: 'skipped',
        confirmationReason: `Pre-vetted geopolitics specialist: ${specialistTag}`,
        status: 'open',
        riskLevel: this.riskLevel,
        entryTime: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      };
      this.openTrades.set(leaderTrade.marketId, trade);
      this.executedCount++;
      return { success: true, copyTrade: trade };
    } catch (err) {
      this.blockedCount++;
      return { success: false, reason: `Live execution error: ${err}` };
    }
  }

  /** Close our position when the specialist closes theirs, or when lifecycle fires */
  async closePosition(marketId: string, currentPrice: number, reason = 'leader_closed'): Promise<CopyTrade | null> {
    const trade = this.openTrades.get(marketId);
    if (!trade) return null;

    if (this.paperMode) {
      const closed = this.paperEngine.closeTradeByMarketId(marketId, currentPrice, reason);
      if (closed) {
        trade.status = 'closed';
        trade.pnl = closed.pnl;
        trade.exitTime = typeof closed.exitTime === 'string' ? closed.exitTime : closed.exitTime?.toISOString();
        this.openTrades.delete(marketId);
        if (reason === 'stop_loss' || reason === 'stop-loss') {
          this.stopLossCooldown.set(marketId, Date.now());
        }
        return trade;
      }
    } else if (trade.tokenId) {
      try {
        await cliWrapper.smartOrder(trade.tokenId, 'sell', trade.ourSize);
        trade.status = 'closed';
        this.openTrades.delete(marketId);
        return trade;
      } catch (err) {
        logger.error(`GeopoliticsExecutor: Live close failed for ${marketId}: ${err}`);
      }
    }
    return null;
  }

  getOpenTrades(): CopyTrade[] {
    return Array.from(this.openTrades.values());
  }

  getStats() {
    return {
      executed: this.executedCount,
      blocked: this.blockedCount,
      openPositions: this.openTrades.size,
      paperMode: this.paperMode,
      flatSizeUsdc: this.flatSizeUsdc,
      capitalPool: this.capitalPool,
    };
  }

  updateCapital(newPool: number): void {
    this.capitalPool = newPool;
  }

  /** Detect markets whose deadline has already passed (date in title) */
  private detectExpired(marketQuestion: string): string | null {
    // ISO date (YYYY-MM-DD)
    const isoMatch = marketQuestion.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
    if (isoMatch) {
      const d = new Date(isoMatch[1] + 'T23:59:59Z');
      if (d < new Date()) return `date ${isoMatch[1]} passed`;
    }
    // "by Month DD"
    const byMatch = marketQuestion.match(/\bby\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})\b/i);
    if (byMatch) {
      const months = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
      const monthIdx = months.indexOf(byMatch[1].toLowerCase());
      if (monthIdx >= 0) {
        const year = new Date().getFullYear();
        const deadline = new Date(year, monthIdx, parseInt(byMatch[2]), 23, 59, 59);
        if (deadline < new Date()) return `"by ${byMatch[1]} ${byMatch[2]}" passed`;
      }
    }
    return null;
  }
}
