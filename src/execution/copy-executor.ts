import { logger } from '../utils/logger.js';
import { PaperTradingEngine } from '../core/paper-trading.js';
import { RiskManager } from '../core/risk-manager.js';
import { categoriseMarket } from '../signals/market-categoriser.js';
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


// Skip near-certainty bets: price > this threshold or < (1 - threshold) have
// near-zero alpha — the edge is already fully priced in.
const MAX_WATCHER_PRICE = 0.75;
const MIN_WATCHER_PRICE = 0.08;

// Edge floor: prices within 6% of 0.5 (0.44–0.56) represent genuine uncertainty —
// no measurable directional edge. Top performers enter at ≥6% deviation from consensus
// (PANews 112K wallet study; min edge = 6-11% from midpoint).
const EDGE_FLOOR_DISTANCE = 0.10;

export class CopyExecutor {
  private paperEngine: PaperTradingEngine;
  private riskManager: RiskManager;
  private paperMode: boolean;
  private ourPortfolio: number;
  private riskLevel: RiskLevel;
  private openCopyTrades: Map<string, CopyTrade> = new Map(); // marketId → CopyTrade
  // marketId → rank of the watcher who opened the position (for collision detection)
  private watcherPositions: Map<string, number> = new Map();
  // marketId → timestamp when stop-loss fired. Prevents same-session re-entry on a losing market.
  private stopLossCooldown: Map<string, number> = new Map();
  private readonly STOP_LOSS_COOLDOWN_MS = 60 * 60 * 1000; // 60 minutes
  // Rolling wallet performance window — tracks last N trade outcomes per wallet
  private walletRollingWindow: Map<string, Array<boolean>> = new Map();
  private readonly ROLLING_WINDOW_SIZE   = parseInt(process.env.ROLLING_WINDOW         ?? '10');
  private readonly ROLLING_MIN_WIN_RATE  = parseFloat(process.env.ROLLING_MIN_WIN_RATE  ?? '0.40');
  private readonly ROLLING_BOOST_RATE    = parseFloat(process.env.ROLLING_BOOST_THRESHOLD ?? '0.60');
  private readonly ROLLING_MIN_SAMPLE    = 5; // minimum trades before filter activates

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

  /** Get a trade from the in-memory map by marketId (for write-through ID patching) */
  getTradeByMarket(marketId: string): CopyTrade | undefined {
    return this.openCopyTrades.get(marketId);
  }

  /** Rollback: remove a trade from memory if Supabase insert failed (write-through consistency) */
  rollbackTrade(marketId: string): void {
    const trade = this.openCopyTrades.get(marketId);
    if (trade) {
      this.openCopyTrades.delete(marketId);
      this.watcherPositions.delete(marketId);
      this.paperEngine.closeTradeByMarketId(marketId, trade.ourEntryPrice ?? 0, 'rollback');
      this.executedCount = Math.max(0, this.executedCount - 1);
      logger.warn(`CopyExecutor: Rolled back trade for ${marketId.slice(0, 20)} (Supabase write failed)`);
    }
  }

  /**
   * Execute a copy of the leader's trade.
   */
  async execute(
    leaderTrade: LeaderTrade,
    confirmation: ConfirmationDecision,
    confirmationReason: string,
    leaderPortfolioSize: number,
    sizeMultiplier: number = 1.0,
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

    // Stop-loss cooldown: block re-entry on markets that recently triggered stop-loss
    const cooldownStart = this.stopLossCooldown.get(leaderTrade.marketId);
    if (cooldownStart && Date.now() - cooldownStart < this.STOP_LOSS_COOLDOWN_MS) {
      const remainingMin = Math.ceil((this.STOP_LOSS_COOLDOWN_MS - (Date.now() - cooldownStart)) / 60000);
      logger.debug(`CopyExecutor: Stop-loss cooldown active for ${leaderTrade.marketId.slice(0, 20)} — ${remainingMin}min remaining`);
      return { success: false, reason: `Stop-loss cooldown — re-entry blocked for ${remainingMin}min` };
    } else if (cooldownStart) {
      this.stopLossCooldown.delete(leaderTrade.marketId); // expired, clean up
    }

    // Deduplication: if we already have an open position in this market, skip
    if (this.openCopyTrades.has(leaderTrade.marketId)) {
      const existing = this.openCopyTrades.get(leaderTrade.marketId)!;
      logger.debug(`CopyExecutor: Already have open position in ${leaderTrade.marketId.slice(0, 20)} ($${existing.ourSize.toFixed(2)}) — skipping duplicate`);
      return { success: false, reason: `Already have open position in this market` };
    }

    // Rank-1 collision: if a watcher opened this market, close it and re-enter at full rank-1 size
    const isRank1 = !leaderTrade.rank || leaderTrade.rank === 1;
    if (isRank1 && this.watcherPositions.has(leaderTrade.marketId)) {
      const watcherRank = this.watcherPositions.get(leaderTrade.marketId)!;
      logger.info(`CopyExecutor: Rank-1 collision — closing rank-${watcherRank} watcher position for ${leaderTrade.marketId.slice(0, 12)}, re-entering at rank-1 size`);
      await this.closePosition(leaderTrade.marketId, leaderTrade.entryPrice, 'rank1_override');
      this.watcherPositions.delete(leaderTrade.marketId);
    }

    // Rolling wallet performance — pass-through with logging (feeds devil's advocate)
    // Graduated cold streak filter — smarter than binary block/allow
    // Hard data: 0% WR wallet (0x2005d16a) lost $723 in 24h when unblocked
    const rollingStats = this.getWalletRollingStats(leaderTrade.leaderWallet);
    (leaderTrade as any).walletRollingWR = rollingStats.winRate;
    (leaderTrade as any).walletRollingCount = rollingStats.sampleSize;

    if (rollingStats.sampleSize >= this.ROLLING_MIN_SAMPLE) {
      if (rollingStats.winRate < 0.20) {
        // HARD BLOCK: below 20% WR = proven destructive. No exceptions.
        this.blockedCount++;
        logger.info(`CopyExecutor: HARD BLOCK — ${leaderTrade.leaderWallet.slice(0,10)} rolling ${rollingStats.sampleSize}-trade WR ${(rollingStats.winRate * 100).toFixed(0)}% < 20% — trade rejected`);
        return { success: false, reason: `Hard block: wallet WR ${(rollingStats.winRate * 100).toFixed(0)}% (below 20% threshold)` };
      } else if (rollingStats.winRate < this.ROLLING_MIN_WIN_RATE) {
        // REDUCED SIZE: 20-40% WR = underperforming. Trade at 25% size, devil's advocate decides.
        logger.info(`CopyExecutor: COLD WALLET — ${leaderTrade.leaderWallet.slice(0,10)} rolling WR ${(rollingStats.winRate * 100).toFixed(0)}% — 25% size (devil's advocate will assess)`);
        (leaderTrade as any)._coldSizeMultiplier = 0.25;
      }
    } else {
      // Fix A: Probationary cap for unproven wallets. Wallets with <5 trades in
      // the rolling window get "benefit of the doubt" on WR but NOT on sizing.
      // Prevents another $63 blind bet (0x37c187 went 0/6 on full sizing).
      const PROBATION_MAX = parseFloat(process.env.PROBATION_MAX_DOLLARS ?? '15');
      if (rollingStats.sampleSize < this.ROLLING_MIN_SAMPLE) {
        (leaderTrade as any)._probationCap = PROBATION_MAX;
        logger.info(`CopyExecutor: PROBATION — ${leaderTrade.leaderWallet.slice(0,10)} only ${rollingStats.sampleSize} trades — capped at $${PROBATION_MAX} until proven`);
      }
    }

    // Expired market detection — if market question contains a date that has passed, auto-reject
    const marketQ = leaderTrade.marketQuestion;
    const datePatterns = marketQ.match(/\b(20\d{2}-\d{2}-\d{2})\b/g) ??
      marketQ.match(/\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}\b/gi) ??
      marketQ.match(/\bby\s+(April|March|May|June|July)\s+(\d{1,2})\b/i) ? [marketQ] : null;
    if (datePatterns) {
      // Check for explicit YYYY-MM-DD dates
      const isoMatch = marketQ.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
      if (isoMatch) {
        const marketDate = new Date(isoMatch[1] + 'T23:59:59Z');
        if (marketDate < new Date()) {
          this.blockedCount++;
          logger.info(`CopyExecutor: EXPIRED MARKET — date ${isoMatch[1]} has passed — "${marketQ.slice(0,50)}"`);
          return { success: false, reason: `Expired market: date ${isoMatch[1]} has passed` };
        }
      }
      // Check for "by April 7" style dates
      const byMatch = marketQ.match(/\bby\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})\b/i);
      if (byMatch) {
        const monthNames = ['january','february','march','april','may','june','july','august','september','october','november','december'];
        const monthIdx = monthNames.indexOf(byMatch[1].toLowerCase());
        if (monthIdx >= 0) {
          const year = new Date().getFullYear();
          const deadlineDate = new Date(year, monthIdx, parseInt(byMatch[2]), 23, 59, 59);
          if (deadlineDate < new Date()) {
            this.blockedCount++;
            logger.info(`CopyExecutor: EXPIRED MARKET — "by ${byMatch[1]} ${byMatch[2]}" has passed — "${marketQ.slice(0,50)}"`);
            return { success: false, reason: `Expired market: "by ${byMatch[1]} ${byMatch[2]}" deadline passed` };
          }
        }
      }
    }

    // Near-worthless token detection (price < 0.01 = likely expired/dead market)
    if (leaderTrade.entryPrice < 0.01) {
      this.blockedCount++;
      logger.info(`CopyExecutor: DEAD MARKET — price ${leaderTrade.entryPrice.toFixed(4)} < 0.01 — likely expired`);
      return { success: false, reason: `Dead market: price ${leaderTrade.entryPrice.toFixed(4)} near zero` };
    }

    // Phase 1 (hybrid): Sports category filter. The AI has zero information
    // advantage on sports markets (news feeds don't cover live scores). 70% of
    // historical volume was sports, contributing the majority of losses.
    // Override: ALLOW_SPORTS=true in .env to re-enable.
    if (process.env.ALLOW_SPORTS !== 'true') {
      const category = categoriseMarket(leaderTrade.marketQuestion);
      if (category === 'sports') {
        this.blockedCount++;
        logger.info(`CopyExecutor: SPORTS FILTER — "${leaderTrade.marketQuestion.slice(0, 50)}" skipped (no AI edge on sports)`);
        return { success: false, reason: `Sports market filtered (no information advantage)` };
      }
    }

    // P2: Heavy favourite filter — applies to ALL ranks
    const entryPrice = leaderTrade.entryPrice;
    if (entryPrice > MAX_WATCHER_PRICE) {
      this.blockedCount++;
      logger.info(`CopyExecutor: HEAVY FAV SKIP — price ${entryPrice.toFixed(3)} > ${MAX_WATCHER_PRICE} threshold — risk/reward inverted`);
      return { success: false, reason: `Heavy favourite: price ${entryPrice.toFixed(3)} > ${MAX_WATCHER_PRICE} max` };
    }

    // P4: Coin-flip filter — applies to ALL ranks
    // Prices within 6% of 0.50 have no directional edge. Historical: 38 trades at 0.40-0.55, net -$220
    if (Math.abs(entryPrice - 0.5) < EDGE_FLOOR_DISTANCE) {
      this.blockedCount++;
      logger.info(`CopyExecutor: COIN-FLIP SKIP — price ${entryPrice.toFixed(3)} too close to 0.50 (within ${EDGE_FLOOR_DISTANCE})`);
      return { success: false, reason: `Coin-flip zone: price ${entryPrice.toFixed(3)} within ${(EDGE_FLOOR_DISTANCE*100).toFixed(0)}% of 0.50` };
    }

    // For rank 2-5 watcher trades: apply extra filters before using a position slot
    if (leaderTrade.rank && leaderTrade.rank >= 2) {
      // Filter 0: BANNED market types — binary 99% loss risk
      // Spread bets on Polymarket resolve all-or-nothing. When wrong they lose ~100%.
      // Net historical impact: -$118.59 from spreads alone. Hard ban, no exceptions.
      const BANNED_PREFIXES = ['Spread:'];
      const BANNED_PATTERNS = [/^spread:/i];
      const isBannedType = BANNED_PREFIXES.some(p => leaderTrade.marketQuestion.startsWith(p))
        || BANNED_PATTERNS.some(r => r.test(leaderTrade.marketQuestion));
      if (isBannedType) {
        this.blockedCount++;
        logger.info(`CopyExecutor: BANNED market type — spread bet skipped: "${leaderTrade.marketQuestion.slice(0, 60)}"`);
        return { success: false, reason: `Banned market type: spread bet` };
      }

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

      // Filter 3: capital deployment cap — never exceed 65% deployed at once
      const CAPITAL_CAP_PCT = parseFloat(process.env.CAPITAL_CAP_PCT ?? '0.65');
      const totalDeployed = Array.from(this.openCopyTrades.values())
        .reduce((sum, t) => sum + (t.ourSize ?? 0), 0);
      const deployedPct = this.ourPortfolio > 0 ? totalDeployed / this.ourPortfolio : 0;
      if (deployedPct >= CAPITAL_CAP_PCT) {
        this.blockedCount++;
        logger.debug(`CopyExecutor: Capital cap reached — ${(deployedPct * 100).toFixed(1)}% deployed (max ${(CAPITAL_CAP_PCT * 100).toFixed(0)}%)`);
        return { success: false, reason: `Capital cap: ${(deployedPct * 100).toFixed(1)}% deployed (max ${(CAPITAL_CAP_PCT * 100).toFixed(0)}%)` };
      }

      // Filter 4: position count cap (no rank reservation — first confirmed, first served)
      const maxPos = parseInt(process.env.MAX_OPEN_POSITIONS ?? '10');
      if (this.openCopyTrades.size >= maxPos) {
        this.blockedCount++;
        logger.debug(`CopyExecutor: Position cap reached (${this.openCopyTrades.size}/${maxPos})`);
        return { success: false, reason: `Position cap ${maxPos} reached` };
      }
    }

    // Capital cap for all ranks (rank-1 included)
    const CAPITAL_CAP_ALL = parseFloat(process.env.CAPITAL_CAP_PCT ?? '0.65');
    const totalDeployedAll = Array.from(this.openCopyTrades.values())
      .reduce((sum, t) => sum + (t.ourSize ?? 0), 0);
    const deployedPctAll = this.ourPortfolio > 0 ? totalDeployedAll / this.ourPortfolio : 0;
    if (deployedPctAll >= CAPITAL_CAP_ALL) {
      this.blockedCount++;
      logger.debug(`CopyExecutor: Capital cap reached (rank-${isRank1 ? 1 : leaderTrade.rank}) — ${(deployedPctAll * 100).toFixed(1)}% deployed`);
      return { success: false, reason: `Capital cap: ${(deployedPctAll * 100).toFixed(1)}% deployed (max ${(CAPITAL_CAP_ALL * 100).toFixed(0)}%)` };
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

    // Performance-based sizing boost for consistently hot wallets (>= 60% rolling WR)
    if (rollingStats.sampleSize >= this.ROLLING_MIN_SAMPLE && rollingStats.winRate >= this.ROLLING_BOOST_RATE) {
      const beforeBoost = ourSize;
      ourSize = Math.round(ourSize * 1.3 * 100) / 100;
      logger.info(`CopyExecutor: Perf boost — ${leaderTrade.leaderWallet.slice(0,10)} ${(rollingStats.winRate*100).toFixed(0)}% WR → 1.3x → $${beforeBoost.toFixed(2)} → $${ourSize.toFixed(2)}`);
    }

    // Apply MiroFish confidence-based sizing (1.5x for high confidence, 0.7x for contradicts)
    if (sizeMultiplier !== 1.0) {
      const beforeSize = ourSize;
      ourSize = Math.round(ourSize * sizeMultiplier * 100) / 100;
      logger.info(`CopyExecutor: MiroFish sizing: ${sizeMultiplier}x → $${beforeSize.toFixed(2)} → $${ourSize.toFixed(2)}`);
    }

    // Apply cold wallet size reduction (25% for 20-40% WR wallets)
    const coldMultiplier = (leaderTrade as any)?._coldSizeMultiplier;
    if (coldMultiplier && coldMultiplier < 1.0) {
      const beforeCold = ourSize;
      ourSize = Math.round(ourSize * coldMultiplier * 100) / 100;
      logger.info(`CopyExecutor: Cold wallet reduction — ${coldMultiplier}x → $${beforeCold.toFixed(2)} → $${ourSize.toFixed(2)}`);
    }

    // Fix A: Probationary cap — unproven wallets (<5 trades) get hard-capped
    // before any other cap logic. The $63 Barcelona loss proved full-sized bets
    // on zero-history wallets are unacceptable.
    const probationCap = (leaderTrade as any)?._probationCap;
    if (probationCap && ourSize > probationCap) {
      logger.info(`CopyExecutor: Probation cap $${ourSize.toFixed(2)} → $${probationCap.toFixed(2)} (wallet has <5 trades)`);
      ourSize = probationCap;
    }

    // P3: Hard cap position size at $150 — but exempt longshots (< 0.25 entry)
    // Longshots are our primary profit driver (+$1,429 total). Capping them kills asymmetric payoff.
    const MAX_POSITION_SIZE = parseFloat(process.env.MAX_POSITION_DOLLARS ?? '150');
    const entryPriceForCap = leaderTrade.entryPrice;
    if (ourSize > MAX_POSITION_SIZE && entryPriceForCap >= 0.25) {
      logger.info(`CopyExecutor: Size capped $${ourSize.toFixed(2)} → $${MAX_POSITION_SIZE.toFixed(2)} (hard cap, non-longshot)`);
      ourSize = MAX_POSITION_SIZE;
    } else if (ourSize > MAX_POSITION_SIZE && entryPriceForCap < 0.25) {
      logger.info(`CopyExecutor: Longshot exempt from cap — $${ourSize.toFixed(2)} at ${entryPriceForCap.toFixed(3)} odds (keeping full size)`);
    }

    if (ourSize < 1) {
      this.blockedCount++;
      return { success: false, reason: `Computed size $${ourSize.toFixed(2)} too small (min $1)` };
    }

    // Phase 3 (hybrid): Contrarian paper-test. Log what the inverse trade would
    // be so we can track whether fading the leaders outperforms following them.
    const contrarianSide = leaderTrade.side === 'buy' ? 'sell' : 'buy';
    logger.info(`CONTRARIAN PAPER: would ${contrarianSide.toUpperCase()} ${leaderTrade.outcome} on "${leaderTrade.marketQuestion.slice(0, 50)}" @ ${leaderTrade.entryPrice.toFixed(3)} ($${ourSize.toFixed(2)})`);

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
        // Update rolling wallet performance window
        if (copyTrade && copyTrade.leaderWallet) {
          this.updateWalletPerformance(copyTrade.leaderWallet, (copyTrade.pnl ?? 0) > 0);

        }
        // Cooldown: if this was a stop-loss close, block re-entry for 60 minutes
        if (reason === 'stop_loss' || reason === 'stop-loss') {
          this.stopLossCooldown.set(marketId, Date.now());
          logger.debug(`CopyExecutor: Stop-loss cooldown set for ${marketId.slice(0, 20)} — re-entry blocked for 60 min`);
        }
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

  /**
   * Hydrate rolling wallet performance from Supabase closed trades on startup.
   * Rows should be sorted most-recent-first; we reverse to process oldest→newest
   * so the window correctly reflects the last N trades in chronological order.
   */
  hydrateWalletPerformance(rows: Array<Record<string, unknown>>): void {
    const reversed = [...rows].reverse(); // oldest first
    for (const row of reversed) {
      const wallet = row.leader_wallet as string;
      const pnl    = parseFloat((row.pnl as string | number | null) as string ?? '0');
      if (wallet) this.updateWalletPerformance(wallet, pnl > 0);
    }
    logger.info(`CopyExecutor: Hydrated rolling window for ${this.walletRollingWindow.size} wallet(s)`);
    for (const [w, window] of this.walletRollingWindow.entries()) {
      const wr = window.length > 0 ? window.filter(Boolean).length / window.length : 0;
      const status = wr < this.ROLLING_MIN_WIN_RATE && window.length >= this.ROLLING_MIN_SAMPLE ? ' ⚠ COLD' :
                     wr >= this.ROLLING_BOOST_RATE  && window.length >= this.ROLLING_MIN_SAMPLE ? ' ★ HOT' : '';
      logger.info(`  ${w.slice(0,10)}: ${(wr*100).toFixed(0)}% WR (${window.length}/${this.ROLLING_WINDOW_SIZE} trades)${status}`);
    }
  }

  private updateWalletPerformance(wallet: string, won: boolean): void {
    if (!this.walletRollingWindow.has(wallet)) this.walletRollingWindow.set(wallet, []);
    const win = this.walletRollingWindow.get(wallet)!;
    win.push(won);
    if (win.length > this.ROLLING_WINDOW_SIZE) win.shift();
  }

  /** Returns true if wallet has a hot rolling WR (>= ROLLING_BOOST_RATE with enough sample).
   *  Used by runner.ts to elevate high-performing wallets to rank-1 treatment regardless
   *  of their current leaderboard position. */
  isHotWallet(wallet: string): boolean {
    const stats = this.getWalletRollingStats(wallet);
    return stats.sampleSize >= this.ROLLING_MIN_SAMPLE && stats.winRate >= this.ROLLING_BOOST_RATE;
  }

  getLeaderRollingStats(wallet: string): { winRate: number; sampleSize: number } {
    return this.getWalletRollingStats(wallet);
  }

  private getWalletRollingStats(wallet: string): { winRate: number; sampleSize: number } {
    const win = this.walletRollingWindow.get(wallet.toLowerCase()) ?? [];
    if (win.length === 0) return { winRate: 0.5, sampleSize: 0 }; // no data → benefit of the doubt
    return { winRate: win.filter(Boolean).length / win.length, sampleSize: win.length };
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
