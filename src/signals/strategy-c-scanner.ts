/**
 * StrategyCScanner — systematic discovery of "fade the near-cert" trades.
 *
 * The signal pipeline organically discovered (over the 2026-05-12 → 2026-05-16
 * soak window) that SELL-Yes on markets priced YES >= 0.92 with <24h to
 * resolution wins ~87.5% of the time (8 trades sampled). The wins come from
 * markets where the consensus prices YES near-cert but the actual outcome
 * resolves NO, often via TTL force-close at a price drop.
 *
 * The catch: the signal pipeline only finds these markets when the news
 * generator happens to surface them. Most candidates never make it through
 * news headlines. A live gamma-api scan reveals 25+ such markets active at
 * any moment — we were capturing ~2-3 per day from news.
 *
 * StrategyCScanner closes that discovery gap. It iterates the existing
 * MarketCache (which polls Gamma every 3 min) and emits a TradingSignal for
 * each market that matches the Strategy C entry criteria. The runner routes
 * the signal through the existing SignalExecutor — same filter chain, same
 * sizing tiers, same risk gates — just with a non-news discovery source.
 *
 * Phase 0.4, 2026-05-17. Build plan: _NEXT_STEPS/build-plan-2026-05-16.md.
 *
 * Statistical caveat (CTDD, per session lessons 2026-05-16):
 *   The 87.5% WR is on 8 trades. Statistically not yet significant. This
 *   scanner is a research tool first, profit engine second. Its primary
 *   purpose for the next 14-30 days is to multiply the trade count so we
 *   can reach statistical significance on the underlying strategy. If WR
 *   drops materially below 60% as the sample grows, this scanner is the
 *   first thing to disable (set STRATEGY_C_SCANNER_ENABLED=false).
 */

import { EventEmitter } from 'node:events';
import { logger } from '../utils/logger.js';
import type { CachedMarket, MarketCache } from './market-cache.js';
import type { TradingSignal } from './signal-generator.js';

// ─── Config (all env-overridable so we can tune without redeploy) ──────────
const SCAN_INTERVAL_MS = Number(process.env.STRATEGY_C_SCAN_MS ?? '60000') || 60000; // 60s
// Price band for SELL-Yes entry: market must believe YES strongly (near-cert)
// but not be at pure leader-close territory (>0.995 is just the favorite
// running away as the deadline closes — negative-EV to fade).
const MIN_NEAR_CERT_PRICE = Number(process.env.STRATEGY_C_MIN_PRICE ?? '0.92');
const MAX_NEAR_CERT_PRICE = Number(process.env.STRATEGY_C_MAX_PRICE ?? '0.995');
// Time-to-resolution: matches signal-executor's MAX_HOURS_SELL_RESOLUTION
// (24h) so the scanner doesn't waste signals on markets that will be
// rejected downstream. Loosen ONLY in tandem with that env.
const MAX_HOURS_TO_END = Number(process.env.STRATEGY_C_MAX_HOURS ?? '24');
// Liquidity floor — avoid scalping markets where our $50-100 order moves
// the book. $500 is generous given our sizes; can go higher if slippage shows.
const MIN_LIQUIDITY = Number(process.env.STRATEGY_C_MIN_LIQ ?? '500');
// Cooldown so we don't re-emit the same market every 60s. Signal-executor
// has its own dedup against open positions, but the cooldown here keeps the
// signal stream cleaner and reduces log noise.
const COOLDOWN_MS = (parseInt(process.env.STRATEGY_C_COOLDOWN_H ?? '4')) * 60 * 60 * 1000;
const SCANNER_ENABLED = process.env.STRATEGY_C_SCANNER_ENABLED !== 'false';

export class StrategyCScanner extends EventEmitter {
  private marketCache: MarketCache;
  private cooldowns: Map<string, number> = new Map(); // slug → cooldown-until-ts
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private scansCompleted = 0;
  private signalsEmitted = 0;
  private candidatesSeen = 0;

  constructor(opts: { marketCache: MarketCache }) {
    super();
    this.marketCache = opts.marketCache;
  }

  start(): void {
    if (!SCANNER_ENABLED) {
      logger.info('StrategyCScanner: disabled via STRATEGY_C_SCANNER_ENABLED=false');
      return;
    }
    logger.info(
      'StrategyCScanner: Starting — scan every ' + (SCAN_INTERVAL_MS / 1000) + 's, ' +
      'criteria: ' + MIN_NEAR_CERT_PRICE + ' <= YES <= ' + MAX_NEAR_CERT_PRICE +
      ', end < ' + MAX_HOURS_TO_END + 'h, liquidity > $' + MIN_LIQUIDITY +
      ', cooldown ' + (COOLDOWN_MS / 3600000).toFixed(0) + 'h',
    );
    // First scan after 30s — wait for market cache to populate from its
    // own poll. The MarketCache's first refresh happens on its own schedule.
    setTimeout(() => this.scan(), 30_000);
    this.intervalId = setInterval(() => this.scan(), SCAN_INTERVAL_MS);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    logger.info('StrategyCScanner: Stopped');
  }

  getStats() {
    return {
      scansCompleted: this.scansCompleted,
      candidatesSeen: this.candidatesSeen,
      signalsEmitted: this.signalsEmitted,
    };
  }

  private scan(): void {
    try {
      this.scansCompleted++;
      const now = Date.now();

      // Prune expired cooldowns to keep the Map bounded
      for (const [slug, until] of this.cooldowns) {
        if (now > until) this.cooldowns.delete(slug);
      }

      const markets = this.marketCache.getAllMarkets();
      if (markets.length === 0) return;

      let candidatesThisScan = 0;
      let emittedThisScan = 0;

      for (const market of markets) {
        if (!this.isStrategyCCandidate(market, now)) continue;
        candidatesThisScan++;

        // Cooldown — already signaled this market recently
        const cooldownUntil = this.cooldowns.get(market.slug);
        if (cooldownUntil && now < cooldownUntil) continue;

        const signal = this.buildSignal(market, now);
        if (!signal) continue;

        this.cooldowns.set(market.slug, now + COOLDOWN_MS);
        this.signalsEmitted++;
        this.candidatesSeen++;
        emittedThisScan++;

        const hoursToEnd = market.endDate
          ? (new Date(market.endDate).getTime() - now) / 3600000
          : 0;
        logger.info(
          'StrategyCScanner: SIGNAL SELL "' + (market.question || market.slug).slice(0, 50) +
          '" YES=' + market.outcomePrices[0].toFixed(4) +
          ' (' + (signal.confidence * 100).toFixed(0) + '% conf, ' +
          hoursToEnd.toFixed(1) + 'h to resolution)',
        );
        this.emit('signal', signal);
      }

      // Periodic summary so logs show the scanner is alive even when no signals fire
      if (emittedThisScan > 0 || this.scansCompleted % 30 === 0) {
        logger.info(
          'StrategyCScanner: scan #' + this.scansCompleted + ' — ' +
          candidatesThisScan + ' candidate(s) of ' + markets.length + ' markets ' +
          '(' + emittedThisScan + ' emitted this scan; ' +
          this.signalsEmitted + ' lifetime; ' + this.cooldowns.size + ' in cooldown)',
        );
      }
    } catch (err) {
      logger.warn('StrategyCScanner: scan error: ' + err);
    }
  }

  /**
   * Does this market match the Strategy C entry criteria right now?
   * Pure function of the market's current state — no historical context needed.
   */
  private isStrategyCCandidate(market: CachedMarket, now: number): boolean {
    // Must be active
    if (!market.active) return false;
    // Must have endDate within the window
    if (!market.endDate) return false;
    const endMs = new Date(market.endDate).getTime();
    if (isNaN(endMs)) return false;
    const hoursToEnd = (endMs - now) / 3600000;
    if (hoursToEnd <= 0 || hoursToEnd > MAX_HOURS_TO_END) return false;

    // Must have a 2-outcome binary structure with valid prices
    if (!market.outcomePrices || market.outcomePrices.length < 2) return false;
    const yes = market.outcomePrices[0];
    const no = market.outcomePrices[1];
    if (!Number.isFinite(yes) || !Number.isFinite(no)) return false;

    // YES must be near-cert (we'll SELL-YES) but not in pure leader-close zone
    if (yes < MIN_NEAR_CERT_PRICE || yes > MAX_NEAR_CERT_PRICE) return false;

    // Liquidity check via 24h volume as a proxy (cache stores volume24h)
    // NOTE: CachedMarket doesn't store the "liquidity" field directly; we use
    // volume24h as a proxy. Markets with active trading have meaningful
    // volume even if the book depth varies. The MIN_LIQUIDITY threshold is
    // calibrated to this — adjust together if behavior is unexpected.
    if (market.volume24h < MIN_LIQUIDITY) return false;

    return true;
  }

  /**
   * Build a TradingSignal that the SignalExecutor will route through its
   * standard filter chain. Confidence scales with how strongly the market
   * believes YES (higher YES price = higher conviction the consensus is
   * mispricing certainty).
   */
  private buildSignal(market: CachedMarket, now: number): TradingSignal | null {
    const yes = market.outcomePrices[0];
    const hoursToEnd = market.endDate
      ? (new Date(market.endDate).getTime() - now) / 3600000
      : 0;

    // Confidence map: linear interpolation across the price band so the
    // strongest near-certs ($0.99+) get top sizing tier ($100 per signal-
    // executor's SELL_SIZING_TIERS), while edge cases at 0.92 get the
    // smallest tier.
    const priceAboveFloor = Math.max(0, yes - MIN_NEAR_CERT_PRICE);
    const priceRange = MAX_NEAR_CERT_PRICE - MIN_NEAR_CERT_PRICE;
    // Map [0, 1] of price-within-band to [0.65, 0.95] confidence:
    //   YES=0.92 → conf 0.65 → $35 size
    //   YES=0.94 → conf 0.72 → $50 size
    //   YES=0.96 → conf 0.80 → $75 size
    //   YES=0.98 → conf 0.87 → $75 size (still under 0.90 threshold)
    //   YES=0.995→ conf 0.95 → $100 size
    const confidence = Math.min(
      0.95,
      Math.max(0.65, 0.65 + (priceAboveFloor / Math.max(priceRange, 1e-9)) * 0.30),
    );

    const reasoning =
      'Strategy C scanner: SELL-Yes on near-cert at ' + yes.toFixed(4) +
      ', ' + hoursToEnd.toFixed(1) + 'h to resolution. ' +
      '24h volume $' + market.volume24h.toFixed(0) + '. ' +
      'Fade the favourite — small profit if consensus is right, larger profit if NO actually wins.';

    return {
      type: 'news-driven', // re-use existing type; SignalExecutor reads side/confidence, not type
      market,
      side: 'sell',
      confidence,
      reasoning,
      newsHeadline: '[strategy-c-scanner] ' + (market.question || market.slug).slice(0, 80),
      newsSource: 'strategy-c-scanner',
      generatedAt: new Date().toISOString(),
    };
  }
}
