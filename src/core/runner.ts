import { logger } from '../utils/logger.js';
import { loadConfig } from './config.js';
import { RiskDial } from './config.js';
import { RiskManager } from './risk-manager.js';
import { PaperTradingEngine } from './paper-trading.js';
import { LeaderboardScraper } from '../leaderboard/scraper.js';
import { TraderScorer } from '../leaderboard/scorer.js';
import { LeaderSelector } from '../leaderboard/selector.js';
import { WalletMonitor } from '../monitor/wallet-monitor.js';
import { ConfirmationLayer } from '../confirmation/confirmation-layer.js';
import { CopyExecutor } from '../execution/copy-executor.js';
import { GlintScraper } from '../signals/glint-scraper.js';
import { GlintAdapter } from '../signals/glint-adapter.js';
import { NewsScanner } from '../signals/news-scanner.js';
import * as db from '../data/supabase.js';
import type { Leader, LeaderTrade } from '../types/index.js';

export class Runner {
  private config = loadConfig();
  private running = false;
  private statusTimer: ReturnType<typeof setInterval> | null = null;
  private dayRolloverTimer: ReturnType<typeof setInterval> | null = null;

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
  private glintScraper: GlintScraper | null = null;
  private glintAdapter: GlintAdapter;
  private newsScanner: NewsScanner;

  // Execution
  private confirmationLayer: ConfirmationLayer;
  private copyExecutor: CopyExecutor;

  // State
  private currentLeader: Leader | null = null;
  private vetoedTodayCount = 0;
  private consecutiveVetoes = 0;
  private pendingTrades: Map<string, LeaderTrade> = new Map(); // tradeId → trade being processed

  constructor() {
    const cfg = this.config;

    this.riskDial = new RiskDial(cfg.risk.level);
    this.riskManager = new RiskManager(this.riskDial, cfg.totalCapitalUsdc);
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

    this.glintAdapter = new GlintAdapter();
    this.newsScanner = new NewsScanner();

    this.confirmationLayer = new ConfirmationLayer(
      cfg.apiKeys.anthropic,
      this.glintAdapter,
    );

    this.copyExecutor = new CopyExecutor({
      paperEngine: this.paperEngine,
      riskManager: this.riskManager,
      paperMode: cfg.paperMode,
      ourPortfolio: cfg.totalCapitalUsdc,
      riskLevel: cfg.risk.level,
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

    logger.info('PATS-Copy fully started. Waiting for leaderboard data...');
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.statusTimer) { clearInterval(this.statusTimer); this.statusTimer = null; }
    if (this.dayRolloverTimer) { clearInterval(this.dayRolloverTimer); this.dayRolloverTimer = null; }

    this.scraper.stop();
    this.walletMonitor.stop();
    this.newsScanner.stop();
    if (this.glintScraper) await this.glintScraper.stop();

    logger.info('PATS-Copy stopped');
  }

  private setupSignals(): void {
    // News scanner
    this.newsScanner.on('news', (item) => {
      // Feed news headlines into glint adapter for confirmation layer queries
      this.glintAdapter.onSignal({
        headline: item.headline,
        impact: 'medium',
        category: 'news',
        matchedMarkets: [],
        source: item.metadata?.feedSource as string || 'rss',
        sourceTier: 3,
        timestamp: Date.now(),
      });
    });
    this.newsScanner.start();

    // Glint scraper (optional)
    if (this.config.glint.enabled) {
      this.glintScraper = new GlintScraper({
        headless: this.config.glint.headless,
      });

      this.glintScraper.on('signal', (event) => {
        this.glintAdapter.onSignal(event);
      });

      this.glintScraper.on('whale', (event) => {
        // Check if this whale is any tracked watcher (rank 1-5)
        const watcherMap = this.walletMonitor.getWatchers();
        const watcherAddresses = Array.from(watcherMap.keys());
        if (watcherAddresses.length > 0) {
          const match = this.glintAdapter.checkForLeaderWhale(event, watcherAddresses);
          if (match) {
            const rank = watcherMap.get(match.walletAddress) ?? 1;
            logger.info(`INSTANT RANK-${rank} WHALE DETECTED via Glint: ${match.marketQuestion.slice(0, 50)}`);
            const leaderTrade: LeaderTrade = {
              leaderWallet: match.walletAddress,
              marketId: match.marketSlug,
              marketQuestion: match.marketQuestion,
              tokenId: '',
              outcome: match.side === 'buy' ? 'Yes' : 'No',
              side: match.side,
              entryPrice: 0.5,
              size: match.size,
              timestamp: new Date(match.timestamp).toISOString(),
              rank,
            };
            this.handleLeaderTrade(leaderTrade);
          }
        }
      });

      this.glintScraper.on('connected', () => logger.info('Glint: Connected'));
      this.glintScraper.on('disconnected', (data) => logger.warn(`Glint: Disconnected (${data.reason})`));

      this.glintScraper.start().catch(err => logger.error(`Glint start failed: ${err}`));
    }
  }

  private setupWalletMonitor(): void {
    this.walletMonitor.on('new-trade', (trade: LeaderTrade) => {
      this.handleLeaderTrade(trade);
    });

    this.walletMonitor.on('leader-closed', (data: { marketId: string; marketQuestion: string; leaderWallet: string }) => {
      logger.info(`Leader closed position on "${data.marketQuestion.slice(0, 50)}"`);
      // Close our copy if we have one, then persist PNL to Supabase
      this.copyExecutor.closePosition(data.marketId, 0.5, 'leader_closed').then(closedTrade => {
        if (!closedTrade) return;
        const pnlStr = closedTrade.pnl !== undefined ? `$${closedTrade.pnl.toFixed(2)}` : 'n/a';
        logger.info(`Closed our copy position for ${data.marketId.slice(0, 12)}... pnl=${pnlStr}`);
        if (closedTrade.id && this.config.supabase.url) {
          db.updateCopyTrade(closedTrade.id, {
            status: 'closed',
            pnl: closedTrade.pnl,
            exitTime: closedTrade.exitTime,
          }).catch(err => logger.warn(`Supabase: failed to update closed trade pnl: ${err}`));
        }
      });
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

    // Await upsert before selector.update() so setCurrentLeader finds rows in DB
    if (this.config.supabase.url) {
      await db.upsertLeaders(rescored).catch(err => logger.warn(`Supabase leader update failed: ${err}`));
    }

    const newLeader = this.selector.update(rescored);
    if (newLeader && newLeader.walletAddress !== this.currentLeader?.walletAddress) {
      this.currentLeader = newLeader;
    }

    // Update the watcher pool: top 5 traders (rank 1 = leader, 2-5 = watchers)
    const top5 = this.selector.getTopN(5);
    if (top5.length > 0) {
      this.walletMonitor.setWatchers(
        top5.map((leader, i) => ({ walletAddress: leader.walletAddress, rank: i + 1 }))
      );
    }

    const watcherSummary = top5.map((l, i) => `${l.walletAddress.slice(0, 8)}(r${i + 1})`).join(', ');
    logger.info(`Leaderboard update: ${rescored.length} traders scored. Watching top ${top5.length}: ${watcherSummary}`);
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
      const confirmation = await this.confirmationLayer.confirm(trade);

      // Step 2: Execute (or log veto)
      const leaderPortfolio = this.currentLeader?.totalPnl30d
        ? this.config.totalCapitalUsdc * 2 // Rough estimate: leader manages more capital
        : this.config.totalCapitalUsdc;

      const result = await this.copyExecutor.execute(
        trade,
        confirmation.decision,
        confirmation.reason,
        leaderPortfolio,
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

      // Step 4: Persist to Supabase — skip 'skipped' decisions (age/stale noise)
      if (result.copyTrade && this.config.supabase.url && confirmation.decision !== 'skipped') {
        const dbId = await db.insertCopyTrade(result.copyTrade);
        if (dbId) {
          if (result.copyTrade.id) result.copyTrade.id = dbId;
          logger.info(`Supabase: copy trade saved ${dbId}`);
        }

        // Update leader tenure stats
        if (confirmation.decision === 'approved' && result.success && this.currentLeader) {
          await db.incrementLeaderTrades(this.currentLeader.walletAddress, 0);
        }
      }

      if (result.success) {
        logger.info(`COPY TRADE EXECUTED: $${result.copyTrade?.ourSize?.toFixed(2)} on "${trade.marketQuestion.slice(0, 40)}"`);
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

  private logStatus(): void {
    if (!this.running) return;

    const paperStats = this.paperEngine.getStats();
    const confirmStats = this.confirmationLayer.getStats();
    const copyStats = this.copyExecutor.getStats();
    const walletStats = this.walletMonitor.getStats();
    const selectorStats = this.selector.getStats();
    const glintStats = this.glintScraper?.getStats();

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
      glint: glintStats ? `${glintStats.connected ? 'OK' : 'DOWN'} ${glintStats.signalCount}sig/${glintStats.whaleCount}whale` : 'disabled',
    });
  }
}
