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

export interface WalletStat {
  wallet: string;
  displayName: string;       // userName from Polymarket or "Tier-1: balthazar"
  tier: 'Tier-1' | 'Tier-2' | 'External';
  internalName?: string;     // our pseudonym for this wallet (if in watchlist)
  totalWinPnl: number;       // sum of pnl from /biggest-winners events
  eventCount: number;        // count of winning events
  flag: 'DEMOTE' | 'PROMOTE' | null;
  reason?: string;           // human-readable explanation of the flag
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

    // Classify and build per-wallet stats
    const tier1Stats: WalletStat[] = [];
    const externalStats: WalletStat[] = [];

    // Ensure every Tier-1 wallet appears in the report — fill in zeroes
    // for wallets that don't show up in /biggest-winners at all.
    for (const spec of TIER_1) {
      const aggKey = spec.walletAddress.toLowerCase();
      const agg = aggregated.get(aggKey);
      if (agg) {
        tier1Stats.push({
          wallet: aggKey,
          displayName: 'Tier-1: ' + spec.name,
          tier: 'Tier-1',
          internalName: spec.name,
          totalWinPnl: agg.totalPnl,
          eventCount: agg.events.length,
          flag: agg.totalPnl < DEMOTE_THRESHOLD ? 'DEMOTE' : null,
          reason: agg.totalPnl < DEMOTE_THRESHOLD
            ? 'Total winning pnl $' + agg.totalPnl.toFixed(0) + ' below threshold $' + DEMOTE_THRESHOLD
            : undefined,
        });
        // Mark as consumed so it's not double-listed as external
        aggregated.delete(aggKey);
      } else {
        tier1Stats.push({
          wallet: aggKey,
          displayName: 'Tier-1: ' + spec.name,
          tier: 'Tier-1',
          internalName: spec.name,
          totalWinPnl: 0,
          eventCount: 0,
          flag: 'DEMOTE',
          reason: 'No appearance in /biggest-winners — no recent realized wins',
        });
      }
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
