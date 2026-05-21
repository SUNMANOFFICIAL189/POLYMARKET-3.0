import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../utils/logger.js';
import { sendTelegramAlert } from '../utils/telegram.js';
import { loadConfig } from './config.js';
import { RiskDial } from './config.js';
import { RiskManager, BreakerStateChange } from './risk-manager.js';

const _runnerDir = dirname(fileURLToPath(import.meta.url));
const PEAK_BALANCE_FILE = resolve(_runnerDir, '../../.peak-balance.json');
import { PaperTradingEngine } from './paper-trading.js';
import { LeaderboardScraper } from '../leaderboard/scraper.js';
import { TraderScorer } from '../leaderboard/scorer.js';
import { LeaderSelector } from '../leaderboard/selector.js';
import { WalletMonitor } from '../monitor/wallet-monitor.js';
import { PolygonBlockListener } from '../monitor/polygon-block-listener.js';
import { DivergenceLogger } from '../monitor/divergence-logger.js';
import type { ParsedTrade } from '../monitor/match-orders-decoder.js';
import { ConfirmationLayer } from '../confirmation/confirmation-layer.js';
import { CopyExecutor } from '../execution/copy-executor.js';
import { SignalExecutor } from '../execution/signal-executor.js';
import { GeopoliticsExecutor } from '../execution/geopolitics-executor.js';
import { TIER_1, TIER_1_ADDRESSES } from '../geopolitics/watchlist.js';
import { NewsScanner } from '../signals/news-scanner.js';
import { MarketCache } from '../signals/market-cache.js';
import { SignalGenerator } from '../signals/signal-generator.js';
import { MarketMovementScanner } from '../signals/market-movement-scanner.js';
import { StrategyCScanner } from '../signals/strategy-c-scanner.js';
import { WalletScreener, type WalletScreenReport } from '../screener/wallet-rotation.js';
import { AIClassifier } from '../signals/ai-classifier.js';
import * as db from '../data/supabase.js';
import { PositionLifecycleManager } from './position-lifecycle.js';
import { ALL_PIPELINES, type Leader, type LeaderTrade, type PipelineId } from '../types/index.js';
import type { TradingSignal } from '../signals/signal-generator.js';

const GAMMA_API_BASE = 'https://gamma-api.polymarket.com';

// Hydration-time helper: copy_trades has no endDate column, but lifecycle's
// dynamic TTL needs it — without it, TTL falls back to 24h and the next sweep
// flushes hydrated positions.
async function fetchEndDateBySlug(slug: string): Promise<string | null> {
  try {
    const res = await fetch(`${GAMMA_API_BASE}/markets?slug=${encodeURIComponent(slug)}`, {
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    const markets = (await res.json()) as Array<{ endDate?: string | null }>;
    return markets[0]?.endDate ?? null;
  } catch {
    return null;
  }
}

export class Runner {
  private config = loadConfig();
  private running = false;
  private statusTimer: ReturnType<typeof setInterval> | null = null;
  private dayRolloverTimer: ReturnType<typeof setInterval> | null = null;
  private reconciliationTimer: ReturnType<typeof setInterval> | null = null;
  private breakerDailySummaryTimer: ReturnType<typeof setInterval> | null = null;

  // Core modules
  private riskDial: RiskDial;
  /**
   * Per-pipeline RiskManagers (Option D, 2026-05-10). Each pipeline holds its
   * own balance / peakBalance / drawdown / position cap independently. A bad
   * day on one pipeline cannot reduce another pipeline's risk gates.
   * Keyed by PipelineId. PaperTradingEngine has its own 'global' RM separately.
   */
  private riskManagers: Map<PipelineId, RiskManager> = new Map();
  private paperEngine: PaperTradingEngine;

  // Leaderboard
  private scraper: LeaderboardScraper;
  private scorer: TraderScorer;
  private selector: LeaderSelector;

  // Monitoring
  private walletMonitor: WalletMonitor;
  // Branch 2 shadow infrastructure (gated by BLOCK_LISTENER_ENABLED env flag).
  // When disabled (default), these stay null and have zero effect on the bot.
  private blockListener: PolygonBlockListener | null = null;
  private divergenceLogger: DivergenceLogger | null = null;

  // Signals
  private newsScanner: NewsScanner;
  private _bootTime = Date.now();
  private _newsBuffer: Array<{headline: string; source: string; timestamp: number}> = [];

  // Hybrid strategy (Phase 2)
  private marketCache: MarketCache;
  private signalGenerator: SignalGenerator;
  private signalExecutor: SignalExecutor;
  private movementScanner: MarketMovementScanner;
  private strategyCScanner: StrategyCScanner;
  private walletScreener: WalletScreener;

  // Execution
  private confirmationLayer: ConfirmationLayer;
  private copyExecutor: CopyExecutor;
  private geopoliticsExecutor: GeopoliticsExecutor;
  // Branch 3: dedicated wallet monitor for the static geopolitics specialist
  // watchlist (not driven by the leaderboard scraper). Always instantiated
  // for type-stability; only started if cfg.pipelines.geopolitics.enabled.
  private geopoliticsMonitor: WalletMonitor;
  private lifecycleManager: PositionLifecycleManager;

  // State
  private currentLeader: Leader | null = null;
  private vetoedTodayCount = 0;
  private consecutiveVetoes = 0;
  /**
   * Max-loss monitor TG-alert cooldown: tradeId → last-alert-timestamp.
   * Without this, a position over-cap fires a Telegram alert on every
   * 5-min status pump, spamming until it resolves. Cooldown ensures one
   * alert per position per MAX_LOSS_MONITOR_COOLDOWN_H (default 6h).
   * Console logs still fire on every check. Phase 1.2.1, 2026-05-17.
   */
  private maxLossAlertCooldown: Map<string, number> = new Map();
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

    // Build a RiskManager per pipeline (Option D, 2026-05-10). Each pipeline
    // gets its own isolated balance + drawdown tracking. The signal pipeline
    // is the only one with peakBalance persistence today, since copy + geo
    // are disabled (capital=0 by default — see DEFAULT_PIPELINE_SHARE in
    // config.ts).
    //
    // Phase 1.4 (2026-05-21): every non-global RiskManager now exposes a
    // breaker-state callback so trip/release transitions fire a TG alert.
    // This closes the observability gap that hid 100+ silently-blocked Car
    // trades for 3 days post-2026-05-18 breaker trip.
    const onBreakerStateChange = (change: BreakerStateChange) => {
      this.handleBreakerStateChange(change).catch((err) =>
        logger.error(`handleBreakerStateChange error: ${err}`),
      );
    };
    for (const id of ALL_PIPELINES) {
      const pcfg = cfg.pipelines[id];
      const dial = new RiskDial(pcfg.riskLevel);
      const isSignal = id === 'signal';
      const opts: ConstructorParameters<typeof RiskManager>[3] = {
        onBreakerStateChange,
      };
      if (isSignal) {
        opts.restoredPeakBalance = restoredPeak;
        opts.onPeakBalanceChange = (peak) => {
          try { writeFileSync(PEAK_BALANCE_FILE, JSON.stringify({ peakBalance: peak, updatedAt: new Date().toISOString() })); }
          catch { /* non-fatal */ }
        };
      }
      const rm = new RiskManager(id, dial, pcfg.capital, opts);
      this.riskManagers.set(id, rm);
    }

    // Phase 1.4 (2026-05-21): one-shot peakBalance reset for geopolitics.
    // The early-soak balthazar losses tripped the 14% drawdown breaker which
    // then silently blocked Car's ~100+ valid trade signals for 3 days. We
    // demoted balthazar/MRF/unknown-near-miss to Tier-2 (watchlist.ts edit)
    // and need to re-arm the breaker for Car's solo-Tier-1 experiment.
    //
    // Set GEOPOLITICS_RESET_PEAK_ON_BOOT=true to trigger ONCE at next boot;
    // unset it from pm2 env after deploy so a future restart doesn't reset.
    if (process.env.GEOPOLITICS_RESET_PEAK_ON_BOOT === 'true') {
      const geoRm = this.riskManagers.get('geopolitics');
      if (geoRm) {
        geoRm.resetPeakBalance(cfg.pipelines.geopolitics.capital);
        logger.info('Phase 1.4: GEOPOLITICS_RESET_PEAK_ON_BOOT consumed — unset env to avoid re-reset on future restarts');
      }
    }
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

    // Branch 2: Polygon block listener (shadow mode, no trade-driving).
    // Default OFF — flip BLOCK_LISTENER_ENABLED=true once the 24-48h shadow window starts.
    if (process.env.BLOCK_LISTENER_ENABLED === 'true') {
      this.blockListener = new PolygonBlockListener();
      this.divergenceLogger = new DivergenceLogger();
      logger.info('Branch 2 shadow listener: ENABLED (events log only, no trades driven)');
    }

    this.newsScanner = new NewsScanner();

    this.confirmationLayer = new ConfirmationLayer();

    // Per-pipeline executor wiring (Option D): each executor gets its OWN
    // RiskManager from this.riskManagers, isolating capital and risk gates.
    this.copyExecutor = new CopyExecutor({
      paperEngine: this.paperEngine,
      riskManager: this.getRiskManager('copy'),
      paperMode: cfg.paperMode,
      ourPortfolio: cfg.pipelines.copy.capital,
      riskLevel: cfg.pipelines.copy.riskLevel,
    });

    // Phase 2 (hybrid): Signal-based original trading components
    this.marketCache = new MarketCache();
    this.signalGenerator = new SignalGenerator({
      marketCache: this.marketCache,
      classifier: new AIClassifier(),
    });
    this.signalExecutor = new SignalExecutor({
      paperEngine: this.paperEngine,
      riskManager: this.getRiskManager('signal'),
      paperMode: cfg.paperMode,
    });

    this.movementScanner = new MarketMovementScanner({ marketCache: this.marketCache });
    // StrategyCScanner — systematic discovery of "fade the near-cert" trades
    // (Phase 0.4, 2026-05-17). Polls MarketCache every 60s for markets
    // matching the Strategy C pattern (YES >= 0.92 within 24h to resolution
    // with sufficient liquidity). Emits TradingSignal events routed through
    // the same SignalExecutor as news + movement signals.
    this.strategyCScanner = new StrategyCScanner({ marketCache: this.marketCache });
    // WalletScreener — weekly defensive screen of Tier-1 wallet performance
    // + external promotion candidates. Read-only by design: emits a report
    // to TG; user manually edits src/geopolitics/watchlist.ts if they agree
    // with a demote/promote recommendation. Phase 1, 2026-05-17.
    this.walletScreener = new WalletScreener();

    // Branch 3 (geopolitics) — wired but disabled by default. Activate via
    // GEOPOLITICS_ENABLED=true. Watches a static Tier-1 list of pre-vetted
    // geopolitics specialists (see src/geopolitics/watchlist.ts). 30s poll
    // cadence (rank=2 in WalletMonitor terms).
    this.geopoliticsExecutor = new GeopoliticsExecutor({
      paperEngine: this.paperEngine,
      riskManager: this.getRiskManager('geopolitics'),
      paperMode: cfg.paperMode,
      capitalPool: cfg.pipelines.geopolitics.capital,
      riskLevel: cfg.pipelines.geopolitics.riskLevel,
    });
    this.geopoliticsMonitor = new WalletMonitor({
      pollIntervalMs: cfg.walletMonitor.pollIntervalMs,
    });

    // Latency-aware paper pricing: paperEngine reads current market price from
    // cache at execution time instead of using leader entry price. Falls back
    // to leader entry on cache miss — preserves prior behavior.
    this.paperEngine.setMarketCache(this.marketCache);

    // Position Lifecycle Manager — auto-closes resolved, stale, and stop-loss positions
    this.lifecycleManager = new PositionLifecycleManager({
      closePosition: async (marketId, exitPrice, reason) => {
        // Try copy executor first, then geopolitics, then signal executor.
        // Each closePosition is async — must be awaited so `if (...)` checks
        // the resolved value, not the Promise (which is always truthy and would mask
        // the fall-through to the next executor, leaving the close unpersisted —
        // root cause of the 2026-05-07 -$943 audit gap).
        const copy = await this.copyExecutor.closePosition(marketId, exitPrice, reason);
        if (copy) return copy;
        const geo = await this.geopoliticsExecutor.closePosition(marketId, exitPrice, reason);
        if (geo) return geo;
        return (await this.signalExecutor.closePosition(marketId, exitPrice, reason)) as any;
      },
      getOpenTrades: () => [
        ...this.copyExecutor.getOpenTrades(),
        ...this.geopoliticsExecutor.getOpenTrades(),
        ...(this.signalExecutor.getOpenTrades() as any[]),
      ],
      persistClose: async (trade) => {
        if (trade.id && cfg.supabase.url) {
          try {
            await db.updateCopyTrade(trade.id, {
              status: 'closed',
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
      maxPositionAgeMs: parseInt(process.env.MAX_POSITION_AGE_HOURS ?? '24') * 3600000,
      // Per-pipeline TTL floor (2026-05-11). Geopolitics needs 7d because
      // balthazar's profit distribution lives in the 24h-7d window (78-position
      // sample: 6-24h bucket is net-negative, 24-48h and 2-7d are 92-96% WR /
      // $63K combined). A 24h floor would cut the strategy off before the edge
      // materialises. Signal stays at 24h (short-dated sentiment).
      getMaxAgeForTrade: (trade: unknown) => {
        const pipeline = (trade as { pipeline?: string; pipelineId?: string }).pipeline
          ?? (trade as { pipeline?: string; pipelineId?: string }).pipelineId;
        if (pipeline === 'geopolitics') {
          return parseInt(process.env.GEOPOLITICS_MAX_AGE_HOURS ?? '168') * 3600000;
        }
        return parseInt(process.env.MAX_POSITION_AGE_HOURS ?? '24') * 3600000;
      },
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
      // Hydrate executor's open positions so close detection persists Supabase updates.
      // Filter OUT signal-bot trades — those are owned by signalExecutor only.
      // Duplicating them in copyExecutor causes lifecycle close paths to misattribute,
      // leaving signalExecutor's recentlyClosedMarkets cooldown unset → duplicate opens
      // within the cooldown window when the next signal arrives on the same market.
      const { data: openRows } = await db.getClient()
        .from('copy_trades')
        .select('*')
        .in('status', ['open', 'pending']);
      if (openRows) {
        // Two-step filter (preserves the c0e44b9 pattern for static analysers):
        //   1. Filter signal-bot trades OUT first — they're owned by
        //      signalExecutor only. Duplicating into copyExecutor causes
        //      lifecycle close misattribution (2026-05-07 -$943 audit gap).
        //   2. Then partition the remainder by pipeline: geopolitics rows go
        //      to geopoliticsExecutor, everything else to copyExecutor.
        // The two-step filter above (nonSignalRows = openRows.filter(!== signal-bot)
        // then copyRows = nonSignalRows.filter(pipeline)) is functionally
        // equivalent to a compound single-filter, but Semgrep can't trace the
        // variable chain across the intermediate assignment. Suppression is
        // explicit: signal-bot trades ARE excluded — see `nonSignalRows` filter above.
        const nonSignalRows = openRows.filter(r => r.leader_wallet !== 'signal-bot');
        const geoRows = nonSignalRows.filter(r => r.pipeline === 'geopolitics');
        const copyRows = nonSignalRows.filter(r => r.pipeline !== 'geopolitics');
        const signalCount = openRows.length - nonSignalRows.length;
        this.copyExecutor.hydrateOpenTrades(copyRows); // nosemgrep: pats-copy-executor-receiving-signal-bot
        this.geopoliticsExecutor.hydrateOpenTrades(geoRows);
        if (geoRows.length > 0 || signalCount > 0) {
          logger.info(`Hydration: ${copyRows.length} copy → copyExecutor, ${geoRows.length} geopolitics → geopoliticsExecutor, ${signalCount} signal-bot → signalExecutor only`);
        }
      }

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

    // Branch 3: Geopolitics specialist monitor — static watchlist, runs only
    // when the geopolitics pipeline is enabled. Watches Tier-1 specialists at
    // 30s cadence (same as copy watchers) and feeds geopoliticsExecutor.
    if (this.config.pipelines.geopolitics.enabled) {
      this.setupGeopoliticsMonitor();
      const watcherList = TIER_1.map(s => ({ walletAddress: s.walletAddress, rank: 2 }));
      this.geopoliticsMonitor.setWatchers(watcherList);
      this.geopoliticsMonitor.start();
      logger.info(`Geopolitics pipeline ENABLED — watching ${TIER_1.length} Tier-1 specialists: ${TIER_1.map(s => s.name).join(', ')}`);
    } else {
      logger.info('Geopolitics pipeline DISABLED — set GEOPOLITICS_ENABLED=true to activate');
    }

    // Branch 2 shadow listener (no-op when flag is off)
    if (this.blockListener && this.divergenceLogger) {
      this.setupBlockListener();
      this.divergenceLogger.start();
      await this.blockListener.start();
    }

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

    // Phase 1.4 (2026-05-21): breaker-still-tripped daily summary. Checks
    // every hour, emits a TG alert per pipeline at most once per 24h window
    // while the breaker remains tripped. Per-call cost is trivial.
    this.breakerDailySummaryTimer = setInterval(() => this.checkBreakerDailySummary(), 60 * 60 * 1000);

    // Hydrate signal trade IDs from Supabase so lifecycle manager knows about them
    if (this.config.supabase.url) {
      try {
        const openSignals = await db.getOpenCopyTrades();
        const signalTrades = openSignals.filter(t => t.leaderWallet === 'signal-bot');
        let endDatesFound = 0;
        for (const t of signalTrades) {
          // Register ID in signal executor
          this.signalExecutor.registerExistingPosition(t.marketId);
          const endDate = await fetchEndDateBySlug(t.marketId);
          if (endDate) endDatesFound++;
          // Inject into paper engine so lifecycle manager can check TTL/stop-loss
          this.paperEngine.injectOpenTrade({
            id: t.id,
            marketId: t.marketId,
            question: t.marketQuestion,
            entryPrice: t.ourEntryPrice ?? t.entryPrice ?? 0.5,
            usdcAmount: t.ourSize,
            entryTime: t.entryTime,
            outcome: t.outcome,
            side: t.side,
            endDate: endDate ?? undefined,
            pipelineId: 'signal',  // this hydration loop is scoped to signalTrades (leader_wallet === 'signal-bot')
          });
        }
        if (signalTrades.length > 0) {
          logger.info(`Hydrated ${signalTrades.length} signal position(s) from Supabase — endDate resolved for ${endDatesFound}/${signalTrades.length} via Gamma`);
        }
      } catch (err) {
        logger.warn(`Signal hydration failed: ${err}`);
      }
    }

    logger.info('PATS-Copy fully started. Waiting for leaderboard data...');
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.statusTimer) { clearInterval(this.statusTimer); this.statusTimer = null; }
    if (this.dayRolloverTimer) { clearInterval(this.dayRolloverTimer); this.dayRolloverTimer = null; }
    if (this.reconciliationTimer) { clearInterval(this.reconciliationTimer); this.reconciliationTimer = null; }
    if (this.breakerDailySummaryTimer) { clearInterval(this.breakerDailySummaryTimer); this.breakerDailySummaryTimer = null; }

    this.scraper.stop();
    this.walletMonitor.stop();
    this.geopoliticsMonitor.stop();
    this.newsScanner.stop();
    this.marketCache.stop();
    this.movementScanner.stop();
    this.strategyCScanner.stop();
    this.walletScreener.stop();
    if (this.blockListener) await this.blockListener.stop();
    if (this.divergenceLogger) this.divergenceLogger.stop();

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
        logger.warn(`SignalGenerator: news processing failed: ${err}`)
      );
    });

    // Start market cache (polls Gamma API for active non-sports markets)
    this.marketCache.start();
    this.movementScanner.start();
    this.strategyCScanner.start();
    this.walletScreener.start();

    // WalletScreener report → format and send Telegram alert. Read-only —
    // bot does NOT auto-modify watchlist. Phase 1, 2026-05-17.
    this.walletScreener.on('report', (report: WalletScreenReport) => {
      this.handleWalletScreenReport(report);
    });

    // Wire StrategyC scanner signals (Phase 0.4, 2026-05-17). Same path as
    // news + movement signals: route through SignalExecutor's filter chain
    // and persist on success. TG fires only AFTER executor accepts (Option 1
    // semantics from 2026-05-12 fix — no false-positive scanner alerts).
    this.strategyCScanner.on('signal', async (signal: TradingSignal) => {
      logger.info(
        'SCANNER SIGNAL: ' + signal.side.toUpperCase() +
        ' on "' + signal.market.question.slice(0, 50) + '" (' +
        (signal.confidence * 100).toFixed(0) + '% confidence)',
      );
      const result = await this.signalExecutor.execute(signal);
      if (result.success && result.trade) {
        if (this.config.supabase.url) {
          try {
            const dbId = await db.insertCopyTrade({
              pipeline: 'signal',
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
              confirmationReason: signal.reasoning.slice(0, 200),
              status: 'open' as any,
              riskLevel: 'paper' as any,
              entryTime: new Date().toISOString(),
            });
            if (dbId) { result.trade.id = dbId; logger.info('Supabase: strategy-c scanner trade saved ' + dbId); }
          } catch (err) { logger.warn('Supabase: strategy-c scanner insert failed: ' + err); }
        }
        logger.info(
          'SCANNER TRADE EXECUTED: $' + (result.trade.usdcAmount?.toFixed(2) ?? '?') +
          ' on "' + signal.market.question.slice(0, 40) + '"',
        );
        sendTelegramAlert(
          '🎯 <b>SCANNER TRADE EXECUTED</b>\n' +
          '📊 ' + signal.side.toUpperCase() + ' "' + signal.market.question.slice(0, 50) + '"\n' +
          '💪 ' + (signal.confidence * 100).toFixed(0) + '% confidence\n' +
          '💵 $' + (result.trade.usdcAmount?.toFixed(2) ?? '?') + ' deployed @ ' + (result.trade.entryPrice?.toFixed(4) ?? '?') + '\n' +
          '🔍 Strategy C scanner',
        );
      } else {
        logger.info('Scanner trade not executed: ' + result.reason);
      }
    });

    // Wire movement scanner signals to the same handler as news signals
    this.movementScanner.on('signal', async (signal: TradingSignal) => {
      logger.info('MOVEMENT SIGNAL: ' + signal.side.toUpperCase() + ' on "' + signal.market.question.slice(0, 50) + '" (' + (signal.confidence * 100).toFixed(0) + '% confidence)');
      sendTelegramAlert(
        '<b>MOVEMENT SIGNAL</b>\n' +
        signal.side.toUpperCase() + ' "' + signal.market.question.slice(0, 50) + '"\n' +
        (signal.confidence * 100).toFixed(0) + '% confidence\n' +
        signal.reasoning.slice(0, 80)
      );
      const result = await this.signalExecutor.execute(signal);
      if (result.success && result.trade) {
        if (this.config.supabase.url) {
          try {
            const dbId = await db.insertCopyTrade({
              pipeline: 'signal',  // movement scanner feeds signal pipeline
              leaderWallet: 'signal-bot',
              marketId: signal.market.slug,
              marketQuestion: signal.market.question,
              tokenId: signal.market.conditionId,
              outcome: signal.market.outcomes[0] ?? 'Yes',
              side: signal.side,
              leaderEntryPrice: result.trade.entryPrice,
              ourEntryPrice: result.trade.entryPrice,
              ourSize: result.trade.usdcAmount,
              confirmationResult: 'approved',
              confirmationReason: signal.reasoning.slice(0, 200),
              status: 'open',
              riskLevel: 'paper',
              entryTime: new Date().toISOString(),
            });
            if (dbId) { result.trade.id = dbId; logger.info('Supabase: movement signal trade saved ' + dbId); }
          } catch (err) { logger.warn('Supabase: movement signal insert failed: ' + err); }
        }
      }
    });

    // Handle signals from the signal generator.
    //
    // Telegram notification semantics (Option 1 fix, 2026-05-12): the alert
    // fires only AFTER the executor accepts. Previously fired on every AI
    // "yes" — but with current filters (BUY disabled + 24h SELL cap) almost
    // nothing reached execution, and the user saw "SIGNAL TRADE 95%" pings
    // for trades that never happened. See vault Decision Log 2026-05-12.
    this.signalGenerator.on('signal', async (signal: TradingSignal) => {
      logger.info(`SIGNAL RECEIVED: ${signal.side.toUpperCase()} on "${signal.market.question.slice(0, 50)}" (${(signal.confidence * 100).toFixed(0)}% confidence) — ${signal.reasoning}`);

      const result = await this.signalExecutor.execute(signal);
      if (result.success && result.trade) {
        if (this.config.supabase.url) {
          try {
            const dbId = await db.insertCopyTrade({
              pipeline: 'signal',  // signal generator → signal pipeline
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
            });
            if (dbId) { result.trade.id = dbId; logger.info(`Supabase: signal trade saved ${dbId}`); }
          } catch (err) { logger.warn(`Supabase: signal trade insert failed: ${err}`); }
        }
        logger.info(`SIGNAL TRADE EXECUTED: $${result.trade.usdcAmount?.toFixed(2) ?? '?'} on "${signal.market.question.slice(0, 40)}"`);
        sendTelegramAlert(
          `🎯 <b>SIGNAL TRADE EXECUTED</b>\n` +
          `📊 ${signal.side.toUpperCase()} "${signal.market.question.slice(0, 50)}"\n` +
          `💪 ${(signal.confidence * 100).toFixed(0)}% confidence\n` +
          `💵 $${result.trade.usdcAmount?.toFixed(2) ?? '?'} deployed @ ${result.trade.entryPrice?.toFixed(4) ?? '?'}\n` +
          `📰 ${signal.newsHeadline.slice(0, 60)}`
        );
      } else {
        logger.info(`Signal trade not executed: ${result.reason}`);
      }
    });
  }

  private setupWalletMonitor(): void {
    this.walletMonitor.on('new-trade', (trade: LeaderTrade) => {
      // Branch 2 shadow: forward every REST-detected trade to the divergence logger
      // for parity-checking against WS-detected trades. No-op when listener disabled.
      this.divergenceLogger?.recordRest(trade);

      // Phase 3: Copy pipeline disabled. 428 trades at -$0.78 avg = -$332 dead weight.
      // Signal pipeline is profitable (+$287). No value in copying leaders.
      // Leaderboard scraper + wallet monitor still run for data/scoring.
      if (process.env.ENABLE_COPY_TRADES === 'true') {
        this.handleLeaderTrade(trade);
      }
    });

    // Note: setupBlockListener() handles the WS-side wiring. See below.

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

  /**
   * Branch 3: wire the geopolitics-specialist trade flow. Each new trade from a
   * Tier-1 specialist goes through the geopoliticsExecutor (BUY-only, politics-
   * only, flat sizing). Close events route to geopoliticsExecutor.closePosition.
   */
  private setupGeopoliticsMonitor(): void {
    this.geopoliticsMonitor.on('new-trade', (trade: LeaderTrade) => {
      this.handleGeopoliticsTrade(trade).catch(err =>
        logger.error(`handleGeopoliticsTrade error: ${err}`),
      );
    });

    this.geopoliticsMonitor.on('leader-closed', async (data: { marketId: string; marketQuestion: string; leaderWallet: string; exitPrice?: number }) => {
      const exitPrice = typeof data.exitPrice === 'number' && data.exitPrice > 0 ? data.exitPrice : 0.5;
      const closed = await this.geopoliticsExecutor.closePosition(data.marketId, exitPrice, 'leader_closed');
      if (!closed) return;
      const pnlStr = closed.pnl !== undefined ? `$${closed.pnl.toFixed(2)}` : 'n/a';
      logger.info(`GeopoliticsExecutor: specialist closed → our position closed pnl=${pnlStr}`);
      if (closed.id && this.config.supabase.url) {
        try {
          await db.updateCopyTrade(closed.id, { status: 'closed', pnl: closed.pnl, exitTime: closed.exitTime });
        } catch (err) {
          logger.error(`Supabase: failed to persist geopolitics close ${closed.id}: ${err}`);
          sendTelegramAlert(`🔴 SYNC ERROR: Geopolitics close failed for ${data.marketQuestion.slice(0, 30)}`);
        }
      }
    });
  }

  /**
   * Drawdown circuit breaker observability (Phase 1.4, 2026-05-21).
   *
   * Three event types fire:
   *   - TRIP    : breaker goes from armed → tripped. One TG alert.
   *   - RELEASE : breaker goes from tripped → armed (recovery OR manual reset).
   *               One TG alert.
   *   - STILL_TRIPPED daily summary: handled by the 24h timer in start(), not
   *     this method. Reports how many trades were blocked in the last 24h.
   *
   * The trip-counter (blockedSinceLastReport) is tracked here for the daily
   * summary. Reset on RELEASE or after each summary is sent.
   */
  private breakerBlockedSinceLastReport: Map<string, number> = new Map();
  private breakerLastTripTimestamp: Map<string, string> = new Map();

  private async handleBreakerStateChange(change: BreakerStateChange): Promise<void> {
    const pid = change.pipelineId;
    if (change.transition === 'trip') {
      this.breakerLastTripTimestamp.set(pid, new Date().toISOString());
      this.breakerBlockedSinceLastReport.set(pid, 0);
      logger.warn(`Breaker TRIPPED [${pid}] DD=${(change.drawdownPct * 100).toFixed(1)}% > ${(change.limitPct * 100).toFixed(0)}% peak=$${change.peakBalance.toFixed(2)} bal=$${change.currentBalance.toFixed(2)}`);
      sendTelegramAlert(
        `🚨 <b>DRAWDOWN BREAKER TRIPPED</b>\n` +
        `Pipeline: <b>${pid}</b>\n` +
        `Drawdown: <b>${(change.drawdownPct * 100).toFixed(1)}%</b> (limit ${(change.limitPct * 100).toFixed(0)}%)\n` +
        `Peak: $${change.peakBalance.toFixed(2)} → Current: $${change.currentBalance.toFixed(2)}\n` +
        `All new ${pid} trades will be blocked until pool recovers or peak is reset.`,
      );
    } else if (change.transition === 'release') {
      const blocked = this.breakerBlockedSinceLastReport.get(pid) ?? 0;
      const trippedAt = this.breakerLastTripTimestamp.get(pid);
      this.breakerBlockedSinceLastReport.set(pid, 0);
      this.breakerLastTripTimestamp.delete(pid);
      logger.info(`Breaker RELEASED [${pid}] DD=${(change.drawdownPct * 100).toFixed(1)}% peak=$${change.peakBalance.toFixed(2)} bal=$${change.currentBalance.toFixed(2)} (was tripped since ${trippedAt ?? 'unknown'}, blocked ${blocked} trades)`);
      sendTelegramAlert(
        `✅ <b>BREAKER RELEASED</b>\n` +
        `Pipeline: <b>${pid}</b>\n` +
        `Drawdown now ${(change.drawdownPct * 100).toFixed(1)}%, trades resuming.\n` +
        `Blocked while tripped: <b>${blocked}</b> trade(s).`,
      );
    }
  }

  /**
   * Daily-summary check: for every pipeline whose breaker is currently
   * tripped, send one TG alert per 24h with the running block count.
   * Wired to a 24h timer in start(). Idempotent — safe to call multiple times.
   */
  private breakerLastDailyAlert: Map<string, number> = new Map();

  private checkBreakerDailySummary(): void {
    const now = Date.now();
    for (const [id, rm] of this.riskManagers) {
      const state = rm.getBreakerState();
      if (!state.tripped) continue;
      const lastAlerted = this.breakerLastDailyAlert.get(id) ?? 0;
      if (now - lastAlerted < 24 * 60 * 60 * 1000) continue;
      const blocked = this.breakerBlockedSinceLastReport.get(id) ?? 0;
      const trippedAt = this.breakerLastTripTimestamp.get(id) ?? 'unknown';
      logger.warn(`Breaker daily summary [${id}]: still tripped (DD ${(state.drawdownPct * 100).toFixed(1)}%, ${blocked} blocked since last summary, tripped at ${trippedAt})`);
      sendTelegramAlert(
        `⚠️ <b>BREAKER STILL TRIPPED</b>\n` +
        `Pipeline: <b>${id}</b>\n` +
        `Drawdown: ${(state.drawdownPct * 100).toFixed(1)}% (limit ${(state.limitPct * 100).toFixed(0)}%)\n` +
        `Blocked in last 24h: <b>${blocked}</b> trade(s)\n` +
        `Tripped at: ${trippedAt}`,
      );
      this.breakerLastDailyAlert.set(id, now);
      this.breakerBlockedSinceLastReport.set(id, 0);
    }
  }

  /**
   * Process a single specialist trade through the geopolitics executor.
   * No AI confirmation gate — specialists are pre-vetted by the Phase 2 v3
   * screen (2026-05-11 sprint). Executor handles BUY/politics filters internally.
   */
  private async handleGeopoliticsTrade(trade: LeaderTrade): Promise<void> {
    const result = await this.geopoliticsExecutor.execute(trade);
    if (!result.success) {
      // info-level (not debug) so silent rejection regressions are visible
      // in pm2 logs without flipping log level. 2026-05-12 incident: a per-
      // pipeline RM gate was silently rejecting every trade for 4h with no
      // visible reason because this line was at debug level.
      logger.info(`GeopoliticsExecutor: skipped — ${result.reason}`);
      // Phase 1.4 (2026-05-21): count breaker-blocked trades for daily summary
      if (result.reason?.includes('Drawdown circuit breaker')) {
        const cur = this.breakerBlockedSinceLastReport.get('geopolitics') ?? 0;
        this.breakerBlockedSinceLastReport.set('geopolitics', cur + 1);
      }
      return;
    }
    // Write-through to Supabase
    if (result.copyTrade && this.config.supabase.url) {
      const dbId = await db.insertCopyTrade(result.copyTrade);
      if (dbId) {
        result.copyTrade.id = dbId;
        const inMem = this.geopoliticsExecutor.getTradeByMarket(trade.marketId);
        if (inMem) inMem.id = dbId;
        logger.info(`Supabase: geopolitics trade saved ${dbId}`);
      } else {
        logger.warn(`Supabase insert failed — rolling back geopolitics trade for ${trade.marketId.slice(0, 20)}`);
        this.geopoliticsExecutor.rollbackTrade(trade.marketId);
        return;
      }
    }
    const size = result.copyTrade?.ourSize?.toFixed(2) ?? '?';
    const market = trade.marketQuestion.slice(0, 50);
    logger.info(`GEOPOLITICS TRADE EXECUTED: $${size} on "${market}"`);
    sendTelegramAlert(`🌍 <b>GEOPOLITICS TRADE</b>\n💰 $${size} on "${market}"\n👤 ${trade.leaderWallet.slice(0, 10)}`);
  }

  private setupBlockListener(): void {
    if (!this.blockListener || !this.divergenceLogger) return;
    const div = this.divergenceLogger;
    this.blockListener.on('new-trade', (trade: ParsedTrade) => {
      // Shadow ONLY. Never drives execution — only feeds the divergence logger.
      div.recordWs(trade);
    });
    this.blockListener.on('connection', (ev) => {
      logger.info(`PolygonBlockListener connection: ${ev.mode}/${ev.status}${ev.attempt ? ` (attempt ${ev.attempt})` : ''}`);
    });
    this.blockListener.on('error', (err: Error) => {
      logger.warn(`PolygonBlockListener: ${err.message}`);
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
    // Re-assert current leader in Supabase after upsert (prevents is_current_leader drift)
    const currentLeaderAddr = this.selector.getCurrentLeader()?.walletAddress;
    if (currentLeaderAddr && this.config.supabase.url) {
      db.setCurrentLeader(currentLeaderAddr).catch(() => {});
    }
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
      // Branch 2 shadow: keep WS listener's watch set in sync with REST monitor.
      this.blockListener?.setWatchers(watcherList.map((w) => w.walletAddress));
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
      const rollingStats = this.copyExecutor.getLeaderRollingStats(trade.leaderWallet.toLowerCase());
      trade.walletRollingWR = rollingStats.winRate;
      trade.walletRollingCount = rollingStats.sampleSize;

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
      const signalTrades = this.signalExecutor.getOpenTrades();
      const allMemoryTrades = [...memoryTrades, ...(signalTrades as any[])];
      const memoryIds = new Set(allMemoryTrades.map(t => t.marketId));

      let orphansClosed = 0;
      let missingAdded = 0;

      // Gap A: Supabase has "open" trades that memory doesn't know about.
      // The trade was likely closed by lifecycle (removed from memory) but the
      // Supabase write may be pending or failed. Layered fallback for pnl:
      //   1. Read from paperEngine's in-memory closedTrades — most accurate,
      //      this is the value the bot itself logged at close time.
      //   2. Compute from MarketCache if the market is still cached.
      //   3. Mark pnl as unknown (skip the column update so it stays null in
      //      db) and Telegram-alert the user. Honest > guessing zero.
      //
      // Calibrated against the 2026-05-07 -$943 audit gap. Prior code defaulted
      // exitPrice = entryPrice on cache miss, which silently produced pnl=0 —
      // the database lying about a real loss. Layer 1 alone covers ~95% of
      // orphan cases (bot has the close in memory unless it was restarted).
      const memClosed = this.paperEngine.getClosedTrades();
      for (const sbTrade of supabaseOpen) {
        if (!memoryIds.has(sbTrade.marketId) && sbTrade.id) {
          let pnl: number | undefined;
          let pnlSource = 'unknown';

          // Layer 1: bot's in-memory closedTrades (the bot already logged this)
          const memTrade = memClosed.find(t => t.id === sbTrade.id);
          if (memTrade && memTrade.pnl !== undefined) {
            pnl = memTrade.pnl;
            pnlSource = 'memory';
          }

          // Layer 2: market cache lookup (only if memory didn't have it)
          if (pnl === undefined) {
            try {
              const cached = this.marketCache.getMarket(sbTrade.marketId);
              if (cached) {
                const outcomeIdx = cached.outcomes.findIndex(
                  (o: string) => o.toLowerCase() === (sbTrade.outcome ?? 'yes').toLowerCase()
                );
                if (outcomeIdx >= 0 && outcomeIdx < cached.outcomePrices.length) {
                  const exitPrice = cached.outcomePrices[outcomeIdx];
                  const entryPrice = sbTrade.ourEntryPrice ?? sbTrade.entryPrice ?? 0.5;
                  const size = sbTrade.ourSize ?? 20;
                  if (entryPrice > 0) {
                    pnl = sbTrade.side === 'buy'
                      ? (exitPrice - entryPrice) * (size / entryPrice)
                      : (entryPrice - exitPrice) * (size / entryPrice);
                    pnlSource = 'cache';
                  }
                }
              }
            } catch { /* fall through to Layer 3 */ }
          }

          // Layer 3: honest unknown — skip pnl update, alert user
          // Note: passing pnl=undefined makes updateCopyTrade skip the column,
          // so the existing null (from insert) stays null instead of being
          // overwritten with a misleading 0.
          await db.updateCopyTrade(sbTrade.id, {
            status: 'stopped',
            pnl,
            exitTime: new Date().toISOString(),
          });

          if (pnl === undefined) {
            logger.warn(`Reconciliation: orphan ${sbTrade.marketId.slice(0, 30)} stopped with pnl=UNKNOWN — pnl column left null, manual review needed (id=${sbTrade.id.slice(0, 8)})`);
            sendTelegramAlert(`⚠️ Reconciliation could not determine final P&L for one trade — investigate. Open Supabase, find row id starting ${sbTrade.id.slice(0, 8)} on market "${(sbTrade.marketQuestion ?? sbTrade.marketId).slice(0, 50)}", check exit price manually.`);
          } else {
            logger.info(`Reconciliation: orphan ${sbTrade.marketId.slice(0, 20)} stopped with pnl=$${pnl.toFixed(2)} (source: ${pnlSource})`);
          }
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

  /**
   * Format the WalletScreener report and ship to Telegram. Report-only —
   * bot does NOT modify the watchlist. User reviews the recommendation
   * and manually edits src/geopolitics/watchlist.ts if they agree.
   * Phase 1, 2026-05-17.
   */
  private handleWalletScreenReport(report: WalletScreenReport): void {
    const lines: string[] = [];
    lines.push('📊 <b>WALLET SCREEN REPORT</b>');
    lines.push('Generated: ' + report.generatedAt.slice(0, 16).replace('T', ' ') + ' UTC');
    lines.push(`Source: ${report.totalEventsScanned} events → ${report.totalWalletsAggregated} wallets`);
    lines.push('');

    lines.push('<b>Current Tier-1 performance:</b>');
    for (const w of report.tier1) {
      const indicator = w.flag === 'DEMOTE' ? ' ⚠️' : ' ✓';
      const nameStr = w.internalName ?? w.displayName;
      const wins = `wins $${w.totalWinPnl.toFixed(0)} (${w.eventCount} events)`;
      const book = w.positions
        ? `, book: ${w.positions.openPositionCount} open · unrealized $${w.positions.totalUnrealizedPnl.toFixed(0)}`
        : '';
      lines.push(`• ${nameStr} — ${wins}${book}${indicator}`);
    }
    lines.push('');

    if (report.demotionCandidates.length > 0) {
      lines.push('<b>⚠️ Demote candidates (Tier-1 underperforming):</b>');
      for (const w of report.demotionCandidates) {
        const nameStr = w.internalName ?? w.displayName;
        lines.push(`• ${nameStr} — ${w.reason ?? 'below threshold'}`);
      }
      lines.push('');
    }

    if (report.promotionCandidates.length > 0) {
      lines.push('<b>✅ Promote candidates (top external wallets):</b>');
      for (const w of report.promotionCandidates) {
        const shortAddr = w.wallet.slice(0, 10);
        const name = w.displayName !== shortAddr ? `${w.displayName} (${shortAddr}…)` : shortAddr;
        lines.push(`• ${name}: $${w.totalWinPnl.toFixed(0)} on ${w.eventCount} events`);
      }
    } else {
      lines.push('<i>No external wallets met the promote threshold this cycle.</i>');
    }
    lines.push('');
    lines.push('<i>Report-only. Bot will NOT auto-edit the watchlist. Review and edit src/geopolitics/watchlist.ts manually if changes are warranted.</i>');

    const message = lines.join('\n');
    // TG has ~4096 char limit; should be well under but truncate defensively
    const truncated = message.length > 3800 ? message.slice(0, 3700) + '\n…[truncated]' : message;
    sendTelegramAlert(truncated);

    logger.info(
      'WalletScreener report sent to Telegram. ' +
      report.demotionCandidates.length + ' demote, ' +
      report.promotionCandidates.length + ' promote candidate(s).',
    );
  }

  private async logStatus(): Promise<void> {
    if (!this.running) return;

    // Phase 0.3 (2026-05-17): sweep for phantom positions BEFORE collecting
    // stats so the openPositions counter reflects reality, not stale state.
    // Phantoms arise when paperEngine closes a position via a path that
    // bypasses executor.closePosition (e.g., paperEngine.checkStopLosses).
    // Sweep runs every 5 min on the same cadence as the status pump.
    this.geopoliticsExecutor.sweepPhantoms();

    // Phase 1.2 (2026-05-17): continuous max-loss exposure monitor.
    // The per-trade max-loss cap is computed at trade time; if balance drops
    // after open, positions can drift over the (recomputed) cap percentage.
    // External watchdog catches this but only after the fact. This in-bot
    // monitor surfaces violations on the 5-min status cadence so we can
    // either alert (default) or auto-close (env-flagged).
    const maxLossPct = Number(process.env.MAX_LOSS_PCT_PER_TRADE ?? '0.05') || 0.05;
    const violations = this.paperEngine.checkMaxLossExposure(maxLossPct);
    if (violations.length > 0) {
      // Always log each violation (no spam — logs are cheap)
      for (const v of violations) {
        logger.warn(
          'MaxLossMonitor: position ' + v.trade.id.slice(0, 8) +
          ' (' + v.trade.side + ' @' + v.trade.entryPrice.toFixed(4) + ' size $' + v.trade.usdcAmount.toFixed(2) + ')' +
          ' — max-loss $' + v.maxLoss.toFixed(2) + ' is ' + v.pctOfBalance.toFixed(2) + '% of balance ' +
          '(cap $' + v.capDollars.toFixed(2) + ', overage +' + v.overagePct.toFixed(1) + '%) ' +
          '"' + (v.trade.question || v.trade.marketId).slice(0, 50) + '"',
        );
      }
      // Per-position TG-alert cooldown — only alert once per cooldown window
      // per trade. Phase 1.2.1, 2026-05-17.
      const cooldownMs = (parseInt(process.env.MAX_LOSS_MONITOR_COOLDOWN_H ?? '6')) * 60 * 60 * 1000;
      const now = Date.now();
      // Prune expired cooldown entries to keep map bounded
      for (const [tradeId, ts] of this.maxLossAlertCooldown) {
        if (now - ts > cooldownMs) this.maxLossAlertCooldown.delete(tradeId);
      }
      // Auto-close fires for ALL violations independent of TG-cooldown.
      // Default OFF for safety; flip MAX_LOSS_MONITOR_AUTOCLOSE=true to enable.
      // Routes through the same close-cascade the lifecycle manager uses so
      // all per-executor bookkeeping (RM balance, pool, Supabase) fires
      // correctly. Uses MarketCache for realistic exit price; falls back
      // to entry price (zero-P&L close) on cache miss.
      const autoCloseEnabled = process.env.MAX_LOSS_MONITOR_AUTOCLOSE === 'true';
      const autoClosed: string[] = [];
      if (autoCloseEnabled) {
        for (const v of violations) {
          try {
            const cached = this.marketCache.getMarket(v.trade.marketId);
            let exitPrice = v.trade.entryPrice;
            if (cached?.outcomePrices?.length) {
              const outcomeIdx = cached.outcomes.findIndex((o) => o.toLowerCase() === (v.trade.outcome ?? 'yes').toLowerCase());
              if (outcomeIdx >= 0 && Number.isFinite(cached.outcomePrices[outcomeIdx])) {
                exitPrice = cached.outcomePrices[outcomeIdx];
              }
            }
            const closedCopy = await this.copyExecutor.closePosition(v.trade.marketId, exitPrice, 'max_loss_exposure_breach');
            const closedGeo = closedCopy ? null : await this.geopoliticsExecutor.closePosition(v.trade.marketId, exitPrice, 'max_loss_exposure_breach');
            const closedSig = closedCopy || closedGeo ? null : await this.signalExecutor.closePosition(v.trade.marketId, exitPrice, 'max_loss_exposure_breach');
            const closed = closedCopy || closedGeo || closedSig;
            if (closed) {
              logger.info('MaxLossMonitor: auto-closed ' + v.trade.id.slice(0, 8) + ' at exit ' + exitPrice.toFixed(4));
              autoClosed.push(v.trade.id);
              if (this.config.supabase.url && v.trade.id) {
                try {
                  await db.updateCopyTrade(v.trade.id, {
                    status: 'stopped',
                    pnl: (closed as { pnl?: number }).pnl ?? 0,
                    exitTime: new Date().toISOString(),
                  } as Record<string, unknown>);
                } catch (err) {
                  logger.warn('MaxLossMonitor: Supabase persist failed for ' + v.trade.id + ': ' + err);
                }
              }
              // Once auto-closed we no longer want a "still over cap" TG alert
              this.maxLossAlertCooldown.delete(v.trade.id);
            } else {
              logger.warn('MaxLossMonitor: no executor accepted close for ' + v.trade.marketId);
            }
          } catch (err) {
            logger.error('MaxLossMonitor: auto-close failed for ' + v.trade.id.slice(0, 8) + ': ' + err);
          }
        }
      }

      // TG alert with per-position cooldown. Only NEW violations (i.e. not
      // alerted in the last MAX_LOSS_MONITOR_COOLDOWN_H hours, and not just
      // auto-closed) trigger a fresh TG ping. Logs above already fired for
      // every violation, every cycle, so the audit trail is complete.
      const stillOpen = violations.filter((v) => !autoClosed.includes(v.trade.id));
      const newAlerts = stillOpen.filter((v) => !this.maxLossAlertCooldown.has(v.trade.id));
      if (newAlerts.length > 0) {
        const tgLines: string[] = ['⚠️ <b>MAX-LOSS MONITOR</b>'];
        tgLines.push(newAlerts.length + ' new position(s) over the ' + (maxLossPct * 100).toFixed(0) + '% per-trade cap:');
        for (const v of newAlerts) {
          tgLines.push('• ' + v.trade.side.toUpperCase() + ' @' + v.trade.entryPrice.toFixed(4) +
            ' size $' + v.trade.usdcAmount.toFixed(0) +
            ' — max-loss $' + v.maxLoss.toFixed(0) + ' (' + v.pctOfBalance.toFixed(1) + '%): ' +
            (v.trade.question || v.trade.marketId).slice(0, 45));
          this.maxLossAlertCooldown.set(v.trade.id, now);
        }
        tgLines.push('');
        if (autoCloseEnabled) {
          tgLines.push('<i>Auto-close ON; positions closed where executor accepted.</i>');
        } else {
          tgLines.push('<i>Auto-close OFF. Next alert per position in ' + (cooldownMs / 3600000).toFixed(0) + 'h if still over cap.</i>');
        }
        sendTelegramAlert(tgLines.join('\n'));
      }
    }

    const paperStats = this.paperEngine.getStats();
    const confirmStats = this.confirmationLayer.getStats();
    const copyStats = this.copyExecutor.getStats();
    const geoStats = this.geopoliticsExecutor.getStats();
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
        signalTrades: this.signalExecutor.getStats().executed,
        signalOpen: this.signalExecutor.getStats().openPositions,
        signalsGenerated: this.signalGenerator.getStats().signalsGenerated,
        movementScans: this.movementScanner.getStats().scansCompleted,
        movementSignals: this.movementScanner.getStats().signalsEmitted,
        strategyCScans: this.strategyCScanner.getStats().scansCompleted,
        strategyCSignals: this.strategyCScanner.getStats().signalsEmitted,
        strategyCCandidates: this.strategyCScanner.getStats().candidatesSeen,
        marketsCached: this.marketCache.getStats().totalMarkets,
        geopoliticsTrades: geoStats.executed,
        geopoliticsOpen: geoStats.openPositions,
        geopoliticsBlocked: geoStats.blocked,
        geopoliticsEnabled: this.config.pipelines.geopolitics.enabled,
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
      movementScans: this.movementScanner.getStats().scansCompleted,
      movementSignals: this.movementScanner.getStats().signalsEmitted,
      strategyC: `scans=${this.strategyCScanner.getStats().scansCompleted} signals=${this.strategyCScanner.getStats().signalsEmitted}`,
      geopolitics: this.config.pipelines.geopolitics.enabled
        ? `executed=${geoStats.executed} open=${geoStats.openPositions} blocked=${geoStats.blocked}`
        : 'disabled',
    });

    // Healthchecks.io heartbeat — fire-and-forget; never block or crash on ping failure.
    const hcUrl = process.env.HC_PING_BOT_STATUS;
    if (hcUrl) {
      fetch(hcUrl, { signal: AbortSignal.timeout(5_000) }).catch(() => {});
    }
  }

  /**
   * Get the RiskManager for a specific pipeline. Throws if the pipeline isn't
   * registered (defensive — every PipelineId should have an RM after constructor).
   * Option D, 2026-05-10.
   */
  private getRiskManager(id: PipelineId): RiskManager {
    const rm = this.riskManagers.get(id);
    if (!rm) throw new Error(`RiskManager not initialized for pipeline '${id}'`);
    return rm;
  }
}
