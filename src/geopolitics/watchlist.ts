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
 * Each entry passed all 4 locked Phase 2 v3 filters with comfortable margin.
 */
export const TIER_1: GeopoliticsSpecialist[] = [
  {
    walletAddress: '0x16cbe223607a6513ae76d1e3751c78e4eabc2704',
    name: 'MRF',
    tier: 1,
    wrPct: 74.4,
    truePnl: 695808,
    medianSize: 71,
    snapshotDate: SNAPSHOT_DATE,
  },
  {
    walletAddress: '0x5a218c7ad04135830a45c41aaed7294df7809318',
    name: 'balthazar',
    tier: 1,
    wrPct: 62.7,
    truePnl: 236718,
    medianSize: 88,
    snapshotDate: SNAPSHOT_DATE,
  },
  {
    walletAddress: '0xd218e474776403a330142299f7796e8ba32eb5c9',
    name: 'cigarettes',
    tier: 1,
    wrPct: 86.9,
    truePnl: 172015,
    medianSize: 11,
    snapshotDate: SNAPSHOT_DATE,
  },
  {
    walletAddress: '0x24c8cf69a0e0a17eee21f69d29752bfa32e823e1',
    name: 'debased',
    tier: 1,
    wrPct: 62.4,
    truePnl: 142955,
    medianSize: 183,
    snapshotDate: SNAPSHOT_DATE,
  },
  {
    walletAddress: '0x0c0e270cf879583d6a0142fc817e05b768d0434e',
    name: 'Spirit of Ukraine>UMA',
    tier: 1,
    wrPct: 82.5,
    truePnl: 88781,
    medianSize: 280,
    snapshotDate: SNAPSHOT_DATE,
  },
  {
    walletAddress: '0x7c3db723f1d4d8cb9c550095203b686cb11e5c6b',
    name: 'Car',
    tier: 1,
    wrPct: 61.3,
    truePnl: 62815,
    medianSize: 370,
    snapshotDate: SNAPSHOT_DATE,
  },
];

/**
 * Tier-2: passed the filters but with smaller absolute P&L, marginal WR, or
 * inactivity flags. Tracked separately — NOT actively mirrored in the v1
 * geopolitics pipeline. Candidates for promotion after 30-day paper soak
 * shows Tier-1 working as expected.
 */
export const TIER_2: GeopoliticsSpecialist[] = [
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
  {
    walletAddress: '0xd6ddc6559313bcc819f1df1b3647f3930da998ee',
    name: 'SaintPascal',
    tier: 2,
    wrPct: 64.5,
    truePnl: 2151,
    medianSize: 116,
    snapshotDate: SNAPSHOT_DATE,
  },
  {
    walletAddress: '0x4a650133a506a876352f8e8021ec3d220dab06bb',
    name: '.sorry',
    tier: 2,
    wrPct: 69,
    truePnl: 1066,
    medianSize: 396,
    snapshotDate: SNAPSHOT_DATE,
  },
  {
    walletAddress: '0x15f7ddbc6ffe08722ddeb64d51e58aef7b8ca018',
    name: 'idkwhatimdoinggg',
    tier: 2,
    wrPct: 70.8,
    truePnl: 753,
    medianSize: 99,
    snapshotDate: SNAPSHOT_DATE,
  },
  {
    // On the bubble — passed filters but truePnl is negative on the latest
    // snapshot. Re-evaluate at the 30-day soak gate; demote if it stays negative.
    walletAddress: '0x0a543bb97015206f67e1bc5ead7c2d60baf64a03',
    name: 'yyyy77777yyyyy777yyy',
    tier: 2,
    wrPct: 55,
    truePnl: -13484,
    medianSize: 101,
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
