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
 * Post-Phase-2-v4 rigorous-screen revision (2026-05-11): tightened from 6
 * wallets to 2. balthazar passed all 8 v4 rules cleanly. Car passed v3 + v4.1
 * + v4.2 + v4.3 but failed only v4.4 (OOS sample n<5) — promoted to Tier-1
 * for the paper soak because (a) bounded downside in paper mode, (b)
 * meaningful in-sample track record (+$62K, 61% WR on 85 positions), (c)
 * adds diversification + signal volume vs single-wallet concentration risk.
 *
 * MRF, cigarettes, debased, and Spirit of Ukraine>UMA all FAILED v4 rules
 * and were demoted to Tier-2. See `_NEXT_STEPS/branch-3-phase2v4-shortlist.json`
 * for per-wallet rejection reasons.
 */
export const TIER_1: GeopoliticsSpecialist[] = [
  {
    walletAddress: '0x5a218c7ad04135830a45c41aaed7294df7809318',
    name: 'balthazar',
    tier: 1,
    wrPct: 67.9,           // Updated from v3 (62.7%) — v4 measurement on 321 positions
    truePnl: 258654,       // Updated from v3 ($236K) — v4 measurement
    medianSize: 78,        // Updated from v3 ($88) — v4 measurement
    snapshotDate: SNAPSHOT_DATE,
  },
  {
    walletAddress: '0x7c3db723f1d4d8cb9c550095203b686cb11e5c6b',
    name: 'Car',
    tier: 1,
    wrPct: 61.2,           // 85 positions
    truePnl: 61708,
    medianSize: 370,
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
  // (a) Demoted from Tier-1 by Phase 2 v4
  {
    walletAddress: '0x16cbe223607a6513ae76d1e3751c78e4eabc2704',
    name: 'MRF',
    tier: 2,
    wrPct: 73.8,
    truePnl: 695803,       // Massive historical, but recent 90d was -$8K and OOS was -$7,895 on n=3 → demoted
    medianSize: 71,
    snapshotDate: SNAPSHOT_DATE,
  },
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
