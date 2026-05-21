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
 * Phase 1.4 revision (2026-05-21): tightened to Car only after soak-week-9
 * audit. balthazar, MRF, and unknown-near-miss all demoted to Tier-2 because:
 *   - balthazar: portfolio-longtail archetype (n=50+ open longshots in election
 *     baskets at $0.02 each). Single-trade copy of his trades is structurally
 *     unsound — we need basket replication to capture his edge. In the
 *     2026-05-12 → 2026-05-20 soak he produced 21 trades, 0 wins, -$144.
 *     His losses tripped the geopolitics drawdown circuit breaker at 14%,
 *     which then blocked Car's 100+ valid trades for 3 days straight.
 *   - MRF: portfolio-longtail but concentrated in SPORTS markets (FIFA, F1,
 *     Eurovision, Joshua). Phase 1.3 sports filter blocks his entire flow.
 *     0 trades executed in soak. Dead weight under current configuration.
 *   - unknown-near-miss: external realized P&L is -$68K, cash -$29K.
 *     Edge clearly decayed since the 2026-05-11 screening (the v4.3 OOS
 *     warning was right). Bleeding money in 3 trades during soak.
 *
 * Car remains active because his archetype (HIGH_CONVICTION / INFO_EDGE —
 * 100 positions, median $565, concentrated in 2028 election + Trump-Xi +
 * MicroStrategy + Iran flashpoints) is the textbook match for our existing
 * single-trade copy executor. He produced ~100+ valid signals during the
 * soak; every one was silently blocked by the tripped circuit breaker.
 *
 * Phase 1.4 also resets the geopolitics peakBalance so the breaker re-arms.
 * If Car re-trips it within 7 days, single-trade copy is the wrong
 * architecture entirely — see _NEXT_STEPS/build-plan-2026-05-16.md.
 *
 * Prior history retained in this file as Tier-2 entries for tracking only.
 */
export const TIER_1: GeopoliticsSpecialist[] = [
  {
    walletAddress: '0x7c3db723f1d4d8cb9c550095203b686cb11e5c6b',
    name: 'Car',
    tier: 1,
    wrPct: 61.2,
    truePnl: 61708,
    medianSize: 370,
    snapshotDate: SNAPSHOT_DATE,
  },
];

/**
 * Tier-2: tracked but NOT actively mirrored. Three cohorts:
 *
 * (a) Demoted from Tier-1 by Phase 1.4 (2026-05-21) — see header comment on
 *     TIER_1 above. Demoted for archetype mismatch (balthazar, MRF) or
 *     observed edge decay (unknown-near-miss).
 *
 * (b) Demoted from Tier-1 after Phase 2 v4 rigorous screening (2026-05-11)
 *     because they failed one or more v4 rules. Retained here so the future
 *     Phase A weekly diff alert (BACKLOG item) can re-promote them if
 *     observed performance recovers.
 *
 * (c) Original Phase 2 v3 near-misses with marginal P&L or unstable signal.
 *     Less interesting than (b) but kept for completeness.
 */
export const TIER_2: GeopoliticsSpecialist[] = [
  // (a) Demoted from Tier-1 by Phase 1.4 (2026-05-21) — see TIER_1 header.
  {
    // Portfolio-longtail archetype: 50+ open positions, 74% at <$0.05 entry,
    // concentrated in election baskets (Peruvian, BC, Daegu, Israel PM).
    // Single-trade copy of his trades is structurally unsound. Net -$144
    // across 21 trades in 9-day soak; losses tripped the geopolitics
    // drawdown breaker which then blocked Car's signal for 3 days.
    // Re-promote only after basket-replication architecture is built.
    walletAddress: '0x5a218c7ad04135830a45c41aaed7294df7809318',
    name: 'balthazar',
    tier: 2,
    wrPct: 67.9,
    truePnl: 258654,
    medianSize: 78,
    snapshotDate: SNAPSHOT_DATE,
  },
  {
    // External realized P&L -$68K, cash P&L -$29K = -$97K combined position.
    // The 2026-05-11 v4.3 OOS-warning ("failed by a thin margin") was right;
    // observed performance has since confirmed it. 3 trades in 9-day soak,
    // 0 wins, -$22. Re-promote only after fresh screening shows recovery.
    walletAddress: '0x44c1dfe43260c94ed4f1d00de2e1f80fb113ebc1',
    name: 'unknown-near-miss',
    tier: 2,
    wrPct: 46.7,
    truePnl: 20586,
    medianSize: 139,
    snapshotDate: SNAPSHOT_DATE,
  },
  {
    // Portfolio-longtail concentrated in SPORTS (30 FIFA, 19 election 2028,
    // 7 Eurovision, 4 Joshua boxing — realized +$551K mostly from sports).
    // Phase 1.3 sports filter blocks every market he trades. Zero contribution
    // to bot. Re-promote only after (a) a per-wallet sports allowlist exists
    // AND (b) basket-replication architecture handles his longtail style.
    walletAddress: '0x16cbe223607a6513ae76d1e3751c78e4eabc2704',
    name: 'MRF',
    tier: 2,
    wrPct: 73.8,
    truePnl: 695803,
    medianSize: 71,
    snapshotDate: SNAPSHOT_DATE,
  },

  // (b) Demoted from Tier-1 by Phase 2 v4 (2026-05-11).
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
