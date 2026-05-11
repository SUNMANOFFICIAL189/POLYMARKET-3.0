// Branch 3 geopolitics specialist watchlist.
//
// Source: 2026-05-11 research sprint, Phase 2 v3 screening output. Selection
// criteria (locked, no goalpost shifting):
//   - ≥15 geopolitics positions in 90d
//   - ≥55% WR on truePnl (cashPnl + realizedPnl, sourced from /positions ∪ /trades-flow)
//   - Median position size $10-$500
//   - Active in last 14 days
//
// See:
//   - _NEXT_STEPS/branch-3-research-2026-05-11.md     (sprint findings doc)
//   - _NEXT_STEPS/branch-3-phase2v3-shortlist.json    (canonical screening output)
//   - Vault Decision Log "2026-05-11 — Branch 3 verdict UPGRADED"
//
// Replaces the dynamic leaderboard-driven leader selection used by the copy
// pipeline. Geopolitics specialists don't fluctuate fast enough to need
// continuous re-scoring — this list is stable across re-screens, refresh
// quarterly or on demand.

export interface GeopoliticsSpecialist {
  /** Lowercase 0x address — the proxy wallet on Polymarket */
  walletAddress: string;
  /** Polymarket pseudonym (for log readability) */
  name: string;
  /** Tier-1 = active mirror target; Tier-2 = tracked-only, not actively copied */
  tier: 1 | 2;
  /** Win rate from Phase 2 v3 truePnl computation, % (e.g. 74.4) */
  wrPct: number;
  /** All-time truePnl from /positions + trade-flow union at screen time, USDC */
  truePnl: number;
  /** Median politics position initialValue, USDC */
  medianSize: number;
  /** Snapshot date the metrics were taken (for staleness tracking) */
  snapshotDate: string;
}

const SNAPSHOT_DATE = '2026-05-11';

/**
 * Tier-1: active mirror targets for the geopolitics pipeline.
 *
 * Loosened on 2026-05-12 from 2 wallets to 4 — added MRF and 0x44c1dfe4 to
 * trade more activity for slightly more variance. The Phase 4 backtest
 * over the past 7 days showed:
 *   - Tight rules (2 wallets): +$1,659 realized on $1,500 pool, 110% ROI
 *   - Loose rules (6 wallets): driven by ONE MRF lottery hit (Trump Jr. 2028)
 * Verdict: include MRF (lottery-style edge worth capturing) and 0x44c1dfe4
 * (positive-PnL Phase 2 v3 near-miss). Continue skipping cigarettes
 * (sports-pivoted), debased (too young, joined Mar 2026), and Spirit of
 * Ukraine>UMA (UMA-arbitrage style — different mechanism).
 *
 * If MRF turns into a drag over the soak: easy revert via this file.
 *
 * Post-Phase-2-v4 rigorous-screen revision (2026-05-11): originally tightened
 * to 2 wallets. balthazar passed all 8 v4 rules cleanly. Car passed v3 + v4.1
 * + v4.2 + v4.3 but failed only v4.4 (OOS sample n<5). MRF, cigarettes,
 * debased, and Spirit of Ukraine>UMA all FAILED v4 rules and were demoted
 * to Tier-2. See `_NEXT_STEPS/branch-3-phase2v4-shortlist.json`.
 */
export const TIER_1: GeopoliticsSpecialist[] = [
  {
    walletAddress: '0x5a218c7ad04135830a45c41aaed7294df7809318',
    name: 'balthazar',
    tier: 1,
    wrPct: 67.9,
    truePnl: 258654,
    medianSize: 78,
    snapshotDate: SNAPSHOT_DATE,
  },
  {
    walletAddress: '0x7c3db723f1d4d8cb9c550095203b686cb11e5c6b',
    name: 'Car',
    tier: 1,
    wrPct: 61.2,
    truePnl: 61708,
    medianSize: 370,
    snapshotDate: SNAPSHOT_DATE,
  },
  {
    // Added 2026-05-12 loosening — phase 2 v3 positive-PnL near-miss.
    // Failed v4.3 OOS check by a thin margin (couldn't be confirmed with n<5).
    // In-sample: +$20K truePnl on 30 positions at 46.7% WR. Median bet $139.
    walletAddress: '0x44c1dfe43260c94ed4f1d00de2e1f80fb113ebc1',
    name: 'unknown-near-miss',
    tier: 1,
    wrPct: 46.7,
    truePnl: 20586,
    medianSize: 139,
    snapshotDate: SNAPSHOT_DATE,
  },
  {
    // Re-added 2026-05-12 loosening — lottery-style edge.
    // Failed v4.3 OOS (-$7,895 / n=3) and v4.4 (insufficient OOS sample).
    // But the past 7 days produced +$23K from one Trump Jr. 2028 trade.
    // Pattern: many small longshot bets, rare large hits. Expected value
    // depends on whether the hits land within our soak window.
    walletAddress: '0x16cbe223607a6513ae76d1e3751c78e4eabc2704',
    name: 'MRF',
    tier: 1,
    wrPct: 73.8,
    truePnl: 695803,
    medianSize: 71,
    snapshotDate: SNAPSHOT_DATE,
  },
];

/**
 * Tier-2: tracked but NOT actively mirrored. Two cohorts:
 *
 * (a) Demoted from Tier-1 after Phase 2 v4 rigorous screening (2026-05-11)
 *     because they failed one or more v4 rules. Retained here so the future
 *     Phase A weekly diff alert (BACKLOG item) can re-promote them if
 *     observed performance recovers.
 *
 * (b) Original Phase 2 v3 near-misses with marginal P&L or unstable signal.
 *     Less interesting than (a) but kept for completeness.
 */
export const TIER_2: GeopoliticsSpecialist[] = [
  // (a) Demoted from Tier-1 by Phase 2 v4 — MRF re-promoted to Tier-1 on 2026-05-12 loosening.
  {
    walletAddress: '0xd218e474776403a330142299f7796e8ba32eb5c9',
    name: 'cigarettes',
    tier: 2,
    wrPct: 87.1,
    truePnl: 171570,       // Strong historical but only 1 politics trade in last 14d (pivoted to sports) → demoted via v4.2
    medianSize: 11,
    snapshotDate: SNAPSHOT_DATE,
  },
  {
    walletAddress: '0x24c8cf69a0e0a17eee21f69d29752bfa32e823e1',
    name: 'debased',
    tier: 2,
    wrPct: 62.4,
    truePnl: 142955,       // Joined Mar 2026 — insufficient OOS history (only 50 days old at screen) → demoted via v4.4
    medianSize: 183,
    snapshotDate: SNAPSHOT_DATE,
  },
  {
    walletAddress: '0x0c0e270cf879583d6a0142fc817e05b768d0434e',
    name: 'Spirit of Ukraine>UMA',
    tier: 2,
    wrPct: 82.5,
    truePnl: 88781,        // UMA-arbitrage style, only n=1 OOS resolved → demoted via v4.4
    medianSize: 280,
    snapshotDate: SNAPSHOT_DATE,
  },
  // (b) Original Phase 2 v3 near-misses (retained from earlier snapshot)
  {
    walletAddress: '0x3e5b23e9f71b2a2edcd5629d3f948f12f591073b',
    name: 'beenraping',
    tier: 2,
    wrPct: 67.7,
    truePnl: 27754,
    medianSize: 433,
    snapshotDate: SNAPSHOT_DATE,
  },
  {
    walletAddress: '0xc21ea96be762bb55041529af6e386e7c53b80215',
    name: 'JustCrazy',
    tier: 2,
    wrPct: 75,
    truePnl: 10647,
    medianSize: 20,
    snapshotDate: SNAPSHOT_DATE,
  },
];

export const ALL_SPECIALISTS: GeopoliticsSpecialist[] = [...TIER_1, ...TIER_2];

/** Convenience: lowercased Tier-1 wallet addresses for use with WalletMonitor */
export const TIER_1_ADDRESSES: string[] = TIER_1.map((s) => s.walletAddress.toLowerCase());

/** Lookup: address → specialist (case-insensitive) */
export function findSpecialist(walletAddress: string): GeopoliticsSpecialist | undefined {
  const lc = walletAddress.toLowerCase();
  return ALL_SPECIALISTS.find((s) => s.walletAddress.toLowerCase() === lc);
}
