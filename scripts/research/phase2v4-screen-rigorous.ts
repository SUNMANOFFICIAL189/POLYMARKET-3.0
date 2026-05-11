// Phase 2 v4 — rigorous screener with rule set extracted from the 2026-05-11
// sprint observations. Pulls Phase B forward from "mid-soak" to "pre-deploy"
// after the out-of-sample test surfaced wallets that passed v3 filters but
// looked weak under cleaner measurement (BACKLOG: "Branch 3 Tier-1
// auto-promotion loop — Phase B").
//
// Inputs:
//   _NEXT_STEPS/branch-3-phase1a-v2-politics.json   (134 wallets, politics leaderboard)
//   _NEXT_STEPS/branch-3-phase1b-watchlist-audit.json (legacy 11 watchlist)
//
// Rules (v3 carried forward + 4 v4 additions, all hard filters):
//   v3.1  geo positions ≥15
//   v3.2  WR ≥55% on truePnl > 0
//   v3.3  median initialValue $10-$500
//   v3.4  active in last 14 days (any trade)
//   v4.1  overall truePnl > 0 (explicit — was implicit at 55% WR, but
//                              `yyyy77777` showed it could pass WR while losing money)
//   v4.2  ≥1 POLITICS trade in last 14 days (active in politics specifically;
//                                            catches `cigarettes` pivot to sports)
//   v4.3  OOS truePnl > 0 on positions resolved 60+ days ago
//                                            (catches `MRF`, `Car`, `debased` —
//                                            in-sample winners that were weak OOS)
//   v4.4  OOS sample n ≥ 5
//                                            (below 5 the OOS signal is noise)
//
// Output: _NEXT_STEPS/branch-3-phase2v4-shortlist.json
//   { shortlist: [...wallets passing all 8 rules],
//     tier_2: [...passing v3 but missing v4.3 due to insufficient OOS sample (young wallets)],
//     rejected: [...failing >=1 hard rule],
//     summary: { passing, tier2, rejected } }
//
// Run: cd ~/Desktop/POLYMARKET_TRADING_3.0 && npx tsx scripts/research/phase2v4-screen-rigorous.ts

import { readFileSync, writeFileSync } from 'node:fs';

const DATA_API = 'https://data-api.polymarket.com';
const P1A_V2 = `${process.env.HOME}/Desktop/POLYMARKET_TRADING_3.0/_NEXT_STEPS/branch-3-phase1a-v2-politics.json`;
const P1B = `${process.env.HOME}/Desktop/POLYMARKET_TRADING_3.0/_NEXT_STEPS/branch-3-phase1b-watchlist-audit.json`;
const OUT = `${process.env.HOME}/Desktop/POLYMARKET_TRADING_3.0/_NEXT_STEPS/branch-3-phase2v4-shortlist.json`;

// Same broader geopolitics keyword set used in v3 + now in prod categoriser
const GEO_KW = [
  'election', 'president', 'congress', 'senate', 'house of representatives',
  'vote', 'ballot', 'democrat', 'republican', 'gop', 'biden', 'trump', 'harris',
  'obama', 'primary', 'caucus', 'swing state', 'white house', 'supreme court',
  'impeach', 'filibuster', 'cabinet', 'minister', 'governor', 'mayor',
  'macron', 'scholz', 'sunak', 'starmer', 'modi', 'xi jinping', 'putin',
  'netanyahu', 'zelensky', 'erdogan', 'kim jong',
  'iran', 'israel', 'gaza', 'palestine', 'hamas', 'hezbollah', 'lebanon',
  'syria', 'ukraine', 'russia', 'taiwan', 'china', 'north korea',
  'jerusalem', 'west bank', 'middle east', 'venezuela',
  'nato', 'un security', 'ceasefire', 'peace deal', 'sanctions', 'tariff',
  'trade war', 'g7', 'g20', 'parliament', 'referendum',
  'lutnick', 'noem', 'rubio', 'hegseth', 'epstein',
  'treaty', 'embassy', 'ambassador', 'diplomatic',
];
function isGeopolitics(title: string): boolean {
  const t = (title || '').toLowerCase();
  return GEO_KW.some((kw) => t.includes(kw));
}

interface PolymarketPosition {
  proxyWallet: string;
  conditionId: string;
  outcomeIndex: number;
  title?: string;
  cashPnl: number;
  realizedPnl: number;
  initialValue?: number;
  curPrice?: number;
  currentValue?: number;
  redeemable?: boolean;
  endDate?: string;
}

interface RawTrade {
  proxyWallet: string;
  side: 'BUY' | 'SELL';
  conditionId?: string;
  size: number;
  price: number;
  timestamp: number;
  title?: string;
  outcomeIndex?: number;
}

async function fetchPositions(wallet: string): Promise<PolymarketPosition[]> {
  try {
    const res = await fetch(`${DATA_API}/positions?user=${wallet}&limit=500`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

async function fetchRecentTrades(wallet: string, hardLimit = 500): Promise<RawTrade[]> {
  try {
    const res = await fetch(`${DATA_API}/trades?user=${wallet}&limit=${hardLimit}`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

// Hard filters
const MIN_GEO_POSITIONS = 15;
const MIN_WR_PCT = 55;
const MIN_MEDIAN_SIZE = 10;
const MAX_MEDIAN_SIZE = 500;
const ACTIVE_WITHIN_H = 14 * 24;
// v4 additions
const MIN_OOS_RESOLVED_N = 5;
const OOS_RESOLVED_CUTOFF_DAYS = 60;

interface Audit {
  wallet: string;
  source: string[];
  leaderboardName?: string;
  leaderboardBestRank?: number;
  leaderboardMaxPnl?: number;
  // v3 metrics
  geoPositions: number;
  wins: number;
  losses: number;
  wrPct: number | null;
  truePnlOverall: number;
  medianInitialValue: number | null;
  newestTradeAge_h: number | null;
  // v4 metrics
  politicsTradesLast14d: number;
  newestPoliticsTradeAge_h: number | null;
  oosResolvedCount: number;
  oosTruePnl: number;
  // Verdict
  tier: 'shortlist' | 'tier_2' | 'rejected';
  rejections: string[];
}

function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

async function auditWallet(
  wallet: string,
  sources: string[],
  lbName: string | undefined,
  lbRank: number | undefined,
  lbPnl: number | undefined,
  nowSec: number,
): Promise<Audit> {
  const [positions, recentTrades] = await Promise.all([
    fetchPositions(wallet),
    fetchRecentTrades(wallet, 500),
  ]);

  // ─── Politics positions (from /positions) ───
  const geoPositions = positions.filter((p) => isGeopolitics(p.title ?? ''));
  const truePnl = geoPositions.map((p) => ({
    ...p,
    truePnl: (p.cashPnl ?? 0) + (p.realizedPnl ?? 0),
  }));
  const wins = truePnl.filter((p) => p.truePnl > 0).length;
  const losses = truePnl.filter((p) => p.truePnl <= 0).length;
  const total = truePnl.length;
  const wrPct = total > 0 ? +((wins / total) * 100).toFixed(1) : null;
  const truePnlOverall = +truePnl.reduce((s, p) => s + p.truePnl, 0).toFixed(2);

  const initVals = truePnl.map((p) => p.initialValue ?? 0).filter((v) => v > 0);
  const med = median(initVals);

  // ─── Activity ───
  const newestTradeSec = recentTrades.length > 0 ? recentTrades[0].timestamp : null;
  const newestAge_h = newestTradeSec ? +((nowSec - newestTradeSec) / 3600).toFixed(1) : null;

  // ─── v4.2: politics trades in last 14 days ───
  const cutoff14d = nowSec - 14 * 86400;
  const politicsTradesLast14d = recentTrades.filter(
    (t) => t.timestamp >= cutoff14d && isGeopolitics(t.title ?? ''),
  ).length;
  const newestPoliticsTrade = recentTrades.find((t) => isGeopolitics(t.title ?? ''));
  const newestPoliticsAge_h = newestPoliticsTrade
    ? +((nowSec - newestPoliticsTrade.timestamp) / 3600).toFixed(1)
    : null;

  // ─── v4.3/4.4: OOS test on resolved positions ───
  const oosCutoff = nowSec - OOS_RESOLVED_CUTOFF_DAYS * 86400;
  const oosResolved = truePnl.filter((p) => {
    if (!p.endDate) return false;
    const ts = Date.parse(p.endDate.includes('T') ? p.endDate : `${p.endDate}T23:59:59Z`) / 1000;
    return ts < oosCutoff;
  });
  const oosResolvedCount = oosResolved.length;
  const oosTruePnl = +oosResolved.reduce((s, p) => s + p.truePnl, 0).toFixed(2);

  // ─── Apply rules ───
  const rejections: string[] = [];
  // v3 rules
  if (total < MIN_GEO_POSITIONS) rejections.push(`v3.1 geo<${MIN_GEO_POSITIONS} (got ${total})`);
  if (wrPct === null || wrPct < MIN_WR_PCT) rejections.push(`v3.2 WR<${MIN_WR_PCT}% (got ${wrPct ?? 'n/a'}%)`);
  if (med === null || med < MIN_MEDIAN_SIZE) rejections.push(`v3.3 medSize<$${MIN_MEDIAN_SIZE} (got $${med?.toFixed(2) ?? 'n/a'})`);
  if (med !== null && med > MAX_MEDIAN_SIZE) rejections.push(`v3.3 medSize>$${MAX_MEDIAN_SIZE} (got $${med.toFixed(2)})`);
  if (newestAge_h === null || newestAge_h > ACTIVE_WITHIN_H) rejections.push(`v3.4 inactive (newest ${newestAge_h ?? 'n/a'}h)`);
  // v4 rules
  if (truePnlOverall <= 0) rejections.push(`v4.1 truePnl≤0 (got $${truePnlOverall})`);
  if (politicsTradesLast14d < 1) rejections.push(`v4.2 no politics trade in 14d (got ${politicsTradesLast14d})`);
  if (oosTruePnl <= 0) rejections.push(`v4.3 OOS truePnl≤0 (got $${oosTruePnl} on n=${oosResolvedCount})`);
  if (oosResolvedCount < MIN_OOS_RESOLVED_N) rejections.push(`v4.4 OOS n<${MIN_OOS_RESOLVED_N} (got ${oosResolvedCount})`);

  // ─── Tier assignment ───
  // Shortlist = passes ALL rules
  // Tier-2 = passes v3 rules + v4.1 + v4.2 + v4.3 BUT fails v4.4 only (young wallet — needs more time)
  let tier: Audit['tier'];
  if (rejections.length === 0) {
    tier = 'shortlist';
  } else {
    const v3Pass = !rejections.some((r) => r.startsWith('v3.'));
    const v4_1_pass = !rejections.some((r) => r.startsWith('v4.1'));
    const v4_2_pass = !rejections.some((r) => r.startsWith('v4.2'));
    const v4_3_pass = !rejections.some((r) => r.startsWith('v4.3'));
    const v4_4_fail = rejections.some((r) => r.startsWith('v4.4'));
    if (v3Pass && v4_1_pass && v4_2_pass && v4_3_pass && v4_4_fail && rejections.length === 1) {
      tier = 'tier_2'; // young-wallet promotion candidate (OOS positive but tiny sample)
    } else {
      tier = 'rejected';
    }
  }

  return {
    wallet,
    source: sources,
    leaderboardName: lbName,
    leaderboardBestRank: lbRank,
    leaderboardMaxPnl: lbPnl,
    geoPositions: total,
    wins,
    losses,
    wrPct,
    truePnlOverall,
    medianInitialValue: med ? +med.toFixed(2) : null,
    newestTradeAge_h: newestAge_h,
    politicsTradesLast14d,
    newestPoliticsTradeAge_h: newestPoliticsAge_h,
    oosResolvedCount,
    oosTruePnl,
    tier,
    rejections,
  };
}

async function main() {
  const nowSec = Math.floor(Date.now() / 1000);

  console.log('▸ Phase 2 v4 — rigorous screener (pulls Phase B forward)');
  console.log(`  rules: v3 carried forward + v4.1 truePnl>0 + v4.2 14d-politics-active + v4.3 OOS truePnl>0 + v4.4 OOS n≥${MIN_OOS_RESOLVED_N}`);
  console.log(`  OOS window: positions resolved >${OOS_RESOLVED_CUTOFF_DAYS}d ago`);
  console.log();

  const p1a = JSON.parse(readFileSync(P1A_V2, 'utf-8'));
  const p1b = JSON.parse(readFileSync(P1B, 'utf-8'));

  interface CandSrc { sources: string[]; lbName?: string; lbRank?: number; lbPnl?: number }
  const cands = new Map<string, CandSrc>();
  for (const w of p1a.uniqueWallets) {
    const meta = p1a.walletMeta[w];
    cands.set(w.toLowerCase(), {
      sources: ['politics-leaderboard'],
      lbName: meta?.pseudonym ?? meta?.name,
      lbRank: meta?.bestRank,
      lbPnl: meta?.maxPnl,
    });
  }
  for (const a of p1b.audit) {
    const w = a.wallet.toLowerCase();
    const c = cands.get(w) ?? { sources: [] as string[] };
    if (!c.sources.includes('watchlist')) c.sources.push('watchlist');
    cands.set(w, c);
  }

  console.log(`  candidate pool: ${cands.size} unique wallets`);
  console.log();

  const results: Audit[] = [];
  let i = 0;
  for (const [wallet, { sources, lbName, lbRank, lbPnl }] of cands) {
    i++;
    process.stdout.write(`  [${String(i).padStart(3)}/${cands.size}] ${wallet.slice(0, 12)}... `);
    const audit = await auditWallet(wallet, sources, lbName, lbRank, lbPnl, nowSec);
    results.push(audit);
    const marker = audit.tier === 'shortlist' ? '✅' : audit.tier === 'tier_2' ? '◐' : '·';
    process.stdout.write(
      `geo=${String(audit.geoPositions).padStart(3)} WR=${(audit.wrPct ?? 'n/a').toString().padStart(5)}% truePnl=$${audit.truePnlOverall.toFixed(0).padStart(7)} pol14d=${String(audit.politicsTradesLast14d).padStart(3)} OOS=${audit.oosResolvedCount}/$${audit.oosTruePnl.toFixed(0)} ${marker}\n`,
    );
  }

  const shortlist = results.filter((r) => r.tier === 'shortlist').sort((a, b) => b.truePnlOverall - a.truePnlOverall);
  const tier2 = results.filter((r) => r.tier === 'tier_2').sort((a, b) => b.truePnlOverall - a.truePnlOverall);

  const output = {
    fetchedAt: new Date().toISOString(),
    rules: {
      v3_1_min_geo_positions: MIN_GEO_POSITIONS,
      v3_2_min_wr_pct: MIN_WR_PCT,
      v3_3_median_size_range: [MIN_MEDIAN_SIZE, MAX_MEDIAN_SIZE],
      v3_4_active_within_hours: ACTIVE_WITHIN_H,
      v4_1: 'overall truePnl > 0',
      v4_2: 'at least 1 politics trade in last 14d',
      v4_3: 'OOS truePnl > 0 on positions resolved >60d ago',
      v4_4_min_oos_resolved_n: MIN_OOS_RESOLVED_N,
    },
    candidatePoolSize: cands.size,
    shortlist,
    tier2,
    rejectedCount: results.filter((r) => r.tier === 'rejected').length,
    summary: {
      shortlist: shortlist.length,
      tier_2: tier2.length,
      rejected: results.filter((r) => r.tier === 'rejected').length,
    },
  };

  writeFileSync(OUT, JSON.stringify(output, null, 2));

  console.log();
  console.log('=== SHORTLIST (passes ALL 8 rules) ===');
  if (shortlist.length === 0) {
    console.log('  ❌ EMPTY');
  } else {
    for (const r of shortlist) {
      console.log(`  ${r.wallet} (${r.leaderboardName ?? '?'})`);
      console.log(`    geo=${r.geoPositions} WR=${r.wrPct}% truePnl=$${r.truePnlOverall} medSize=$${r.medianInitialValue}`);
      console.log(`    politics14d=${r.politicsTradesLast14d} newestPolitics=${r.newestPoliticsTradeAge_h}h`);
      console.log(`    OOS resolved n=${r.oosResolvedCount} truePnl=$${r.oosTruePnl}`);
    }
  }
  console.log();
  console.log('=== TIER-2 (passes all except OOS n threshold — young wallets, watch for promotion) ===');
  for (const r of tier2.slice(0, 10)) {
    console.log(`  ${r.wallet} (${r.leaderboardName ?? '?'})`);
    console.log(`    geo=${r.geoPositions} WR=${r.wrPct}% truePnl=$${r.truePnlOverall} OOS n=${r.oosResolvedCount}/$${r.oosTruePnl}`);
  }
  console.log();
  console.log(`saved → ${OUT}`);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
