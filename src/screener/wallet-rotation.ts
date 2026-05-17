/**
 * WalletScreener — defensive infrastructure that surfaces wallet-quality
 * decay BEFORE it silently erodes returns.
 *
 * Without this, a Tier-1 specialist whose edge has decayed (because the
 * wallet is now on a public leaderboard, regime shift, life events, etc.)
 * keeps consuming our paper capital with no automated signal. The
 * 2026-05-12 → 2026-05-16 soak surfaced exactly this: Car at -$145 realized,
 * unknown-near-miss at -$15,645 realized, no automated demotion signal.
 *
 * Architecture (Phase 1, 2026-05-17):
 *   - Polls /biggest-winners for top wallets by realized P&L
 *   - Aggregates per-wallet across multiple resolved events
 *   - Classifies each: Tier-1 (in our watchlist) / Tier-2 / External
 *   - Flags DEMOTE candidates: Tier-1 wallets that don't appear in winners
 *     list (no recent realized wins) OR fall below DEMOTE_THRESHOLD
 *   - Flags PROMOTE candidates: external wallets with realized P&L above
 *     PROMOTE_THRESHOLD on >=MIN_RESOLVED_TRADES events
 *   - Emits 'report' event → runner formats and sends Telegram alert
 *
 * Read-only by design. The bot does NOT auto-modify the watchlist. Reports
 * are advisory; user reviews and manually edits src/geopolitics/watchlist.ts
 * if they agree with the recommendation. This is intentional — the cost of
 * a wrong auto-promotion (mirror a wallet whose edge isn't real) is
 * higher than the cost of a delayed manual update.
 *
 * Cadence: weekly by default (env-overridable). First run 5 min after
 * bot start so deploys produce a verification report quickly.
 */

import { EventEmitter } from 'node:events';
import { logger } from '../utils/logger.js';
import { TIER_1, TIER_2, findSpecialist } from '../geopolitics/watchlist.js';

// ─── Config — all env-overridable ────────────────────────────────────
const SCREENING_ENABLED = process.env.WALLET_SCREENING_ENABLED !== 'false';
const SCREEN_INTERVAL_MS = (parseInt(process.env.WALLET_SCREEN_INTERVAL_DAYS ?? '7')) * 86400_000;
const FIRST_SCREEN_DELAY_MS = (parseInt(process.env.WALLET_SCREEN_FIRST_DELAY_MIN ?? '5')) * 60_000;
const FETCH_LIMIT = parseInt(process.env.WALLET_SCREEN_FETCH_LIMIT ?? '500');
// Promotion candidate criteria
const PROMOTE_THRESHOLD = parseFloat(process.env.WALLET_PROMOTE_THRESHOLD ?? '5000');  // $ realized
const MIN_RESOLVED_TRADES = parseInt(process.env.WALLET_MIN_RESOLVED ?? '5');           // count of winning events
// Demotion candidate criteria (Tier-1 wallet performance threshold)
const DEMOTE_THRESHOLD = parseFloat(process.env.WALLET_DEMOTE_THRESHOLD ?? '100');      // $ — Tier-1 with <$100 recent wins is sus
// Output limits for the TG report
const MAX_PROMOTE_IN_REPORT = parseInt(process.env.WALLET_MAX_PROMOTE_REPORT ?? '10');

const DATA_API = 'https://data-api.polymarket.com';

// ─── Calibration tuning (Phase 1.1, 2026-05-17) ──────────────────────
// The /biggest-winners endpoint is a "recent realized wins" view. Long-hold
// specialists like balthazar (~500 open Peruvian-election positions) don't
// appear there until their markets resolve. To avoid mis-flagging them as
// demote candidates, supplement with /positions per Tier-1 wallet and
// compute the open book health.
//
// A Tier-1 wallet stays HEALTHY if ANY of:
//   1. Appears in /biggest-winners with totalWinPnl >= DEMOTE_THRESHOLD
//   2. Open book has net positive unrealized P&L >= UNREALIZED_HEALTH_THRESHOLD
//   3. Has >= MIN_RECENT_POSITIONS open positions (proxy for "actively trading")
//
// Demote only when ALL THREE signals are absent. This is a much higher bar.
const UNREALIZED_HEALTH_THRESHOLD = parseFloat(process.env.WALLET_UNREALIZED_HEALTH_THRESHOLD ?? '1000');
const MIN_RECENT_POSITIONS = parseInt(process.env.WALLET_MIN_RECENT_POSITIONS ?? '10');
const POSITIONS_FETCH_LIMIT = parseInt(process.env.WALLET_POSITIONS_FETCH_LIMIT ?? '500');

// ─── Types ───────────────────────────────────────────────────────────
interface WalletEvent {
  wallet: string;
  userName: string;
  pnl: number;
  initialValue: number;
  finalValue: number;
  eventSlug: string;
  eventTitle: string;
}

interface AggregatedWallet {
  totalPnl: number;
  events: WalletEvent[];
  userName: string;
}

interface WalletPositionsSummary {
  openPositionCount: number;
  totalInitialValue: number;        // capital deployed into open positions
  totalCurrentValue: number;        // current market value of open positions
  totalUnrealizedPnl: number;       // cashPnl + realizedPnl across positions
  redeemableCount: number;          // count of resolved-in-their-favor positions
  topWinnerTitle?: string;
  topWinnerPnl?: number;
}

export interface WalletStat {
  wallet: string;
  displayName: string;       // userName from Polymarket or "Tier-1: balthazar"
  tier: 'Tier-1' | 'Tier-2' | 'External';
  internalName?: string;     // our pseudonym for this wallet (if in watchlist)
  totalWinPnl: number;       // sum of pnl from /biggest-winners events
  eventCount: number;        // count of winning events
  flag: 'DEMOTE' | 'PROMOTE' | null;
  reason?: string;           // human-readable explanation of the flag
  // ── Phase 1.1 calibration fields (Tier-1 only) ──
  positions?: WalletPositionsSummary;
}

export interface WalletScreenReport {
  generatedAt: string;
  fetchWindowDescription: string;
  totalEventsScanned: number;
  totalWalletsAggregated: number;
  tier1: WalletStat[];
  promotionCandidates: WalletStat[];
  demotionCandidates: WalletStat[];
}

export class WalletScreener extends EventEmitter {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private firstScreenTimer: ReturnType<typeof setTimeout> | null = null;
  private screensCompleted = 0;
  private lastReportAt: string | null = null;

  start(): void {
    if (!SCREENING_ENABLED) {
      logger.info('WalletScreener: disabled via WALLET_SCREENING_ENABLED=false');
      return;
    }
    logger.info(
      'WalletScreener: starting — first screen in ' +
      (FIRST_SCREEN_DELAY_MS / 60_000).toFixed(0) + ' min, ' +
      'then every ' + (SCREEN_INTERVAL_MS / 86400_000).toFixed(0) + ' days. ' +
      'Thresholds: promote >= $' + PROMOTE_THRESHOLD + ' on ' + MIN_RESOLVED_TRADES + '+ events, ' +
      'demote Tier-1 below $' + DEMOTE_THRESHOLD + '.',
    );
    this.firstScreenTimer = setTimeout(() => this.screen().catch((e) => logger.warn('WalletScreener first-screen error: ' + e)), FIRST_SCREEN_DELAY_MS);
    this.intervalId = setInterval(() => this.screen().catch((e) => logger.warn('WalletScreener weekly-screen error: ' + e)), SCREEN_INTERVAL_MS);
  }

  stop(): void {
    if (this.intervalId) { clearInterval(this.intervalId); this.intervalId = null; }
    if (this.firstScreenTimer) { clearTimeout(this.firstScreenTimer); this.firstScreenTimer = null; }
    logger.info('WalletScreener: stopped');
  }

  getStats() {
    return {
      screensCompleted: this.screensCompleted,
      lastReportAt: this.lastReportAt,
    };
  }

  /** Manually trigger a screen run (test path / future REST endpoint). */
  async screenNow(): Promise<WalletScreenReport> {
    return this.screen();
  }

  private async screen(): Promise<WalletScreenReport> {
    const startTs = Date.now();
    logger.info('WalletScreener: starting screen — fetching /biggest-winners (limit=' + FETCH_LIMIT + ')...');

    const winners = await this.fetchBiggestWinners();
    logger.info('WalletScreener: fetched ' + winners.length + ' winning events');

    const aggregated = this.aggregateByWallet(winners);
    logger.info('WalletScreener: aggregated to ' + aggregated.size + ' unique wallets');

    // Phase 1.1 calibration: fetch /positions for each Tier-1 wallet in parallel
    // to detect long-hold open-book health that /biggest-winners misses.
    logger.info('WalletScreener: fetching positions for ' + TIER_1.length + ' Tier-1 wallets in parallel...');
    const positionsByWallet = new Map<string, WalletPositionsSummary>();
    await Promise.all(
      TIER_1.map(async (spec) => {
        const key = spec.walletAddress.toLowerCase();
        try {
          const summary = await this.fetchPositionsSummary(spec.walletAddress);
          positionsByWallet.set(key, summary);
        } catch (err) {
          logger.warn('WalletScreener: positions fetch failed for ' + spec.name + ': ' + err);
        }
      }),
    );
    logger.info('WalletScreener: positions fetched for ' + positionsByWallet.size + '/' + TIER_1.length + ' Tier-1 wallets');

    // Classify and build per-wallet stats
    const tier1Stats: WalletStat[] = [];
    const externalStats: WalletStat[] = [];

    // Tier-1 evaluation: combine /biggest-winners and /positions signals.
    // A wallet is HEALTHY if ANY of:
    //   (a) appears in /biggest-winners with totalWinPnl >= DEMOTE_THRESHOLD
    //   (b) open-book unrealized P&L >= UNREALIZED_HEALTH_THRESHOLD
    //   (c) has >= MIN_RECENT_POSITIONS open positions (actively trading)
    // Demote only when ALL THREE signals are absent.
    for (const spec of TIER_1) {
      const aggKey = spec.walletAddress.toLowerCase();
      const agg = aggregated.get(aggKey);
      const pos = positionsByWallet.get(aggKey);

      const winPnl = agg?.totalPnl ?? 0;
      const winEvents = agg?.events.length ?? 0;
      const openCount = pos?.openPositionCount ?? 0;
      const unrealized = pos?.totalUnrealizedPnl ?? 0;

      const signalA_hasRecentWins = winPnl >= DEMOTE_THRESHOLD;
      const signalB_strongOpenBook = unrealized >= UNREALIZED_HEALTH_THRESHOLD;
      const signalC_activelyTrading = openCount >= MIN_RECENT_POSITIONS;

      const healthy = signalA_hasRecentWins || signalB_strongOpenBook || signalC_activelyTrading;

      let flag: 'DEMOTE' | null = null;
      let reason: string | undefined;
      if (!healthy) {
        flag = 'DEMOTE';
        const parts: string[] = [];
        parts.push('no recent /biggest-winners appearance' + (winPnl > 0 ? ' (only $' + winPnl.toFixed(0) + ')' : ''));
        if (openCount === 0) {
          parts.push('zero open positions');
        } else {
          parts.push('only ' + openCount + ' open positions');
        }
        if (unrealized < UNREALIZED_HEALTH_THRESHOLD) {
          parts.push('unrealized $' + unrealized.toFixed(0) + ' below health threshold $' + UNREALIZED_HEALTH_THRESHOLD);
        }
        reason = parts.join('; ');
      } else {
        // Build a human-readable "healthy because…" string for the report
        const why: string[] = [];
        if (signalA_hasRecentWins) why.push('/biggest-winners $' + winPnl.toFixed(0));
        if (signalB_strongOpenBook) why.push('unrealized $' + unrealized.toFixed(0));
        if (signalC_activelyTrading) why.push(openCount + ' open positions');
        reason = 'Healthy: ' + why.join(' + ');
      }

      tier1Stats.push({
        wallet: aggKey,
        displayName: 'Tier-1: ' + spec.name,
        tier: 'Tier-1',
        internalName: spec.name,
        totalWinPnl: winPnl,
        eventCount: winEvents,
        flag,
        reason,
        positions: pos,
      });

      // Mark as consumed so it's not double-listed as external candidate
      if (agg) aggregated.delete(aggKey);
    }

    // Same for Tier-2 (informational; not flagged)
    for (const spec of TIER_2) {
      const aggKey = spec.walletAddress.toLowerCase();
      const agg = aggregated.get(aggKey);
      if (agg) {
        aggregated.delete(aggKey);
      }
    }

    // External wallets ranked by total winning pnl
    const externals = Array.from(aggregated.entries())
      .map(([wallet, info]) => ({
        wallet,
        displayName: info.userName || wallet.slice(0, 10),
        tier: 'External' as const,
        totalWinPnl: info.totalPnl,
        eventCount: info.events.length,
        flag: null as 'DEMOTE' | 'PROMOTE' | null,
        reason: undefined as string | undefined,
      }))
      .sort((a, b) => b.totalWinPnl - a.totalWinPnl);

    // Apply promotion criteria
    for (const w of externals) {
      if (w.totalWinPnl >= PROMOTE_THRESHOLD && w.eventCount >= MIN_RESOLVED_TRADES) {
        w.flag = 'PROMOTE';
        w.reason = 'Realized $' + w.totalWinPnl.toFixed(0) + ' across ' + w.eventCount + ' winning events';
        externalStats.push(w);
      }
    }

    const report: WalletScreenReport = {
      generatedAt: new Date().toISOString(),
      fetchWindowDescription: 'Polymarket /biggest-winners snapshot (Polymarket-defined window, typically last 7-30d)',
      totalEventsScanned: winners.length,
      totalWalletsAggregated: aggregated.size + tier1Stats.length,
      tier1: tier1Stats,
      promotionCandidates: externalStats.slice(0, MAX_PROMOTE_IN_REPORT),
      demotionCandidates: tier1Stats.filter((w) => w.flag === 'DEMOTE'),
    };

    this.screensCompleted++;
    this.lastReportAt = report.generatedAt;
    const elapsedSec = (Date.now() - startTs) / 1000;

    logger.info(
      'WalletScreener: report ready in ' + elapsedSec.toFixed(1) + 's — ' +
      tier1Stats.length + ' Tier-1, ' +
      report.promotionCandidates.length + ' promote candidate(s), ' +
      report.demotionCandidates.length + ' demote candidate(s)',
    );

    this.emit('report', report);
    return report;
  }

  /**
   * Fetch a /positions summary for one wallet. Used to detect long-hold
   * open-book health for Tier-1 wallets whose edge doesn't show up in
   * /biggest-winners (because their positions haven't resolved yet).
   * Phase 1.1 calibration, 2026-05-17.
   */
  private async fetchPositionsSummary(wallet: string): Promise<WalletPositionsSummary> {
    const url = DATA_API + '/positions?user=' + wallet + '&limit=' + POSITIONS_FETCH_LIMIT;
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error('/positions returned HTTP ' + res.status);
    const data = await res.json() as Array<Record<string, unknown>>;
    if (!Array.isArray(data)) {
      return {
        openPositionCount: 0,
        totalInitialValue: 0,
        totalCurrentValue: 0,
        totalUnrealizedPnl: 0,
        redeemableCount: 0,
      };
    }

    let openCount = 0;
    let totalInit = 0;
    let totalCur = 0;
    let totalUnrealized = 0;
    let redeemable = 0;
    let topPnl = -Infinity;
    let topTitle: string | undefined;

    for (const p of data) {
      const initialValue = Number(p.initialValue) || 0;
      const currentValue = Number(p.currentValue) || 0;
      const cashPnl = Number(p.cashPnl) || 0;
      const realizedPnl = Number(p.realizedPnl) || 0;
      const truePnl = cashPnl + realizedPnl;
      const isRedeemable = Boolean(p.redeemable);
      const title = typeof p.title === 'string' ? p.title : undefined;

      // Only count "open" positions (initialValue > 0 means they bought)
      if (initialValue <= 0) continue;

      // Treat as "still open" if currentValue > 0 and not redeemable
      if (currentValue > 0 && !isRedeemable) {
        openCount++;
        totalInit += initialValue;
        totalCur += currentValue;
      }

      if (isRedeemable) redeemable++;

      // Always include truePnl (closed and open positions contribute)
      totalUnrealized += truePnl;

      if (truePnl > topPnl) {
        topPnl = truePnl;
        topTitle = title;
      }
    }

    return {
      openPositionCount: openCount,
      totalInitialValue: totalInit,
      totalCurrentValue: totalCur,
      totalUnrealizedPnl: totalUnrealized,
      redeemableCount: redeemable,
      topWinnerTitle: topTitle,
      topWinnerPnl: topPnl === -Infinity ? undefined : topPnl,
    };
  }

  private async fetchBiggestWinners(): Promise<WalletEvent[]> {
    const url = DATA_API + '/v1/biggest-winners?limit=' + FETCH_LIMIT;
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error('/biggest-winners returned HTTP ' + res.status);
    const data = await res.json() as Array<Record<string, unknown>>;
    return data
      .map((d) => ({
        wallet: String(d.proxyWallet ?? '').toLowerCase(),
        userName: String(d.userName ?? ''),
        pnl: Number(d.pnl) || 0,
        initialValue: Number(d.initialValue) || 0,
        finalValue: Number(d.finalValue) || 0,
        eventSlug: String(d.eventSlug ?? ''),
        eventTitle: String(d.eventTitle ?? ''),
      }))
      .filter((e) => e.wallet && e.pnl > 0);
  }

  private aggregateByWallet(events: WalletEvent[]): Map<string, AggregatedWallet> {
    const map = new Map<string, AggregatedWallet>();
    for (const e of events) {
      const existing = map.get(e.wallet);
      if (existing) {
        existing.totalPnl += e.pnl;
        existing.events.push(e);
        // Prefer non-empty userName if we encounter one
        if (!existing.userName && e.userName) existing.userName = e.userName;
      } else {
        map.set(e.wallet, { totalPnl: e.pnl, events: [e], userName: e.userName });
      }
    }
    return map;
  }
}
