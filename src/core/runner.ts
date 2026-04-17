import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../utils/logger.js';
import { sendTelegramAlert } from '../utils/telegram.js';
import { loadConfig } from './config.js';
import { RiskDial } from './config.js';
import { RiskManager } from './risk-manager.js';

const _runnerDir = dirname(fileURLToPath(import.meta.url));
const PEAK_BALANCE_FILE = resolve(_runnerDir, '../../.peak-balance.json');
import { PaperTradingEngine } from './paper-trading.js';
import { LeaderboardScraper } from '../leaderboard/scraper.js';
import { TraderScorer } from '../leaderboard/scorer.js';
import { LeaderSelector } from '../leaderboard/selector.js';
import { WalletMonitor } from '../monitor/wallet-monitor.js';
import { ConfirmationLayer } from '../confirmation/confirmation-layer.js';
import { CopyExecutor } from '../execution/copy-executor.js';
import { SignalExecutor } from '../execution/signal-executor.js';
import { NewsScanner } from '../signals/news-scanner.js';
import { MarketCache } from '../signals/market-cache.js';
import { SignalGenerator } from '../signals/signal-generator.js';
import { AIClassifier } from '../signals/ai-classifier.js';
import * as db from '../data/supabase.js';
import { PositionLifecycleManager } from './position-lifecycle.js';
import type { Leader, LeaderTrade } from '../types/index.js';
import type { TradingSignal } from '../signals/signal-generator.js';

export class Runner {
  private config = loadConfig();
  private running = false;
  private statusTimer: ReturnType<typeof setInterval> | null = null;
  private dayRolloverTimer: ReturnType<typeof setInterval> | null = null;
  private reconciliationTimer: ReturnType<typeof setInterval> | null = null;

  // Core modules
  private riskDial: RiskDial;
  private riskManager: RiskManager;
  private paperEngine: PaperTradingEngine;

  // Leaderboard
  private scraper: LeaderboardScraper;
  private scorer: TraderScorer;
  private selector: LeaderSelector;

  // Monitoring
  private walletMonitor: WalletMonitor;

  // Signals
  private newsScanner: NewsScanner;
  private _newsBuffer: Array<{headline: string; source: string; timestamp: number}> = [];

  // Hybrid strategy (Phase 2)
  private marketCache: MarketCache;
  private signalGenerator: SignalGenerator;
  private signalExecutor: SignalExecutor;

  // Execution
  private confirmationLayer: ConfirmationLayer;
  private copyExecutor: CopyExecutor;
  private lifecycleManager: PositionLifecycleManager;

  // State
  private currentLeader: Leader | null = null;
  private vetoedTodayCount = 0;
  private consecutiveVetoes = 0;
  private pendingTrades: Map<string, LeaderTrade> = new Map(); // tradeId → trade being processed

  constructor() {
    const cfg = this.config;

    this.riskDial = new RiskDial(cfg.risk.level);

    let restoredPeak: number | undefined;
    try {
      const raw = readFileSync(PEAK_BALANCE_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      if (typeof parsed.peakBalance === 'number' && parsed.peakBalance > 0) {
        restoredPeak = parsed.peakBalance;
      }
    } catch { /* first run or missing file */ }

    this.riskManager = new RiskManager(this.riskDial, cfg.totalCapitalUsdc, {
      restoredPeakBalance: restoredPeak,
      onPeakBalanceChange: (peak) => {
        try { writeFileSync(PEAK_BALANCE_FILE, JSON.stringify({ peakBalance: peak, updatedAt: new Date().toISOString() })); }
        catch { /* non-fatal */ }
      },
    });
    this.paperEngine = new PaperTradingEngine(cfg.totalCapitalUsdc, cfg.risk.level);

    this.scraper = new LeaderboardScraper({
      pollIntervalMs: cfg.leaderboard.pollIntervalMs,
      topN: cfg.leaderboard.topN,
    });

    this.scorer = new TraderScorer();

    this.selector = new LeaderSelector({
      hysteresisMarginPct: cfg.rotation.hysteresisMarginPct,
      hysteresisMinDurationMs: cfg.rotation.hysteresisMinDurationMs,
      onRotation: async (event) => {
        logger.info(`LEADER ROTATION: ${event.previousLeader?.walletAddress?.slice(0, 10) ?? 'none'} → ${event.newLeader.walletAddress.slice(0, 10)} (${event.reason})`);
        this.currentLeader = event.newLeader;
        // setWatchers is now called in onLeaderboardUpdate — no need to call setLeader here.
        // Keep rotation event for logging and Supabase history only.

        if (cfg.supabase.url) {
          await db.setCurrentLeader(event.newLeader.walletAddress);
          await db.insertLeaderHistory(event);
        }
      },
    });

    this.walletMonitor = new WalletMonitor({
      pollIntervalMs: cfg.walletMonitor.pollIntervalMs,
    });

    this.newsScanner = new NewsScanner();

    this.confirmationLayer = new ConfirmationLayer();

    this.copyExecutor = new CopyExecutor({
      paperEngine: this.paperEngine,
      riskManager: this.riskManager,
      paperMode: cfg.paperMode,
      ourPortfolio: cfg.totalCapitalUsdc,
      riskLevel: cfg.risk.level,
    });

    // Phase 2 (hybrid): Signal-based original trading components
    this.marketCache = new MarketCache();
    this.signalGenerator = new SignalGenerator({
      marketCache: this.marketCache,
      classifier: new AIClassifier(),
    });
    this.signalExecutor = new SignalExecutor({
      paperEngine: this.paperEngine,
      riskManager: this.riskManager,
      paperMode: cfg.paperMode,
    });

    // Position Lifecycle Manager — auto-closes resolved, stale, and stop-loss positions
    this.lifecycleManager = new PositionLifecycleManager({
      closePosition: (marketId, exitPrice, reason) =>
        this.copyExecutor.closePosition(marketId, exitPrice, reason),
      getOpenTrades: () => this.copyExecutor.getOpenTrades(),
      persistClose: async (trade) => {
        if (trade.id && cfg.supabase.url) {
          try {
            await db.updateCopyTrade(trade.id, {
              status: 'closed' as any,
              pnl: trade.pnl,
              exitTime: trade.exitTime,
            });
            logger.info(`Lifecycle: Supabase close persisted ${trade.id}`);
          } catch (err) {
            logger.error(`Lifecycle: CRITICAL — Supabase close failed for ${trade.id}: ${err}`);
            sendTelegramAlert(`🔴 SYNC ERROR: Lifecycle close failed for trade ${trade.id}`);
          }
        }
      },
      maxPositionAgeMs: parseInt(process.env.MAX_POSITION_AGE_HOURS ?? '48') * 3600000,
      stopLossPct: parseFloat(process.env.STOP_LOSS_PCT ?? '0.30'),
    });
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    logger.info('='.repeat(60));
    logger.info('PATS-Copy Starting');
    logger.info(`Mode: ${this.config.paperMode ? 'PAPER' : 'LIVE'}`);
    logger.info(`Risk: ${this.config.risk.level}`);
    logger.info(`Capital: $${this.config.totalCapitalUsdc}`);
    logger.info('='.repeat(60));

    // Init Supabase
    if (this.config.supabase.url && this.config.supabase.serviceKey) {
      db.initSupabase(this.config.supabase.url, this.config.supabase.serviceKey);
      // Hydrate paper trading engine from Supabase so restarts don't lose state
      await this.paperEngine.hydrateFromSupabase();
      // Hydrate executor's open positions so close detection persists Supabase updates
      const { data: openRows } = await db.getClient()
        .from('copy_trades')
        .select('*')
        .in('status', ['open', 'pending']);
      if (openRows) this.copyExecutor.hydrateOpenTrades(openRows);

      // Hydrate rolling wallet performance window from recent closed trades
      const { data: perfRows } = await db.getClient()
        .from('copy_trades')
        .select('leader_wallet, pnl')
        .in('status', ['closed', 'stopped'])
        .order('entry_time', { ascending: false })
        .limit(200);
      if (perfRows) this.copyExecutor.hydrateWalletPerformance(perfRows);
    } else {
      logger.warn('Supabase not configured — running without persistence');
    }

    // Start signals
    this.setupSignals();

    // Start wallet monitor — will activate once we have a leader
    this.setupWalletMonitor();
    this.walletMonitor.start();

    // Start leaderboard scraper
    this.scraper.start((rawLeaders) => this.onLeaderboardUpdate(rawLeaders));

    // Status log every 5 minutes
    this.statusTimer = setInterval(() => this.logStatus(), 5 * 60 * 1000);

    // Day rollover check every hour
    this.dayRolloverTimer = setInterval(() => this.handleDayRollover(), 60 * 60 * 1000);

    // Position Lifecycle Manager — auto-closes resolved/stale/stop-loss positions
    this.lifecycleManager.start();

    // Reconciliation: sync in-memory state with Supabase every 5 minutes
    if (this.config.supabase.url) {
      this.reconciliationTimer = setInterval(() => this.reconcileWithSupabase(), 15 * 60 * 1000);
    }

    logger.info('PATS-Copy fully started. Waiting for leaderboard data...');
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.statusTimer) { clearInterval(this.statusTimer); this.statusTimer = null; }
    if (this.dayRolloverTimer) { clearInterval(this.dayRolloverTimer); this.dayRolloverTimer = null; }
    if (this.reconciliationTimer) { clearInterval(this.reconciliationTimer); this.reconciliationTimer = null; }

    this.scraper.stop();
    this.walletMonitor.stop();
    this.newsScanner.stop();
    this.marketCache.stop();

    logger.info('PATS-Copy stopped');
  }

  private setupSignals(): void {
    this.newsScanner.start();
    this.newsScanner.on('news', (item: { headline: string; source?: string; timestamp?: string; metadata?: { feedSource?: string } }) => {
      const newsEntry = {
        headline: item.headline,
        source: item.metadata?.feedSource ?? item.source ?? 'unknown',
        timestamp: item.timestamp ? new Date(item.timestamp).getTime() : Date.now(),
      };
      this._newsBuffer.push(newsEntry);
      if (this._newsBuffer.length > 100) this._newsBuffer.splice(0, this._newsBuffer.length - 80);
      this.confirmationLayer.updateNews(this._newsBuffer);

      // Phase 2 (hybrid): Feed news into signal generator for original trades.
      // The signal generator matches news against active markets and emits
      // trading signals when it finds high-confidence opportunities.
      this.signalGenerator.processNewsItem(newsEntry).catch(err =>
        logger.debug(`SignalGenerator: news processing failed: ${err}`)
      );
    });

    // Start market cache (polls Gamma API for active non-sports markets)
    this.marketCache.start();

    // Handle signals from the signal generator
    this.signalGenerator.on('signal', async (signal: TradingSignal) => {
      logger.info(`SIGNAL RECEIVED: ${signal.side.toUpperCase()} on "${signal.market.question.slice(0, 50)}" (${(signal.confidence * 100).toFixed(0)}% confidence) — ${signal.reasoning}`);
      sendTelegramAlert(
        `🎯 <b>SIGNAL TRADE</b>\n` +
        `📊 ${signal.side.toUpperCase()} "${signal.market.question.slice(0, 50)}"\n` +
        `💪 ${(signal.confidence * 100).toFixed(0)}% confidence\n` +
        `📰 ${signal.newsHeadline.slice(0, 60)}`
      );

      const result = await this.signalExecutor.execute(signal);
      if (result.success && result.trade) {
        if (this.config.supabase.url) {
          try {
            const dbId = await db.insertCopyTrade({
              leaderWallet: 'signal-bot',
              marketId: signal.market.slug,
              marketQuestion: signal.market.question,
              tokenId: signal.market.conditionId,
              outcome: signal.market.outcomes[0] ?? 'Yes',
              side: signal.side,
              leaderEntryPrice: result.trade.entryPrice,
              ourEntryPrice: result.trade.entryPrice,
              ourSize: result.trade.usdcAmount,
              confirmationResult: 'approved' as any,
              confirmationReason: `Signal: ${signal.reasoning} | News: ${signal.newsHeadline.slice(0, 80)}`,
              status: 'open' as any,
              riskLevel: 'paper' as any,
              entryTime: new Date().toISOString(),
            } as any);
            if (dbId) { result.trade.id = dbId; logger.info(`Supabase: signal trade saved ${dbId}`); }
          } catch (err) { logger.warn(`Supabase: signal trade insert failed: ${err}`); }
        }
        logger.info(`SIGNAL TRADE EXECUTED: $${result.trade.usdcAmount?.toFixed(2) ?? '?'} on "${signal.market.question.slice(0, 40)}"`);
      } else {
        logger.info(`Signal trade not executed: ${result.reason}`);
      }
    });
  }

  private setupWalletMonitor(): void {
    this.walletMonitor.on('new-trade', (trade: LeaderTrade) => {
      this.handleLeaderTrade(trade);
    });

    this.walletMonitor.on('leader-closed', async (data: { marketId: string; marketQuestion: string; leaderWallet: string; rank?: number; exitPrice?: number }) => {
      const exitPrice = typeof data.exitPrice === 'number' && data.exitPrice > 0
        ? data.exitPrice
        : 0.5;
      const priceNote = exitPrice === 0.5 && data.exitPrice == null
        ? ' (fallback midpoint)'
        : '';
      logger.info(`Leader closed position on "${data.marketQuestion.slice(0, 50)}" @ ${exitPrice.toFixed(3)}${priceNote}`);
      const closedTrade = await this.copyExecutor.closePosition(data.marketId, exitPrice, 'leader_closed');
      if (!closedTrade) return;
      const pnlStr = closedTrade.pnl !== undefined ? `$${closedTrade.pnl.toFixed(2)}` : 'n/a';
      logger.info(`Closed our copy position for ${data.marketId.slice(0, 12)}... pnl=${pnlStr}`);
      // Write-through: persist close to Supabase (await, don't fire-and-forget)
      if (closedTrade.id && this.config.supabase.url) {
        try {
          await db.updateCopyTrade(closedTrade.id, {
            status: 'closed',
            pnl: closedTrade.pnl,
            exitTime: closedTrade.exitTime,
          });
          logger.info(`Supabase: trade close persisted ${closedTrade.id}`);
        } catch (err) {
          logger.error(`Supabase: CRITICAL — failed to persist close for ${closedTrade.id}: ${err}`);
          sendTelegramAlert(`🔴 SYNC ERROR: Failed to persist trade close for ${data.marketQuestion.slice(0, 30)}`);
        }
      }
    });
  }

  private async onLeaderboardUpdate(rawLeaders: Leader[]): Promise<void> {
    const scored = this.scorer.scoreAndRank(rawLeaders);

    // Enrich leaders that are actively monitored with real trade stats
    const enriched = scored.map(leader => {
      const stats = this.walletMonitor.getWalletStats(leader.walletAddress);
      if (stats.tradeCount > 0) {
        return {
          ...leader,
          tradeCount30d: Math.max(leader.tradeCount30d, stats.tradeCount),
          lastTradeTime: stats.lastTradeTime || leader.lastTradeTime,
        };
      }
      return leader;
    });
    // Re-score with enriched data so active wallets score higher
    const rescored = this.scorer.scoreAndRank(enriched);

    // F11: Apply rolling-WR penalty. The composite scorer uses 30-day metrics from
    // the Polymarket API, but a wallet can look great over 30 days while crashing in
    // the last 10 trades. The HARD BLOCK filter catches these at execution time (97.6%
    // rejection rate in the 2026-04-12 log window), but the scorer still ranks them
    // highly, wasting watcher slots. This penalty multiplies the composite score by
    // 0.3 for any wallet with <30% rolling WR over ≥5 recent copy-outcomes, so they
    // drop in rank BEFORE reaching the watcher pool.
    const ROLLING_PENALTY_WR = Number(process.env.ROLLING_PENALTY_WR ?? '0.30') || 0.30;
    const ROLLING_PENALTY_MULTIPLIER = Number(process.env.ROLLING_PENALTY_MULTIPLIER ?? '0.30') || 0.30;
    const ROLLING_PENALTY_MIN_SAMPLE = 5;
    for (const leader of rescored) {
      const stats = this.copyExecutor.getLeaderRollingStats(leader.walletAddress);
      if (stats.sampleSize >= ROLLING_PENALTY_MIN_SAMPLE && stats.winRate < ROLLING_PENALTY_WR) {
        const before = leader.compositeScore;
        leader.compositeScore = Math.round(leader.compositeScore * ROLLING_PENALTY_MULTIPLIER * 100) / 100;
        logger.info(
          `F11: Rolling penalty on ${leader.walletAddress.slice(0, 10)}... — ` +
          `${(stats.winRate * 100).toFixed(0)}% WR (${stats.sampleSize} trades) < ${(ROLLING_PENALTY_WR * 100).toFixed(0)}% threshold → ` +
          `score ${before.toFixed(1)} × ${ROLLING_PENALTY_MULTIPLIER} = ${leader.compositeScore.toFixed(1)}`
        );
      }
    }
    rescored.sort((a, b) => b.compositeScore - a.compositeScore);

    // Await upsert before selector.update() so setCurrentLeader finds rows in DB
    if (this.config.supabase.url) {
      await db.upsertLeaders(rescored).catch(err => logger.warn(`Supabase leader update failed: ${err}`));
    }

    const newLeader = this.selector.update(rescored);
    if (newLeader && newLeader.walletAddress !== this.currentLeader?.walletAddress) {
      this.currentLeader = newLeader;
    }

    // Update the watcher pool: top 5 traders (rank 1 = leader, 2-5 = watchers)
    // Plus any priority wallets that should always be tracked
    const PRIORITY_WALLETS = [
      { walletAddress: '0x6ac5bb06a9eb05641fd5e82640268b92f3ab4b6e', label: 'Op0jogggg' }, // $1M+ profit, 21K+ trades
    ];

    const top5 = this.selector.getTopN(5);
    const watcherList = top5.map((leader, i) => ({ walletAddress: leader.walletAddress, rank: i + 1 }));

    // Add priority wallets as watchers (rank 2) if not already in the list
    for (const pw of PRIORITY_WALLETS) {
      const alreadyTracked = watcherList.some(w => w.walletAddress.toLowerCase() === pw.walletAddress.toLowerCase());
      if (!alreadyTracked) {
        watcherList.push({ walletAddress: pw.walletAddress, rank: 2 });
        logger.info(`Priority wallet added: ${pw.label} (${pw.walletAddress.slice(0, 10)}...)`);
      }
    }

    if (watcherList.length > 0) {
      this.walletMonitor.setWatchers(watcherList);
    }

    const watcherSummary = watcherList.map((w, i) => `${w.walletAddress.slice(0, 8)}(r${w.rank})`).join(', ');
    logger.info(`Leaderboard update: ${rescored.length} traders scored. Watching ${watcherList.length}: ${watcherSummary}`);
  }

  private async handleLeaderTrade(trade: LeaderTrade): Promise<void> {
    const tradeKey = trade.tradeId || `${trade.marketId}:${trade.timestamp}`;

    // Deduplicate — don't process same trade twice
    if (this.pendingTrades.has(tradeKey)) {
      logger.debug(`WalletMonitor: Trade ${tradeKey} already being processed`);
      return;
    }
    this.pendingTrades.set(tradeKey, trade);

    try {
      logger.info(`Processing leader trade: ${trade.side.toUpperCase()} ${trade.outcome} on "${trade.marketQuestion.slice(0, 50)}" @ $${trade.entryPrice.toFixed(3)}`);

      // Step 1: Run confirmation layer
      // Fix 3: If a watcher wallet has a hot rolling WR (>= 60%), elevate it to rank-1
      // treatment so it bypasses the strict corroboration gate. Leaderboard rank drifts
      // but rolling WR is a more reliable quality signal.
      // F9a: Attach rolling wallet stats BEFORE confirmation so devil's advocate
      // has data to operate on. Previously set inside copyExecutor.execute() which
      // runs after confirmation, leaving devil's advocate permanently dormant.
      const rollingStats = this.copyExecutor.getLeaderRollingStats(trade.leaderWallet);
      (trade as any).walletRollingWR = rollingStats.winRate;
      (trade as any).walletRollingCount = rollingStats.sampleSize;

      let tradeForConfirmation = trade;
      if (trade.rank && trade.rank >= 2 && this.copyExecutor.isHotWallet(trade.leaderWallet)) {
        logger.info(`Runner: Hot wallet ${trade.leaderWallet.slice(0, 10)} at rank-${trade.rank} → elevated to rank-1 confirmation treatment`);
        tradeForConfirmation = { ...trade, rank: 1 };
      }
      const confirmation = await this.confirmationLayer.confirm(tradeForConfirmation);

      // Step 2: Execute (or log veto)
      const leaderPortfolio = this.currentLeader?.totalPnl30d
        ? this.config.totalCapitalUsdc * 2 // Rough estimate: leader manages more capital
        : this.config.totalCapitalUsdc;

      const result = await this.copyExecutor.execute(
        trade,
        confirmation.decision,
        confirmation.reason,
        leaderPortfolio,
        confirmation.sizeMultiplier,
      );

      // Step 3: Track consecutive vetoes (alert threshold).
      // Only count rank-1 vetoes — watcher corroboration failures are expected, not anomalies.
      this.vetoedTodayCount += confirmation.decision === 'vetoed' ? 1 : 0;
      const isRank1Veto = confirmation.decision === 'vetoed' && (!trade.rank || trade.rank === 1);
      if (isRank1Veto) {
        this.consecutiveVetoes++;
        if (this.consecutiveVetoes >= 3) {
          logger.warn(`WARNING: ${this.consecutiveVetoes} consecutive rank-1 vetoes — check confirmation layer`);
        }
      } else if (confirmation.decision !== 'vetoed') {
        this.consecutiveVetoes = 0;
      }

      // Step 4: Write-through — persist to Supabase FIRST, then confirm in memory
      if (result.copyTrade && this.config.supabase.url && result.success) {
        const dbId = await db.insertCopyTrade(result.copyTrade);
        if (dbId) {
          // Always assign DB id back to in-memory trade (fixes Gap 2)
          result.copyTrade.id = dbId;
          // Also update the executor's in-memory map with the correct id
          const inMemory = this.copyExecutor.getTradeByMarket(trade.marketId);
          if (inMemory) inMemory.id = dbId;
          logger.info(`Supabase: copy trade saved ${dbId}`);
        } else {
          // Supabase insert failed — remove from memory to stay in sync
          logger.warn(`Supabase insert failed — rolling back in-memory trade for ${trade.marketId.slice(0, 20)}`);
          this.copyExecutor.rollbackTrade(trade.marketId);
        }

        // Update leader tenure stats
        if (confirmation.decision === 'approved' && result.success && this.currentLeader) {
          await db.incrementLeaderTrades(this.currentLeader.walletAddress, 0);
        }
      }

      if (result.success) {
        const size = result.copyTrade?.ourSize?.toFixed(2) ?? '?';
        const market = trade.marketQuestion?.slice(0, 50) ?? trade.marketId;
        logger.info(`COPY TRADE EXECUTED: $${size} on "${market}"`);
        sendTelegramAlert(`🟢 <b>TRADE EXECUTED</b>\n💰 $${size} on "${market}"\n📊 Side: ${trade.side?.toUpperCase()} ${trade.outcome ?? ''}`);
      } else {
        logger.info(`Trade not copied: ${result.reason}`);
      }

    } catch (err) {
      logger.error(`handleLeaderTrade error: ${err}`);
    } finally {
      this.pendingTrades.delete(tradeKey);
    }
  }

  private handleDayRollover(): void {
    const perf = this.paperEngine.handleDayRollover();
    if (perf && this.config.supabase.url) {
      perf.tradesVetoed = this.vetoedTodayCount;
      perf.leaderWallet = this.currentLeader?.walletAddress;
      perf.leaderName = this.currentLeader?.displayName;
      this.vetoedTodayCount = 0;

      db.upsertDailyPerformance(perf).catch(err =>
        logger.error(`Failed to save daily performance: ${err}`)
      );
    }
  }

  /**
   * Reconciliation: every 5 minutes, sync in-memory state with Supabase.
   * Fixes any drift caused by failed writes, restarts, or race conditions.
   */
  private async reconcileWithSupabase(): Promise<void> {
    try {
      const supabaseOpen = await db.getOpenCopyTrades();
      const memoryTrades = this.copyExecutor.getOpenTrades();

      const supabaseIds = new Set(supabaseOpen.map(t => t.marketId));
      const memoryIds = new Set(memoryTrades.map(t => t.marketId));

      let orphansClosed = 0;
      let missingAdded = 0;

      // Gap A: Supabase has "open" trades that memory doesn't know about → close as orphaned
      for (const sbTrade of supabaseOpen) {
        if (!memoryIds.has(sbTrade.marketId) && sbTrade.id) {
          await db.updateCopyTrade(sbTrade.id, {
            status: 'stopped' as any,
            exitTime: new Date().toISOString(),
          });
          orphansClosed++;
        }
      }

      // Gap B: Memory has trades that Supabase doesn't → insert them
      for (const memTrade of memoryTrades) {
        if (!supabaseIds.has(memTrade.marketId) && memTrade.status === 'open') {
          const dbId = await db.insertCopyTrade(memTrade);
          if (dbId) {
            memTrade.id = dbId;
            missingAdded++;
          }
        }
      }

      if (orphansClosed > 0 || missingAdded > 0) {
        logger.info(`Reconciliation: closed ${orphansClosed} orphans, added ${missingAdded} missing trades`);
        if (orphansClosed > 3) {
          sendTelegramAlert(`⚠️ Reconciliation: closed ${orphansClosed} orphaned positions in Supabase`);
        }
      }
    } catch (err) {
      logger.warn(`Reconciliation failed: ${err}`);
    }
  }

  private logStatus(): void {
    if (!this.running) return;

    const paperStats = this.paperEngine.getStats();
    const confirmStats = this.confirmationLayer.getStats();
    const copyStats = this.copyExecutor.getStats();
    const walletStats = this.walletMonitor.getStats();
    const selectorStats = this.selector.getStats();

    // Write authoritative bot stats to a local file. The dashboard reads this
    // as the single source of truth for balance (replaces the broken Supabase
    // balance_usdc approach — that column doesn't exist in the schema).
    try {
      writeFileSync(resolve(_runnerDir, '../../.bot-status.json'), JSON.stringify({
        balance: paperStats.balance,
        totalReturn: paperStats.totalReturn,
        openPositions: paperStats.openTrades,
        closedTrades: paperStats.totalTrades,
        winRate: paperStats.totalTrades > 0 ? paperStats.winRate : null,
        pnl: paperStats.totalPnl,
        updatedAt: new Date().toISOString(),
      }));
    } catch { /* non-fatal */ }

    logger.info('=== PATS-Copy STATUS ===', {
      leader: `${selectorStats.currentLeader?.slice(0, 10) ?? 'none'} (score: ${selectorStats.currentScore?.toFixed(1) ?? '-'})`,
      rotations: selectorStats.totalRotations,
      balance: `$${paperStats.balance.toFixed(2)}`,
      totalReturn: `${paperStats.totalReturn.toFixed(2)}%`,
      openPositions: paperStats.openTrades,
      closedTrades: paperStats.totalTrades,
      winRate: paperStats.totalTrades > 0 ? `${paperStats.winRate.toFixed(1)}%` : 'n/a',
      pnl: `$${paperStats.totalPnl.toFixed(2)}`,
      executions: copyStats.executed,
      vetoes: confirmStats.vetoed,
      consecutiveVetoes: this.consecutiveVetoes,
      aiCost: `$${confirmStats.aiStats.estimatedCost.toFixed(3)}`,
      walletPolls: walletStats.pollCount,
      signalTrades: this.signalExecutor.getStats().executed,
      signalOpen: this.signalExecutor.getStats().openPositions,
      marketsCached: this.marketCache.getStats().totalMarkets,
      signalsGenerated: this.signalGenerator.getStats().signalsGenerated,
    });
  }
}
