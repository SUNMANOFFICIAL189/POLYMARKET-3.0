// Shadow-mode divergence logger for Branch 2.
//
// Receives trade events from both the existing REST WalletMonitor (via LeaderTrade)
// and the new PolygonBlockListener (via ParsedTrade). Pairs them up by
// wallet|side|tokenId within a time window and logs four cases:
//
//   - matched     — both saw it (logs detection-latency delta)
//   - rest-only   — REST saw it, WS didn't within the grace period (concerning)
//   - ws-only     — WS saw it, REST didn't within the grace period (concerning)
//   - summary     — periodic counts (every SUMMARY_MS)
//
// Goals for Phase 6 promotion (per master handoff):
//   - WS recall ≥ 95% (matched / (matched + rest-only) ≥ 0.95)
//   - median detection-latency delta < 5s in WS's favor
//
// This module is local-only state. No persistence — counts live in memory and
// reset on bot restart. That's fine for a 24-48h shadow window.

import { logger } from '../utils/logger.js';
import type { LeaderTrade } from '../types/index.js';
import type { ParsedTrade } from './match-orders-decoder.js';

const MATCH_WINDOW_MS = 60_000; // ±60 s match window
const GRACE_PERIOD_MS = 90_000; // event is "unmatched" if no pair after 90 s
const SUMMARY_MS = 30 * 60 * 1000; // 30-min rolling summary
const SWEEP_INTERVAL_MS = 15_000;

export type Source = 'rest' | 'ws';

interface PendingEvent {
  source: Source;
  wallet: string;
  side: string;
  tokenId: string;
  marketId: string;
  price: number;
  size: number;
  ts: number; // ms epoch
  arrivedAt: number; // ms epoch when this listener received it
}

interface Counts {
  matched: number;
  restOnly: number;
  wsOnly: number;
  totalRest: number;
  totalWs: number;
  latencyDeltasMs: number[]; // ws-arrival minus rest-arrival; negative = WS faster
}

export class DivergenceLogger {
  private pending: PendingEvent[] = [];
  private counts: Counts = {
    matched: 0,
    restOnly: 0,
    wsOnly: 0,
    totalRest: 0,
    totalWs: 0,
    latencyDeltasMs: [],
  };
  private sweepHandle: ReturnType<typeof setInterval> | null = null;
  private summaryHandle: ReturnType<typeof setInterval> | null = null;
  private startedAt = 0;

  start(): void {
    if (this.sweepHandle) return;
    this.startedAt = Date.now();
    this.sweepHandle = setInterval(() => this.sweepUnmatched(), SWEEP_INTERVAL_MS);
    this.summaryHandle = setInterval(() => this.logSummary('periodic'), SUMMARY_MS);
    logger.info('DivergenceLogger: started');
  }

  stop(): void {
    if (this.sweepHandle) {
      clearInterval(this.sweepHandle);
      this.sweepHandle = null;
    }
    if (this.summaryHandle) {
      clearInterval(this.summaryHandle);
      this.summaryHandle = null;
    }
    this.logSummary('stop');
  }

  recordRest(trade: LeaderTrade): void {
    this.counts.totalRest++;
    const ev: PendingEvent = {
      source: 'rest',
      wallet: trade.leaderWallet.toLowerCase(),
      side: trade.side,
      tokenId: (trade.tokenId ?? '').toString(),
      marketId: trade.marketId,
      price: trade.entryPrice,
      size: trade.size,
      ts: Date.parse(trade.timestamp),
      arrivedAt: Date.now(),
    };
    this.tryMatchAndStash(ev);
  }

  recordWs(trade: ParsedTrade): void {
    this.counts.totalWs++;
    const ev: PendingEvent = {
      source: 'ws',
      wallet: trade.wallet,
      side: trade.side,
      tokenId: trade.tokenId,
      marketId: trade.conditionId,
      price: trade.entryPrice,
      size: trade.size,
      ts: trade.timestamp,
      arrivedAt: Date.now(),
    };
    this.tryMatchAndStash(ev);
  }

  private tryMatchAndStash(ev: PendingEvent): void {
    // Look for a counterpart from the OPPOSITE source within the match window
    const other: Source = ev.source === 'rest' ? 'ws' : 'rest';
    const idx = this.pending.findIndex(
      (p) => p.source === other && this.fingerprintsMatch(p, ev),
    );
    if (idx >= 0) {
      const counterpart = this.pending.splice(idx, 1)[0]!;
      this.counts.matched++;
      // arrival-latency delta: positive means WS arrived AFTER REST (WS slower)
      // negative means WS arrived BEFORE REST (WS faster — the desired outcome)
      const wsArrival = ev.source === 'ws' ? ev.arrivedAt : counterpart.arrivedAt;
      const restArrival = ev.source === 'rest' ? ev.arrivedAt : counterpart.arrivedAt;
      const deltaMs = wsArrival - restArrival;
      this.counts.latencyDeltasMs.push(deltaMs);
      logger.info(
        `Divergence: MATCHED ${ev.wallet.slice(0, 10)}... ${ev.side} @${ev.price.toFixed(3)} size=$${ev.size.toFixed(2)} ws-rest_delta=${deltaMs}ms`,
      );
      return;
    }
    // No match — stash for the grace period
    this.pending.push(ev);
  }

  private fingerprintsMatch(a: PendingEvent, b: PendingEvent): boolean {
    if (a.wallet !== b.wallet) return false;
    if (a.side !== b.side) return false;
    if (Math.abs(a.ts - b.ts) > MATCH_WINDOW_MS) return false;
    // tokenId matches when both have it; otherwise fall back to marketId
    const aTok = a.tokenId || a.marketId;
    const bTok = b.tokenId || b.marketId;
    if (aTok && bTok && aTok !== bTok) {
      // also accept if either side carries marketId/conditionId equal to the other's tokenId
      if (a.marketId !== b.marketId && a.tokenId !== b.tokenId) return false;
    }
    // Price tolerance: 1.5pp — accommodates fill-vs-limit drift and rounding
    if (Math.abs(a.price - b.price) > 0.015) return false;
    // Size tolerance: 10% relative
    const big = Math.max(a.size, b.size);
    const small = Math.min(a.size, b.size);
    if (big > 0 && small / big < 0.9) return false;
    return true;
  }

  private sweepUnmatched(): void {
    const now = Date.now();
    const cutoff = now - GRACE_PERIOD_MS;
    const survivors: PendingEvent[] = [];
    for (const ev of this.pending) {
      if (ev.arrivedAt >= cutoff) {
        survivors.push(ev);
        continue;
      }
      if (ev.source === 'rest') {
        this.counts.restOnly++;
        logger.warn(
          `Divergence: REST-ONLY ${ev.wallet.slice(0, 10)}... ${ev.side} @${ev.price.toFixed(3)} size=$${ev.size.toFixed(2)} — WS never saw it within ${GRACE_PERIOD_MS / 1000}s`,
        );
      } else {
        this.counts.wsOnly++;
        logger.warn(
          `Divergence: WS-ONLY ${ev.wallet.slice(0, 10)}... ${ev.side} @${ev.price.toFixed(3)} size=$${ev.size.toFixed(2)} — REST never saw it within ${GRACE_PERIOD_MS / 1000}s`,
        );
      }
    }
    this.pending = survivors;
  }

  private logSummary(reason: 'periodic' | 'stop'): void {
    const total = this.counts.matched + this.counts.restOnly + this.counts.wsOnly;
    const recall = this.counts.matched + this.counts.restOnly === 0
      ? 'n/a'
      : ((this.counts.matched / (this.counts.matched + this.counts.restOnly)) * 100).toFixed(1) + '%';
    const sortedDeltas = [...this.counts.latencyDeltasMs].sort((a, b) => a - b);
    const median = sortedDeltas.length === 0
      ? 'n/a'
      : `${sortedDeltas[Math.floor(sortedDeltas.length / 2)]}ms`;
    const elapsedMin = ((Date.now() - this.startedAt) / 60_000).toFixed(1);
    logger.info(
      `Divergence summary [${reason}, ${elapsedMin}min]: total=${total} matched=${this.counts.matched} rest-only=${this.counts.restOnly} ws-only=${this.counts.wsOnly} ws-recall=${recall} median-delta(ws-rest)=${median} pending=${this.pending.length}`,
    );
  }

  /** Snapshot of current counts — used by status logger / watchdog hooks. */
  getStats() {
    return {
      ...this.counts,
      pending: this.pending.length,
      startedAt: this.startedAt,
    };
  }
}
