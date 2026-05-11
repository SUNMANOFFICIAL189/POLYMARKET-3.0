// Phase 2 v2 — screen candidates using /positions endpoint (true cashPnl+realizedPnl)
// instead of trade-derived closure detection.
//
// Why v2: v1 used `netShares ≈ 0` to flag "closed" positions, but Polymarket
// positions close via market RESOLUTION (no trade event), so v1's closure count
// was uniformly 0. The /positions endpoint exposes resolved-redeemable positions
// with full cashPnl + realizedPnl — the ground truth missing from the 2026-05-11
// baseline (which used Gamma /markets that silently omits resolved markets).
//
// Inputs:
//   _NEXT_STEPS/branch-3-phase1a-leaderboard.json
//   _NEXT_STEPS/branch-3-phase1b-watchlist-audit.json
//
// Filters (locked decisively — fixing v1's measurement bug, not goalpost-shifting):
//   - ≥15 geopolitics positions in /positions (broader politics filter, see GEO_KW)
//   - WR ≥55% based on (cashPnl + realizedPnl) > 0
//   - Median initialValue $10-$500 (avg too sensitive to whales)
//   - Active in last 14 days (newest trade via /trades)
//
// Output: _NEXT_STEPS/branch-3-phase2v2-shortlist.json
//
// Run: cd ~/Desktop/POLYMARKET_TRADING_3.0 && npx tsx scripts/research/phase2v2-screen-via-positions.ts

import { readFileSync, writeFileSync } from 'node:fs';

const DATA_API = 'https://data-api.polymarket.com';
const PHASE1A_IN = `${process.env.HOME}/Desktop/POLYMARKET_TRADING_3.0/_NEXT_STEPS/branch-3-phase1a-leaderboard.json`;
const PHASE1B_IN = `${process.env.HOME}/Desktop/POLYMARKET_TRADING_3.0/_NEXT_STEPS/branch-3-phase1b-watchlist-audit.json`;
const OUT = `${process.env.HOME}/Desktop/POLYMARKET_TRADING_3.0/_NEXT_STEPS/branch-3-phase2v2-shortlist.json`;

// Broader geopolitics keyword list — supplements the codebase categoriser which
// is missing Iran/Israel/Gaza/Netanyahu/Hezbollah/Taiwan and other major terms.
// This is the SAME definition Phase 3 will use (inline, not modifying prod code).
const GEO_KW = [
  // US politics & officials
  'election', 'president', 'congress', 'senate', 'house of representatives',
  'vote', 'ballot', 'democrat', 'republican', 'gop', 'biden', 'trump', 'harris',
  'obama', 'primary', 'caucus', 'swing state', 'white house', 'supreme court',
  'impeach', 'filibuster', 'cabinet', 'minister', 'governor', 'mayor',
  // International leaders
  'macron', 'scholz', 'sunak', 'starmer', 'modi', 'xi jinping', 'putin',
  'netanyahu', 'zelensky', 'erdogan', 'kim jong',
  // Geographies + flashpoints
  'iran', 'israel', 'gaza', 'palestine', 'hamas', 'hezbollah', 'lebanon',
  'syria', 'ukraine', 'russia', 'taiwan', 'china', 'north korea',
  'jerusalem', 'west bank', 'middle east', 'venezuela',
  // Topics
  'nato', 'un security', 'ceasefire', 'peace deal', 'sanctions', 'tariff',
  'trade war', 'g7', 'g20', 'parliament', 'referendum', 'coup',
  'invasion', 'occupation', 'strike',
  // Cabinet-specific (US 2025+)
  'lutnick', 'noem', 'rubio', 'hegseth', 'epstein',
  // Treaty / diplomacy
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
  size: number;
  avgPrice: number;
  initialValue: number;
  currentValue: number;
  cashPnl: number;
  percentPnl: number;
  realizedPnl: number;
  curPrice: number;
  redeemable: boolean;
  endDate?: string;
}

interface RawTrade {
  proxyWallet: string;
  timestamp: number;
}

async function fetchPositions(wallet: string): Promise<PolymarketPosition[]> {
  const url = `${DATA_API}/positions?user=${wallet}&limit=500`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return [];
    const data = (await res.json()) as PolymarketPosition[];
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

async function fetchNewestTradeTime(wallet: string): Promise<number | null> {
  // Cheap: first page of /trades returns the most recent trade first.
  const url = `${DATA_API}/trades?user=${wallet}&limit=1`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const data = (await res.json()) as RawTrade[];
    return Array.isArray(data) && data.length > 0 ? data[0].timestamp : null;
  } catch {
    return null;
  }
}

// Hard filters (locked)
const MIN_GEO_POSITIONS = 15;
const MIN_WR_PCT = 55;
const MIN_MEDIAN_SIZE = 10;
const MAX_MEDIAN_SIZE = 500;
const ACTIVE_WITHIN_H = 14 * 24;

interface CandidateAudit {
  wallet: string;
  source: string[];
  geoPositions: number;
  wins: number;
  losses: number;
  wrPct: number | null;
  totalTruePnl: number;
  totalInitialValue: number;
  medianInitialValue: number | null;
  meanInitialValue: number | null;
  minInitialValue: number | null;
  maxInitialValue: number | null;
  resolvedPositions: number;
  openPositions: number;
  newestTradeAge_h: number | null;
  topWinPnl: number | null;
  worstLossPnl: number | null;
  passes: boolean;
  rejections: string[];
}

function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

async function auditCandidate(wallet: string, sources: string[], nowSec: number): Promise<CandidateAudit> {
  const positions = await fetchPositions(wallet);
  await new Promise((r) => setTimeout(r, 50));
  const newestTradeSec = await fetchNewestTradeTime(wallet);
  await new Promise((r) => setTimeout(r, 50));

  const geoPositions = positions.filter((p) => isGeopolitics(p.title ?? ''));

  const withTruePnl = geoPositions.map((p) => ({
    ...p,
    truePnl: (p.cashPnl ?? 0) + (p.realizedPnl ?? 0),
    isResolved: p.redeemable === true || (p.curPrice === 0 && p.currentValue === 0),
  }));

  const wins = withTruePnl.filter((p) => p.truePnl > 0).length;
  const losses = withTruePnl.filter((p) => p.truePnl <= 0).length;
  const total = withTruePnl.length;
  const wrPct = total > 0 ? +((wins / total) * 100).toFixed(1) : null;
  const totalTrue = +withTruePnl.reduce((s, p) => s + p.truePnl, 0).toFixed(2);
  const totalInit = +withTruePnl.reduce((s, p) => s + (p.initialValue ?? 0), 0).toFixed(2);
  const initVals = withTruePnl.map((p) => p.initialValue ?? 0).filter((v) => v > 0);
  const med = median(initVals);
  const mean = initVals.length ? initVals.reduce((a, b) => a + b, 0) / initVals.length : null;
  const sortedTrue = [...withTruePnl].sort((a, b) => b.truePnl - a.truePnl);
  const topWin = sortedTrue[0]?.truePnl ?? null;
  const worstLoss = sortedTrue[sortedTrue.length - 1]?.truePnl ?? null;

  const newestAge_h = newestTradeSec ? +((nowSec - newestTradeSec) / 3600).toFixed(1) : null;

  const rejections: string[] = [];
  if (total < MIN_GEO_POSITIONS) rejections.push(`geo_positions<${MIN_GEO_POSITIONS} (got ${total})`);
  if (wrPct === null || wrPct < MIN_WR_PCT) rejections.push(`WR<${MIN_WR_PCT}% (got ${wrPct ?? 'n/a'}%)`);
  if (med === null || med < MIN_MEDIAN_SIZE) rejections.push(`median_size<$${MIN_MEDIAN_SIZE} (got $${med?.toFixed(2) ?? 'n/a'})`);
  if (med !== null && med > MAX_MEDIAN_SIZE) rejections.push(`median_size>$${MAX_MEDIAN_SIZE} (got $${med.toFixed(2)})`);
  if (newestAge_h === null || newestAge_h > ACTIVE_WITHIN_H) rejections.push(`inactive_>14d (newest ${newestAge_h ?? 'n/a'}h)`);

  return {
    wallet,
    source: sources,
    geoPositions: total,
    wins,
    losses,
    wrPct,
    totalTruePnl: totalTrue,
    totalInitialValue: totalInit,
    medianInitialValue: med ? +med.toFixed(2) : null,
    meanInitialValue: mean ? +mean.toFixed(2) : null,
    minInitialValue: initVals.length ? +Math.min(...initVals).toFixed(2) : null,
    maxInitialValue: initVals.length ? +Math.max(...initVals).toFixed(2) : null,
    resolvedPositions: withTruePnl.filter((p) => p.isResolved).length,
    openPositions: withTruePnl.filter((p) => !p.isResolved).length,
    newestTradeAge_h: newestAge_h,
    topWinPnl: topWin ? +topWin.toFixed(2) : null,
    worstLossPnl: worstLoss ? +worstLoss.toFixed(2) : null,
    passes: rejections.length === 0,
    rejections,
  };
}

async function main() {
  const nowSec = Math.floor(Date.now() / 1000);

  console.log('▸ Phase 2 v2 — screen via /positions endpoint (true P&L)');
  console.log(`  hard filters: geo_positions≥${MIN_GEO_POSITIONS} | WR≥${MIN_WR_PCT}% | median_size $${MIN_MEDIAN_SIZE}-$${MAX_MEDIAN_SIZE} | active≤14d`);
  console.log();

  const p1a = JSON.parse(readFileSync(PHASE1A_IN, 'utf-8'));
  const p1b = JSON.parse(readFileSync(PHASE1B_IN, 'utf-8'));

  const cands = new Map<string, string[]>();
  const addSrc = (w: string, s: string) => {
    const k = w.toLowerCase();
    const arr = cands.get(k) ?? [];
    if (!arr.includes(s)) arr.push(s);
    cands.set(k, arr);
  };
  for (const w of p1a.windows.Weekly.wallets) addSrc(w, 'leaderboard-Weekly');
  for (const w of p1a.windows.Monthly.wallets) addSrc(w, 'leaderboard-Monthly');
  for (const w of p1a.windows.All.wallets) addSrc(w, 'leaderboard-All');
  for (const a of p1b.audit) addSrc(a.wallet, 'watchlist');

  console.log(`  candidate pool: ${cands.size} unique wallets`);
  console.log();

  const results: CandidateAudit[] = [];
  let i = 0;
  for (const [wallet, sources] of cands) {
    i++;
    process.stdout.write(`  [${String(i).padStart(2)}/${cands.size}] ${wallet.slice(0, 12)}... `);
    const audit = await auditCandidate(wallet, sources, nowSec);
    results.push(audit);
    const marker = audit.passes ? '✅ PASS' : (audit.geoPositions >= 5 ? '◯' : '·');
    process.stdout.write(
      `geo=${String(audit.geoPositions).padStart(3)} WR=${(audit.wrPct ?? 'n/a').toString().padStart(5)}% truePnl=$${audit.totalTruePnl.toFixed(0).padStart(7)} medSz=$${(audit.medianInitialValue ?? 0).toFixed(0).padStart(5)} ${marker}\n`,
    );
  }

  const passing = results.filter((r) => r.passes).sort((a, b) => b.totalTruePnl - a.totalTruePnl);
  const interesting = results.filter((r) => !r.passes && r.geoPositions >= 5).sort((a, b) => b.totalTruePnl - a.totalTruePnl);
  const sleeping = results.filter((r) => !r.passes && r.geoPositions < 5);

  const output = {
    fetchedAt: new Date().toISOString(),
    method: '/positions endpoint, truePnl = cashPnl + realizedPnl, broader geopolitics keyword list (see scripts/research/phase2v2-screen-via-positions.ts:GEO_KW)',
    filters: {
      minGeoPositions: MIN_GEO_POSITIONS,
      minWrPct: MIN_WR_PCT,
      minMedianSize: MIN_MEDIAN_SIZE,
      maxMedianSize: MAX_MEDIAN_SIZE,
      activeWithinHours: ACTIVE_WITHIN_H,
    },
    candidatePoolSize: cands.size,
    shortlistSize: passing.length,
    shortlist: passing,
    interesting,
    sleeping: sleeping.length,
    summary: {
      passing: passing.length,
      interestingCount: interesting.length,
      sleepingCount: sleeping.length,
    },
  };

  writeFileSync(OUT, JSON.stringify(output, null, 2));

  console.log();
  console.log('=== SHORTLIST (passes all hard filters) ===');
  if (passing.length === 0) {
    console.log('  ❌ EMPTY');
  } else {
    for (const r of passing) {
      console.log(`  ${r.wallet}`);
      console.log(`    geo=${r.geoPositions} WR=${r.wrPct}% truePnl=$${r.totalTruePnl} medSize=$${r.medianInitialValue} resolved=${r.resolvedPositions} open=${r.openPositions} src=${r.source.join(',')}`);
      console.log(`    topWin=$${r.topWinPnl} worstLoss=$${r.worstLossPnl}`);
    }
  }
  console.log();
  console.log('=== INTERESTING (≥5 geo positions but failed ≥1 filter) ===');
  for (const r of interesting.slice(0, 15)) {
    console.log(`  ${r.wallet}  geo=${r.geoPositions} WR=${r.wrPct}% truePnl=$${r.totalTruePnl} medSize=$${r.medianInitialValue}`);
    console.log(`    REJECT: ${r.rejections.join(' | ')}`);
  }
  console.log();
  console.log(`saved → ${OUT}`);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
