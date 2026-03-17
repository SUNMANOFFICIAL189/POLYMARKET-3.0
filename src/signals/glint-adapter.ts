import { logger } from '../utils/logger.js';
import type { GlintSignalEvent, GlintWhaleEvent } from './glint-scraper.js';

/**
 * GlintAdapter — simplified for PATS-Copy confirmation layer.
 *
 * Two roles:
 *  1. Whale wallet matching: check if a whale trade is from one of our tracked leaders
 *  2. News signal pass-through: store recent signals for the confirmation layer to query
 */

export interface ConfirmationSignal {
  headline: string;
  impact: 'critical' | 'high' | 'medium' | 'low';
  direction: 'bullish' | 'bearish' | 'neutral';
  source: string;
  sourceTier: number;
  marketSlug?: string;
  marketQuestion?: string;
  timestamp: number;
}

export interface LeaderWhaleMatch {
  walletAddress: string;
  marketSlug: string;
  marketQuestion: string;
  side: 'buy' | 'sell';
  size: number;
  timestamp: number;
}

export class GlintAdapter {
  private recentSignals: ConfirmationSignal[] = [];
  private readonly SIGNAL_WINDOW_MS = 2 * 60 * 60 * 1000; // 2 hours
  private readonly MAX_SIGNALS = 500;

  onSignal(event: GlintSignalEvent): void {
    for (const match of event.matchedMarkets) {
      const signal: ConfirmationSignal = {
        headline: event.headline,
        impact: event.impact,
        direction: this.inferDirection(event.headline, match.direction),
        source: event.source,
        sourceTier: event.sourceTier,
        marketSlug: match.slug,
        marketQuestion: match.question,
        timestamp: typeof event.timestamp === 'number' ? event.timestamp : Date.now(),
      };
      this.recentSignals.push(signal);
    }

    // Also store signals without specific market matches (general news)
    if (event.matchedMarkets.length === 0) {
      const signal: ConfirmationSignal = {
        headline: event.headline,
        impact: event.impact,
        direction: this.inferDirection(event.headline, undefined),
        source: event.source,
        sourceTier: event.sourceTier,
        timestamp: typeof event.timestamp === 'number' ? event.timestamp : Date.now(),
      };
      this.recentSignals.push(signal);
    }

    this.pruneOldSignals();

    if (this.recentSignals.length > this.MAX_SIGNALS) {
      this.recentSignals = this.recentSignals.slice(-this.MAX_SIGNALS);
    }
  }

  checkForLeaderWhale(event: GlintWhaleEvent, trackedLeaders: string[]): LeaderWhaleMatch | null {
    if (!event.walletAddress) return null;

    const addrLower = event.walletAddress.toLowerCase();
    const isLeader = trackedLeaders.some(addr => addr.toLowerCase() === addrLower);

    if (!isLeader) return null;

    logger.info(`GlintAdapter: Leader whale detected! ${event.walletAddress.slice(0, 10)}... ${event.side} $${event.size.toLocaleString()} on ${event.marketQuestion.slice(0, 50)}`);

    return {
      walletAddress: event.walletAddress,
      marketSlug: event.marketSlug,
      marketQuestion: event.marketQuestion,
      side: event.side,
      size: event.size,
      timestamp: event.timestamp,
    };
  }

  /**
   * Get recent signals for a specific market (by slug or keyword match).
   * Used by the confirmation layer to check news context before copying a trade.
   */
  getSignalsForMarket(marketQuestion: string, windowMs = this.SIGNAL_WINDOW_MS): ConfirmationSignal[] {
    const cutoff = Date.now() - windowMs;
    const q = marketQuestion.toLowerCase();
    const keywords = q.split(/\s+/).filter(w => w.length >= 4);

    return this.recentSignals.filter(s => {
      if (s.timestamp < cutoff) return false;

      // Check direct market match
      if (s.marketQuestion && s.marketQuestion.toLowerCase().includes(q.slice(0, 30))) return true;

      // Check keyword overlap in headline
      const h = s.headline.toLowerCase();
      const matches = keywords.filter(k => h.includes(k)).length;
      return matches >= 2;
    });
  }

  /**
   * Get all recent signals in the time window.
   */
  getRecentSignals(windowMs = this.SIGNAL_WINDOW_MS): ConfirmationSignal[] {
    const cutoff = Date.now() - windowMs;
    return this.recentSignals.filter(s => s.timestamp >= cutoff);
  }

  private pruneOldSignals(): void {
    const cutoff = Date.now() - this.SIGNAL_WINDOW_MS * 2;
    this.recentSignals = this.recentSignals.filter(s => s.timestamp >= cutoff);
  }

  private inferDirection(headline: string, glintDirection?: string): 'bullish' | 'bearish' | 'neutral' {
    if (glintDirection) {
      const d = glintDirection.toLowerCase();
      if (d.includes('yes') || d.includes('bull') || d.includes('up') || d.includes('support')) return 'bullish';
      if (d.includes('no') || d.includes('bear') || d.includes('down') || d.includes('against')) return 'bearish';
    }
    const h = headline.toLowerCase();
    const bullish = ['confirms', 'wins', 'passes', 'signs', 'announces', 'surges', 'soars', 'approves', 'rally', 'higher', 'gains', 'elected', 'victory'];
    const bearish = ['fails', 'loses', 'rejects', 'crashes', 'plunges', 'blocks', 'cancels', 'delays', 'drops', 'falls', 'sinks', 'defeated', 'withdrew'];
    if (bullish.some(w => h.includes(w))) return 'bullish';
    if (bearish.some(w => h.includes(w))) return 'bearish';
    return 'neutral';
  }

  getStats() {
    return { recentSignalCount: this.recentSignals.length };
  }
}
