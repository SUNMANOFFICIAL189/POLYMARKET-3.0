import { logger } from '../utils/logger.js';
import { PaperTradingEngine } from '../core/paper-trading.js';
import { RiskManager } from '../core/risk-manager.js';
import * as cliWrapper from './cli-wrapper.js';
import { findSpecialist } from '../geopolitics/watchlist.js';
import type { LeaderTrade, CopyTrade, RiskLevel, ConfirmationDecision } from '../types/index.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { persistTimestampMap, loadTimestampMap, persistBucketMap, loadBucketMap } from '../core/map-persistence.js';

/**
 * Leader-mirrored-exit snapshot: leader's CURRENT total position size on a
 * specific market at the moment WE opened our mirror. Used by PositionLifecycleManager
 * to detect when the leader has materially reduced their conviction (sold ≥50%
 * of the snapshot baseline) and trigger a coordinated exit on our side.
 *
 * See LESSONS.md #25, scripts/test-leader-exit.ts, and the 2026-06-06 health
 * check that motivated this (6 of 12 closed StarMaster mirrors hit our fixed
 * 30% stop while she held through the dip).
 */
export interface LeaderSnapshot {
  leaderWallet: string;
  marketId: string;
  sizeAtEntry: number;
  capturedAt: string; // ISO timestamp
  ourTradeId?: string;
}

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
 *   - NO category filter (removed 2026-05-17, Phase 0). Earlier the executor
 *     rejected any market the categoriser didn't tag 'politics'. That blocked
 *     ~95% of balthazar's actual book (Peruvian elections) because the keyword
 *     list didn't pre-enumerate Latin American politics. The watchlist itself
 *     IS the edge filter; second-guessing the specialist's market choice is
 *     redundant. See `_NEXT_STEPS/build-plan-2026-05-16.md` and Decision Log
 *     2026-05-16 / 2026-05-17 for rationale.
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
// Safety bands — env-overridable for live tuning during paper soak.
// 2026-05-12 loosening: MAX_ENTRY_PRICE bumped from 0.85 to 0.90 (env-tunable
// via GEOPOLITICS_MAX_ENTRY_PRICE). Lower = stricter (more rejections at the
// "leader closing position" end). Beyond 0.92 starts admitting pure leader-
// closes which are negative-EV to mirror.
const MAX_ENTRY_PRICE = parseFloat(process.env.GEOPOLITICS_MAX_ENTRY_PRICE ?? '0.85');
const MIN_ENTRY_PRICE = parseFloat(process.env.GEOPOLITICS_MIN_ENTRY_PRICE ?? '0.03');
const EDGE_FLOOR_DISTANCE = parseFloat(process.env.GEOPOLITICS_EDGE_FLOOR ?? '0.05');
// Risk gates
const MAX_OPEN_POSITIONS = parseInt(process.env.GEOPOLITICS_MAX_OPEN ?? '8');
const CAPITAL_CAP_PCT = parseFloat(process.env.GEOPOLITICS_CAPITAL_CAP_PCT ?? '0.80');
const STOP_LOSS_COOLDOWN_MS = 60 * 60 * 1000; // 60 min

// ─── Consensus sizing (Phase 0.2, 2026-05-17) ─────────────────────────
// When 2+ specialists buy the same market on the same side within the
// consensus window, scale up our position. When specialists DISAGREE
// (one buys YES, another buys NO on the same market), REJECT the trade.
// Specs locked in build-plan-2026-05-16.md.
const CONSENSUS_SIZING_ENABLED = process.env.GEOPOLITICS_CONSENSUS_SIZING !== 'false';
const CONSENSUS_WINDOW_MS = (parseInt(process.env.GEOPOLITICS_CONSENSUS_WINDOW_H ?? '48')) * 60 * 60 * 1000;
// totalAgreement → size (totalAgreement = self + agreeing other wallets)
const CONSENSUS_TIERS: Record<number, number> = {
  1: 50,   // solo  — single-source uncertainty, smaller bet
  2: 100,  // 2-of-N
  3: 150,  // 3-of-N
  4: 200,  // 4-of-N — max conviction (requires maxPositionPct >= 0.14)
};

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
  /**
   * Consensus tracking — for each watched specialist wallet, a rolling
   * 48h window of their observed BUYs. Used to detect when 2+ specialists
   * converge on the same market (size up) or take opposite sides (reject).
   * Phase 0.2, 2026-05-17.
   */
  private recentBuysByWallet: Map<string, Array<{
    marketId: string;
    outcome: string;
    timestamp: number;
  }>> = new Map();
  /**
   * Per-pipeline cash balance — tracks the geopolitics pool's available capital.
   * Updated on open/close and fed to the per-pipeline RiskManager so its
   * drawdown breaker operates against the geopolitics pool ONLY, not the
   * bot-wide balance. Option D isolation, 2026-05-12.
   */
  private poolBalance: number;

  /**
   * Leader-position snapshot store for Fix A (leader-mirrored exit).
   * Map<marketId, LeaderSnapshot>. Persisted to disk so it survives restarts.
   * Created 2026-06-06 — see LeaderSnapshot interface for full context.
   */
  private leaderSnapshots: Map<string, LeaderSnapshot> = new Map();
  private readonly SNAPSHOT_FILE = process.env.LEADER_SNAPSHOT_FILE ?? '/opt/polymarket-bot/data/leader-snapshots.json';
  private readonly COOLDOWN_FILE = process.env.GEO_COOLDOWN_FILE ?? '/opt/polymarket-bot/data/geo-stoploss-cooldown.json';
  private readonly CONSENSUS_FILE = process.env.GEO_CONSENSUS_FILE ?? '/opt/polymarket-bot/data/geo-consensus.json';

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
    this.poolBalance = opts.capitalPool;
    this.syncRiskState();
    this.loadLeaderSnapshots(); // restore from disk on startup
    // Tier-1 3.3: restore cooldown + 48h consensus window so a restart no longer
    // bypasses the stop-loss cooldown or mis-sizes trades (solo vs consensus).
    const nowMs = Date.now();
    this.stopLossCooldown = loadTimestampMap(this.COOLDOWN_FILE, STOP_LOSS_COOLDOWN_MS, nowMs);
    this.recentBuysByWallet = loadBucketMap<{ marketId: string; outcome: string; timestamp: number }>(this.CONSENSUS_FILE, CONSENSUS_WINDOW_MS, nowMs);
  }

  // ─── Leader snapshot persistence (Fix A — leader-mirrored exit) ───

  /** Look up the leader's position size baseline for a given marketId. */
  getLeaderSnapshot(marketId: string): LeaderSnapshot | undefined {
    return this.leaderSnapshots.get(marketId);
  }

  /**
   * Fetch the leader's CURRENT total position size on a market.
   * Used by PositionLifecycleManager every 5 min to detect material reductions.
   * Returns null on fetch failure / no position — caller skips exit check in that case.
   */
  async fetchCurrentLeaderSize(leaderWallet: string, marketId: string): Promise<number | null> {
    try {
      const url = `https://data-api.polymarket.com/positions?user=${leaderWallet}&limit=500`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      try {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) return null;
        const positions = await res.json() as Array<{ slug?: string; conditionId?: string; size?: number; eventSlug?: string }>;
        // Match by slug, conditionId, or eventSlug — Polymarket has slug variants
        const match = positions.find((p) => p.slug === marketId || p.conditionId === marketId || p.eventSlug === marketId);
        if (!match) return 0; // leader has no position on this market → fully exited
        return typeof match.size === 'number' ? match.size : null;
      } finally {
        clearTimeout(timeout);
      }
    } catch {
      return null;
    }
  }

  /** Capture leader's current size on a market AT THE MOMENT we open our mirror. */
  private async captureLeaderSnapshot(leaderWallet: string, marketId: string, ourTradeId?: string): Promise<void> {
    try {
      const size = await this.fetchCurrentLeaderSize(leaderWallet, marketId);
      if (size === null || size <= 0) {
        logger.warn(`GeopoliticsExecutor: leader snapshot fetch returned ${size} for ${marketId.slice(0, 25)} — skipping (50% backstop only)`);
        return;
      }
      const snap: LeaderSnapshot = {
        leaderWallet,
        marketId,
        sizeAtEntry: size,
        capturedAt: new Date().toISOString(),
        ourTradeId,
      };
      this.leaderSnapshots.set(marketId, snap);
      this.persistLeaderSnapshots();
      logger.info(`GeopoliticsExecutor: leader snapshot captured — ${leaderWallet.slice(0, 10)} on ${marketId.slice(0, 25)} sizeAtEntry=${size.toFixed(0)}`);
    } catch (err) {
      logger.warn(`GeopoliticsExecutor: captureLeaderSnapshot failed for ${marketId.slice(0, 25)}: ${err}`);
    }
  }

  /** Drop the snapshot when we close our position. */
  private removeLeaderSnapshot(marketId: string): void {
    if (this.leaderSnapshots.delete(marketId)) {
      this.persistLeaderSnapshots();
    }
  }

  private persistLeaderSnapshots(): void {
    try {
      const dir = dirname(this.SNAPSHOT_FILE);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const obj = Object.fromEntries(this.leaderSnapshots);
      writeFileSync(this.SNAPSHOT_FILE, JSON.stringify(obj, null, 2));
    } catch (err) {
      logger.warn(`GeopoliticsExecutor: leader snapshot persist failed (non-fatal): ${err}`);
    }
  }

  private loadLeaderSnapshots(): void {
    try {
      if (!existsSync(this.SNAPSHOT_FILE)) return;
      const obj = JSON.parse(readFileSync(this.SNAPSHOT_FILE, 'utf8'));
      for (const [k, v] of Object.entries(obj)) {
        this.leaderSnapshots.set(k, v as LeaderSnapshot);
      }
      if (this.leaderSnapshots.size > 0) {
        logger.info(`GeopoliticsExecutor: loaded ${this.leaderSnapshots.size} leader snapshots from ${this.SNAPSHOT_FILE}`);
      }
    } catch (err) {
      logger.warn(`GeopoliticsExecutor: leader snapshot load failed (non-fatal): ${err}`);
    }
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
    // Restart fidelity: deduct capital reserved by the hydrated open positions so
    // poolBalance reflects DEPLOYED capital (mirrors PaperTradingEngine's hydrate).
    // Without this, the pool reset to full on every restart and every geo risk gate
    // (drawdown breaker / exposure / daily-loss / max-loss) used the wrong denominator
    // — reading ~0% drawdown even with capital deployed.
    let reservedCapital = 0;
    for (const t of this.openTrades.values()) reservedCapital += t.ourSize ?? 0;
    this.poolBalance = this.capitalPool - reservedCapital;
    this.syncRiskState();
    if (this.openTrades.size > 0) {
      logger.info(`GeopoliticsExecutor: Hydrated ${this.openTrades.size} open positions ($${reservedCapital.toFixed(2)} reserved → pool $${this.poolBalance.toFixed(2)})`);
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
      this.removeLeaderSnapshot(marketId);
      this.paperEngine.closeTradeByMarketId(marketId, trade.ourEntryPrice ?? 0, 'rollback');
      this.executedCount = Math.max(0, this.executedCount - 1);
      // Refund capital — the trade was reverted, no P&L realized.
      this.poolBalance += trade.ourSize ?? 0;
      this.syncRiskState();
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

    // ─── Consensus tracking (Phase 0.2) ───
    // Record this BUY observation BEFORE any filtering. We want the consensus
    // detector to have a complete picture of what specialists have done
    // recently, even on trades we don't end up mirroring. Tracks only BUYs
    // since the executor is BUY-only and disagreement is YES-vs-NO of BUY.
    if (leaderTrade.side === 'buy') {
      this.trackBuy(
        leaderTrade.leaderWallet,
        leaderTrade.marketId,
        leaderTrade.outcome ?? 'Yes',
        Date.now(),
      );
    }

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

    // ─── Stop-loss cooldown ───
    const cooldownStart = this.stopLossCooldown.get(leaderTrade.marketId);
    if (cooldownStart && Date.now() - cooldownStart < STOP_LOSS_COOLDOWN_MS) {
      const remainingMin = Math.ceil((STOP_LOSS_COOLDOWN_MS - (Date.now() - cooldownStart)) / 60000);
      return { success: false, reason: `Stop-loss cooldown active (${remainingMin}min remaining)` };
    } else if (cooldownStart) {
      this.stopLossCooldown.delete(leaderTrade.marketId);
      persistTimestampMap(this.COOLDOWN_FILE, this.stopLossCooldown);
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

    // ─── Consensus detection (Phase 0.2, 2026-05-17) ───
    // Look at other specialists' recent BUYs on this market within the window.
    // If any disagree (bought opposite side) → REJECT — specialists fighting
    // each other is a low-quality signal. If 2+ agree → size up per tier.
    const consensusOutcome = leaderTrade.outcome ?? 'Yes';
    const { agreeingWallets, disagreeingWallets } = this.detectConsensus(
      leaderTrade.marketId,
      consensusOutcome,
      leaderTrade.leaderWallet,
    );

    if (disagreeingWallets.length > 0) {
      this.blockedCount++;
      return {
        success: false,
        reason: `Specialist disagreement: ${disagreeingWallets.join(',')} hold opposite side on ${leaderTrade.marketId.slice(0, 20)} within ${CONSENSUS_WINDOW_MS / 3600000}h. Skipping.`,
      };
    }

    const totalAgreement = agreeingWallets.length + 1; // include self
    const consensusTierSize = this.computeSizeFromConsensus(totalAgreement);

    // ─── Sizing decision — consensus tier or flat fallback ───
    let ourSize = CONSENSUS_SIZING_ENABLED ? consensusTierSize : this.flatSizeUsdc;

    if (CONSENSUS_SIZING_ENABLED) {
      const consensusTag = totalAgreement >= 2 ? `${totalAgreement}-of-N consensus (${[...agreeingWallets, specialistTag].join('+')})` : 'solo';
      logger.info(`GeopoliticsExecutor: ${specialistTag} ${consensusTag} → size $${ourSize}`);
    }

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

    // ─── Per-pipeline risk gate (drawdown breaker + daily loss + exposure) ───
    // Operates on the geopolitics pool only (Option D, 2026-05-12). Bot-wide
    // signal-pipeline losses no longer block geopolitics trades.
    this.riskManager.setOpenTrades(this.toRMTrades());
    const riskCheck = this.riskManager.checkTrade(ourSize);
    if (!riskCheck.allowed) {
      this.blockedCount++;
      return { success: false, reason: `Geopolitics RM blocked: ${riskCheck.reason}` };
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
    // Per-pipeline balance accounting — capital reserved.
    this.poolBalance -= ourSize;
    this.syncRiskState();
    // Fix A: capture leader's current position size for leader-mirrored exit policy.
    // Fire-and-forget — fetch failure means we fall back to 50% drawdown backstop only.
    void this.captureLeaderSnapshot(leaderTrade.leaderWallet, leaderTrade.marketId, trade.id);
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
      // Per-pipeline balance accounting — capital reserved.
      this.poolBalance -= ourSize;
      this.syncRiskState();
      // Fix A: capture leader snapshot (fire-and-forget; see executePaper).
      void this.captureLeaderSnapshot(leaderTrade.leaderWallet, leaderTrade.marketId, trade.id);
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
        this.removeLeaderSnapshot(marketId);
        if (reason === 'stop_loss' || reason === 'stop-loss') {
          this.stopLossCooldown.set(marketId, Date.now());
          persistTimestampMap(this.COOLDOWN_FILE, this.stopLossCooldown);
        }
        // Per-pipeline balance accounting — capital returned + realized P&L.
        this.poolBalance += (trade.ourSize ?? 0) + (closed.pnl ?? 0);
        this.syncRiskState();
        return trade;
      }
      // Stale-state correction (Phase 0.3, 2026-05-17): paperEngine had no
      // record of this marketId but our openTrades did. That means paperEngine
      // closed the position via a different path (e.g., checkStopLosses,
      // hydration mismatch, prior closeTradeByMarketId call we missed).
      // Without this branch, our openTrades accumulates "phantom" entries
      // that inflate the drawdown-breaker calculation and freeze the pipeline.
      logger.warn(
        `GeopoliticsExecutor: stale phantom detected for ${marketId.slice(0, 24)} ` +
        `(paperEngine has no record; reason=${reason}). Cleaning up executor state.`,
      );
      trade.status = 'closed';
      trade.exitTime = new Date().toISOString();
      // pnl unknown — paperEngine has no record; assume capital-only return
      this.openTrades.delete(marketId);
      this.removeLeaderSnapshot(marketId);
      this.poolBalance += (trade.ourSize ?? 0);
      this.syncRiskState();
      // Return null so the lifecycle-cascade can keep looking (e.g., signalExecutor)
      // and the caller doesn't double-persist a close we don't have real data for.
      return null;
    } else if (trade.tokenId) {
      try {
        await cliWrapper.smartOrder(trade.tokenId, 'sell', trade.ourSize);
        trade.status = 'closed';
        this.openTrades.delete(marketId);
        this.removeLeaderSnapshot(marketId);
        // Live close: paperEngine isn't writing P&L; book the capital return
        // only. Realised P&L is settled at reconciliation/audit time.
        this.poolBalance += (trade.ourSize ?? 0);
        this.syncRiskState();
        return trade;
      } catch (err) {
        logger.error(`GeopoliticsExecutor: Live close failed for ${marketId}: ${err}`);
      }
    }
    return null;
  }

  /**
   * Phantom-state sweep (Phase 0.3, 2026-05-17). Compares the executor's
   * in-memory openTrades against the paper engine's authoritative state.
   * Any executor entry that paperEngine no longer recognizes is a phantom —
   * paperEngine has already closed it (likely via checkStopLosses or an
   * earlier code path that bypassed closePosition). We clean up the
   * executor's state to keep drawdown / capital accounting correct.
   *
   * Should be called from runner.ts on the same cadence as the status
   * pump (every 5 min). Idempotent and safe to run frequently.
   */
  sweepPhantoms(): { removed: number; phantomMarketIds: string[] } {
    if (!this.paperMode) return { removed: 0, phantomMarketIds: [] };
    const phantoms: string[] = [];
    for (const [marketId] of this.openTrades) {
      if (!this.paperEngine.hasOpenPositionForMarket(marketId)) {
        phantoms.push(marketId);
      }
    }
    for (const marketId of phantoms) {
      const trade = this.openTrades.get(marketId);
      if (!trade) continue;
      this.openTrades.delete(marketId);
      this.removeLeaderSnapshot(marketId);
      this.poolBalance += (trade.ourSize ?? 0);
      this.syncRiskState();
    }
    if (phantoms.length > 0) {
      logger.warn(
        `GeopoliticsExecutor: phantom sweep removed ${phantoms.length} ` +
        `stale executor entries: ${phantoms.map((m) => m.slice(0, 20)).join(', ')}. ` +
        `Pool balance restored by $${phantoms.reduce((s, m) => s + (this.openTrades.get(m)?.ourSize ?? 0), 0).toFixed(2)}.`,
      );
    }
    return { removed: phantoms.length, phantomMarketIds: phantoms };
  }

  /**
   * Option A (2026-06-28): keep the RiskManager's open-trades view in lockstep
   * with poolBalance whenever cash changes, so its EQUITY-based drawdown breaker
   * always sees a consistent (free-cash, deployed) pair. setOpenTrades BEFORE
   * updateBalance so equity is computed against the just-changed open set.
   * Replaces the bare updateBalance(poolBalance) calls — including the restart
   * hydrate, which is what neutralises the boot phantom-drawdown (H1): equity =
   * (pool − reserved) + reserved = full pool ⇒ 0% boot drawdown.
   */
  private syncRiskState(): void {
    this.riskManager.setOpenTrades(this.toRMTrades());
    this.riskManager.updateBalance(this.poolBalance);
  }

  /**
   * Convert open CopyTrade map → minimal Trade shape that RiskManager's
   * exposure check expects. Only fields it reads matter (usdcAmount).
   */
  private toRMTrades(): import('../types/index.js').Trade[] {
    return Array.from(this.openTrades.values()).map((t) => ({
      id: t.id ?? '',
      marketId: t.marketId,
      question: t.marketQuestion,
      tokenId: t.tokenId ?? '',
      outcome: t.outcome,
      side: t.side,
      entryPrice: t.ourEntryPrice ?? t.leaderEntryPrice,
      size: 0,
      usdcAmount: t.ourSize ?? 0,
      convictionScore: 75,
      riskLevel: this.riskLevel,
      status: 'open',
      stopLoss: 0.3,
      signalIds: [],
      entryTime: t.entryTime,
      pipelineId: 'geopolitics',
    }));
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

  // ───────────────────────────────────────────────────────────────────
  //  CONSENSUS DETECTION HELPERS (Phase 0.2, 2026-05-17)
  // ───────────────────────────────────────────────────────────────────

  /**
   * Record a leader's BUY in the rolling 48h consensus buffer. Called for
   * every observed BUY from any watchlist specialist, even if we don't end
   * up mirroring (we want the buffer to reflect actual specialist activity).
   * Dedupes by marketId per wallet (a wallet that scales into a position
   * counts as ONE entry, not multiple).
   */
  private trackBuy(wallet: string, marketId: string, outcome: string, timestamp: number): void {
    if (!this.recentBuysByWallet.has(wallet)) {
      this.recentBuysByWallet.set(wallet, []);
    }
    const buys = this.recentBuysByWallet.get(wallet)!;
    const cutoff = timestamp - CONSENSUS_WINDOW_MS;
    // Prune expired
    const fresh = buys.filter((b) => b.timestamp >= cutoff);
    // Dedupe by marketId — keep the latest for that market
    const existingIdx = fresh.findIndex((b) => b.marketId === marketId);
    if (existingIdx >= 0) {
      fresh[existingIdx] = { marketId, outcome, timestamp };
    } else {
      fresh.push({ marketId, outcome, timestamp });
    }
    this.recentBuysByWallet.set(wallet, fresh);
    persistBucketMap(this.CONSENSUS_FILE, this.recentBuysByWallet);
  }

  /**
   * For a given market+outcome+wallet, find other specialists who:
   *   - bought the SAME market on the SAME outcome → agreeingWallets (consensus)
   *   - bought the SAME market on the OPPOSITE outcome → disagreeingWallets (reject signal)
   * Excludes the current wallet from both sets.
   */
  private detectConsensus(
    marketId: string,
    outcome: string,
    currentWallet: string,
  ): { agreeingWallets: string[]; disagreeingWallets: string[] } {
    const agreeing: string[] = [];
    const disagreeing: string[] = [];
    const now = Date.now();
    const cutoff = now - CONSENSUS_WINDOW_MS;
    const targetOutcome = outcome.toLowerCase();

    for (const [wallet, buys] of this.recentBuysByWallet) {
      if (wallet === currentWallet) continue; // exclude self
      for (const b of buys) {
        if (b.timestamp < cutoff) continue;
        if (b.marketId !== marketId) continue;
        const name = findSpecialist(wallet)?.name ?? wallet.slice(0, 8);
        if (b.outcome.toLowerCase() === targetOutcome) {
          agreeing.push(name);
        } else {
          disagreeing.push(name);
        }
        break; // one entry per wallet (dedup is per market in trackBuy)
      }
    }
    return { agreeingWallets: agreeing, disagreeingWallets: disagreeing };
  }

  /** Map total-agreement count (self + others) to sizing tier (USDC). */
  private computeSizeFromConsensus(totalAgreement: number): number {
    if (totalAgreement <= 0) return CONSENSUS_TIERS[1];
    const capped = Math.min(totalAgreement, 4) as 1 | 2 | 3 | 4;
    return CONSENSUS_TIERS[capped];
  }

  // ───────────────────────────────────────────────────────────────────

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
