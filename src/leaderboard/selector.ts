import { logger } from '../utils/logger.js';
import type { Leader } from '../types/index.js';

/**
 * LeaderSelector — picks the current #1 leader with hysteresis to prevent flapping.
 *
 * Rotation rule: only switch when #2 exceeds #1 by > MARGIN% for > MIN_DURATION_MS.
 * This prevents rapid switching when two traders are neck-and-neck.
 */

export interface RotationEvent {
  previousLeader: Leader | null;
  newLeader: Leader;
  reason: string;
  timestamp: string;
}

export class LeaderSelector {
  private currentLeader: Leader | null = null;
  private candidateLeader: Leader | null = null;
  private candidateSince: number = 0;
  private hysteresisMarginPct: number;
  private hysteresisMinDurationMs: number;
  private rotationHistory: RotationEvent[] = [];
  private onRotation: ((event: RotationEvent) => void) | null = null;
  private lastScoredLeaders: Leader[] = [];

  constructor(opts: {
    hysteresisMarginPct?: number;
    hysteresisMinDurationMs?: number;
    onRotation?: (event: RotationEvent) => void;
  } = {}) {
    this.hysteresisMarginPct = opts.hysteresisMarginPct ?? 5; // 5%
    this.hysteresisMinDurationMs = opts.hysteresisMinDurationMs ?? 3_600_000; // 1 hour
    this.onRotation = opts.onRotation ?? null;
  }

  /**
   * Process a new ranked leaderboard snapshot.
   * Returns the current leader (may be same or new).
   */
  update(rankedLeaders: Leader[]): Leader | null {
    this.lastScoredLeaders = rankedLeaders;
    if (rankedLeaders.length === 0) {
      logger.warn('LeaderSelector: Empty leaderboard — keeping current leader');
      return this.currentLeader;
    }

    const top = rankedLeaders[0];

    // First time: just set the leader
    if (!this.currentLeader) {
      logger.info(`LeaderSelector: Initial leader set → ${top.walletAddress.slice(0, 10)}... (score: ${top.compositeScore.toFixed(1)})`);
      this.setLeader(top, null, 'initial');
      return this.currentLeader;
    }

    // Find current leader in new rankings (score may have changed)
    const currentInNew = rankedLeaders.find(l => l.walletAddress === this.currentLeader!.walletAddress);

    if (!currentInNew) {
      // Current leader no longer in leaderboard — rotate immediately
      logger.warn(`LeaderSelector: Current leader ${this.currentLeader.walletAddress.slice(0, 10)}... dropped off leaderboard — rotating`);
      this.setLeader(top, this.currentLeader, 'dropped_off_leaderboard');
      return this.currentLeader;
    }

    // Update current leader's latest score
    this.currentLeader = { ...this.currentLeader, ...currentInNew };

    // Check if top is still the current leader
    if (top.walletAddress === this.currentLeader.walletAddress) {
      // Still #1 — reset any pending rotation
      if (this.candidateLeader) {
        logger.info(`LeaderSelector: Current leader reclaimed #1 — cancelling rotation candidate`);
        this.candidateLeader = null;
        this.candidateSince = 0;
      }
      return this.currentLeader;
    }

    // Someone else is #1 — check if margin is sufficient to trigger rotation
    const currentScore = currentInNew.compositeScore;
    const topScore = top.compositeScore;
    const marginPct = ((topScore - currentScore) / currentScore) * 100;

    if (marginPct < this.hysteresisMarginPct) {
      // Margin too small — don't rotate
      logger.debug(`LeaderSelector: ${top.walletAddress.slice(0, 10)}... leads by ${marginPct.toFixed(1)}% — below ${this.hysteresisMarginPct}% threshold`);
      this.candidateLeader = null;
      this.candidateSince = 0;
      return this.currentLeader;
    }

    // Margin is sufficient — start or continue hysteresis timer
    if (!this.candidateLeader || this.candidateLeader.walletAddress !== top.walletAddress) {
      // New candidate
      this.candidateLeader = top;
      this.candidateSince = Date.now();
      logger.info(`LeaderSelector: New rotation candidate ${top.walletAddress.slice(0, 10)}... leads by ${marginPct.toFixed(1)}% — waiting ${this.hysteresisMinDurationMs / 60000}min`);
      return this.currentLeader;
    }

    // Same candidate — check if it's been long enough
    const elapsed = Date.now() - this.candidateSince;
    if (elapsed >= this.hysteresisMinDurationMs) {
      const reason = `score_margin: ${marginPct.toFixed(1)}% for ${(elapsed / 60000).toFixed(0)}min`;
      logger.info(`LeaderSelector: Rotating to ${top.walletAddress.slice(0, 10)}... (${reason})`);
      this.setLeader(top, currentInNew, reason);
      this.candidateLeader = null;
      this.candidateSince = 0;
    } else {
      const remaining = ((this.hysteresisMinDurationMs - elapsed) / 60000).toFixed(0);
      logger.debug(`LeaderSelector: Rotation candidate holding for ${remaining}min more`);
    }

    return this.currentLeader;
  }

  private setLeader(newLeader: Leader, previousLeader: Leader | null, reason: string): void {
    const event: RotationEvent = {
      previousLeader,
      newLeader: { ...newLeader, isCurrentLeader: true },
      reason,
      timestamp: new Date().toISOString(),
    };

    this.currentLeader = { ...newLeader, isCurrentLeader: true };
    this.rotationHistory.push(event);

    if (this.onRotation) {
      try { this.onRotation(event); } catch (err) {
        logger.error(`LeaderSelector: rotation callback error: ${err}`);
      }
    }
  }

  getCurrentLeader(): Leader | null { return this.currentLeader; }

  /**
   * Return the top N ranked traders from the most recent leaderboard snapshot.
   * Already sorted by compositeScore descending (order from scorer.scoreAndRank).
   */
  getTopN(n: number): Leader[] {
    return this.lastScoredLeaders.slice(0, n);
  }

  getRotationHistory(): RotationEvent[] { return [...this.rotationHistory]; }

  getStats() {
    return {
      currentLeader: this.currentLeader?.walletAddress,
      currentScore: this.currentLeader?.compositeScore,
      candidateLeader: this.candidateLeader?.walletAddress,
      candidateSinceMs: this.candidateSince ? Date.now() - this.candidateSince : 0,
      totalRotations: this.rotationHistory.length,
    };
  }
}
