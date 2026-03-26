/**
 * MiroFish Client — queries the MiroFish swarm scanner bridge
 * for consensus probability on Polymarket markets.
 *
 * The scanner runs as a separate Python process, scanning top markets
 * every 90 minutes with 60 simulated agents debating each market.
 * Results are served via HTTP on port 5050.
 */

import { logger } from '../utils/logger.js';

export interface MirofishScore {
  found: boolean;
  swarmProbability: number;      // 0-100, what the swarm thinks YES probability is
  marketPrice: number;           // 0-100, current Polymarket price
  edgePct: number;               // swarm - market (positive = swarm more bullish)
  signal: 'YES' | 'NO' | 'NEUTRAL';
  signalStrength: 'weak' | 'moderate' | 'strong' | 'very_strong';
  confidence: 'high' | 'medium' | 'low' | 'none';
  sampleSize: number;
  stale: boolean;                // true if scan is >3 hours old
  scannedAt: string;
}

const BRIDGE_URL = process.env.MIROFISH_BRIDGE_URL || 'http://localhost:5050';
const TIMEOUT_MS = 5000;

export class MirofishClient {
  private available = true;
  private lastCheckMs = 0;
  private checkIntervalMs = 60_000; // re-check availability every 60s

  /**
   * Query MiroFish for a swarm score on a specific market.
   */
  async getSwarmScore(marketQuestion: string, conditionId?: string): Promise<MirofishScore | null> {
    // Don't hammer the bridge if it's down
    if (!this.available && Date.now() - this.lastCheckMs < this.checkIntervalMs) {
      return null;
    }

    try {
      const params = new URLSearchParams();
      if (conditionId) params.set('condition_id', conditionId);
      if (marketQuestion) params.set('market', marketQuestion);

      const url = `${BRIDGE_URL}/api/swarm-score?${params.toString()}`;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);

      if (!response.ok) {
        throw new Error(`Bridge returned ${response.status}`);
      }

      const data = await response.json();
      this.available = true;
      this.lastCheckMs = Date.now();

      if (!data.found) {
        return null;
      }

      return {
        found: true,
        swarmProbability: data.swarm_probability,
        marketPrice: data.market_price,
        edgePct: data.edge_pct,
        signal: data.signal,
        signalStrength: data.signal_strength,
        confidence: data.confidence,
        sampleSize: data.sample_size,
        stale: data.stale,
        scannedAt: data.scanned_at,
      };

    } catch (err: any) {
      if (this.available) {
        // Only log first failure
        logger.warn(`MiroFish bridge unavailable: ${err.message}`);
        this.available = false;
      }
      this.lastCheckMs = Date.now();
      return null;
    }
  }

  /**
   * Check if a MiroFish score supports or contradicts a trade direction.
   * Returns: 'supports' | 'contradicts' | 'neutral' | 'unavailable'
   */
  async evaluateTrade(
    marketQuestion: string,
    tradeSide: 'buy' | 'sell',
    tradeOutcome: string,
    conditionId?: string,
  ): Promise<{
    verdict: 'supports' | 'contradicts' | 'neutral' | 'unavailable';
    score: MirofishScore | null;
    reason: string;
  }> {
    const score = await this.getSwarmScore(marketQuestion, conditionId);

    if (!score) {
      return { verdict: 'unavailable', score: null, reason: 'No MiroFish scan data available' };
    }

    if (score.stale) {
      return { verdict: 'unavailable', score, reason: `MiroFish data stale (scanned ${score.scannedAt})` };
    }

    if (score.confidence === 'low' || score.confidence === 'none') {
      return { verdict: 'neutral', score, reason: `MiroFish confidence too low (${score.confidence})` };
    }

    // Determine if trade aligns with swarm
    const isYesTrade = tradeSide === 'buy' && tradeOutcome?.toLowerCase().includes('yes');
    const isNoTrade = tradeSide === 'buy' && tradeOutcome?.toLowerCase().includes('no');

    if (score.signal === 'NEUTRAL' || score.signalStrength === 'weak') {
      return {
        verdict: 'neutral',
        score,
        reason: `Swarm is neutral on this market (edge: ${score.edgePct.toFixed(1)}%)`,
      };
    }

    const swarmSaysYes = score.signal === 'YES';

    if ((isYesTrade && swarmSaysYes) || (isNoTrade && !swarmSaysYes)) {
      return {
        verdict: 'supports',
        score,
        reason: `Swarm ${score.signalStrength} support — ${score.swarmProbability.toFixed(0)}% YES vs market ${score.marketPrice.toFixed(0)}% (edge: ${score.edgePct > 0 ? '+' : ''}${score.edgePct.toFixed(1)}%)`,
      };
    } else {
      return {
        verdict: 'contradicts',
        score,
        reason: `Swarm ${score.signalStrength} contradiction — ${score.swarmProbability.toFixed(0)}% YES vs market ${score.marketPrice.toFixed(0)}% (edge: ${score.edgePct > 0 ? '+' : ''}${score.edgePct.toFixed(1)}%)`,
      };
    }
  }

  isAvailable(): boolean {
    return this.available;
  }
}
