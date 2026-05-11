// Phase 2 v3 — screen candidates by combining /positions + /trades-flow signals.
//
// v2 used /positions alone — perfect for buy-and-hold-to-resolution wallets
// (e.g. 0x5d05b1f5, 0x24c8cf69) but blind to sell-out wallets (e.g.
// CreamCream1215 — exits before resolution, /positions reports near-empty).
//
// v3 unions both signals per (conditionId, outcomeIndex):
//   - If position exists in /positions: truePnl = cashPnl + realizedPnl
//   - Else if /trades shows full exit (|netShares| < 1): truePnl = sum_sells - sum_buys
//   - Else (still holding, not in /positions): skip (no MTM accessible)
//
// Closes the substantive part of BACKLOG bug #2 from the 2026-05-11 sprint.
//
// Inputs:
//   _NEXT_STEPS/branch-3-phase1a-v2-politics.json   (134 wallets from leaderboard API)
//   _NEXT_STEPS/branch-3-phase1b-watchlist-audit.json (11 watchlist wallets, for union)
//
// Filters (locked, same as v2):
//   - ≥15 geopolitics positions
//   - WR ≥55% based on truePnl > 0
//   - Median initialValue $10–$500
//   - Active in last 14 days
//
// Output: _NEXT_STEPS/branch-3-phase2v3-shortlist.json
//
// Run: cd ~/Desktop/POLYMARKET_TRADING_3.0 && npx tsx scripts/research/phase2v3-screen-combined.ts

import { readFileSync, writeFileSync } from 'node:fs';

const DATA_API = 'https://data-api.polymarket.com';
const P1A_V2 = `${process.env.HOME}/Desktop/POLYMARKET_TRADING_3.0/_NEXT_STEPS/branch-3-phase1a-v2-politics.json`;
const P1B = `${process.env.HOME}/Desktop/POLYMARKET_TRADING_3.0/_NEXT_STEPS/branch-3-phase1b-watchlist-audit.json`;
const OUT = `${process.env.HOME}/Desktop/POLYMARKET_TRADING_3.0/_NEXT_STEPS/branch-3-phase2v3-shortlist.json`;

// Same broader geopolitics keyword set used in Phase 2 v2 + now in the
// production categoriser (BACKLOG bug 1 fix landed 2026-05-11 commit 511a8d4).
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
  size: number;
  initialValue?: number;
  cashPnl: number;
  realizedPnl: number;
  curPrice: number;
  redeemable: boolean;
  endDate?: string;
}

interface RawTrade {
  proxyWallet: string;
  side: 'BUY' | 'SELL';
  asset?: string;
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

async function fetchAllTrades(wallet: string, hardLimit = 6000): Promise<RawTrade[]> {
  const all: RawTrade[] = [];
  let offset = 0;
  const pageSize = 500;
  while (all.length < hardLimit) {
    try {
      const res = await fetch(
        `${DATA_API}/trades?user=${wallet}&limit=${pageSize}&offset=${offset}`,
        { signal: AbortSignal.timeout(15_000) },
      );
      if (!res.ok) break;
      const page = (await res.json()) as RawTrade[];
      if (!Array.isArray(page) || page.length === 0) break;
      all.push(...page);
      if (page.length < pageSize) break;
      offset += pageSize;
      await new Promise((r) => setTimeout(r, 60));
    } catch {
      break;
    }
  }
  return all;
}

interface UnionPosition {
  conditionId: string;
  outcomeIndex: number;
  title: string;
  initialValue: number;   // for size metric
  truePnl: number;        // cashPnl + realizedPnl if from /positions; else trade-flow cashflow
  source: 'positions' | 'trade-flow';
  isResolved: boolean;
}

interface Audit {
  wallet: string;
  source: string[];
  leaderboardName?: string;
  leaderboardBestRank?: number;
  leaderboardMaxPnl?: number;
  // Counts
  geoPositionsTotal: number;
  fromPositions: number;
  fromTradeFlow: number;
  wins: number;
  losses: number;
  wrPct: number | null;
  // P&L
  truePnlTotal: number;
  // Sizing
  medianInitialValue: number | null;
  minInitialValue: number | null;
  maxInitialValue: number | null;
  // Activity
  newestTradeAge_h: number | null;
  newestPositionEndDate?: string;
  // Pass/fail
  passes: boolean;
  rejections: string[];
}

// Hard filters (locked)
const MIN_GEO_POSITIONS = 15;
const MIN_WR_PCT = 55;
const MIN_MEDIAN_SIZE = 10;
const MAX_MEDIAN_SIZE = 500;
const ACTIVE_WITHIN_H = 14 * 24;

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
  const [positions, trades] = await Promise.all([
    fetchPositions(wallet),
    fetchAllTrades(wallet),
  ]);

  // Build union per (conditionId, outcomeIndex)
  const seenFromPositions = new Set<string>();
  const union: UnionPosition[] = [];

  // 1. Pull from /positions (filter to politics)
  for (const p of positions) {
    if (!isGeopolitics(p.title ?? '')) continue;
    const key = `${p.conditionId}|${p.outcomeIndex ?? 0}`;
    seenFromPositions.add(key);
    union.push({
      conditionId: p.conditionId,
      outcomeIndex: p.outcomeIndex ?? 0,
      title: p.title ?? '',
      initialValue: p.initialValue ?? 0,
      truePnl: (p.cashPnl ?? 0) + (p.realizedPnl ?? 0),
      source: 'positions',
      isResolved: p.redeemable === true || (p.curPrice === 0 && (p as any).currentValue === 0),
    });
  }

  // 2. Group /trades by (conditionId, outcomeIndex), supplement union with fully-exited positions
  const tradeGroups = new Map<string, {
    title: string; netShares: number; cashFlow: number; totalBoughtUsd: number;
    buyCount: number; sellCount: number;
  }>();
  for (const t of trades) {
    const cid = t.conditionId ?? '?';
    const oi = t.outcomeIndex ?? 0;
    const key = `${cid}|${oi}`;
    let g = tradeGroups.get(key);
    if (!g) {
      g = { title: t.title ?? '', netShares: 0, cashFlow: 0, totalBoughtUsd: 0, buyCount: 0, sellCount: 0 };
      tradeGroups.set(key, g);
    }
    const usd = t.size * t.price;
    if (t.side === 'BUY') {
      g.netShares += t.size;
      g.cashFlow -= usd;
      g.totalBoughtUsd += usd;
      g.buyCount++;
    } else {
      g.netShares -= t.size;
      g.cashFlow += usd;
      g.sellCount++;
    }
  }

  for (const [key, g] of tradeGroups) {
    if (seenFromPositions.has(key)) continue; // already counted from /positions
    if (!isGeopolitics(g.title)) continue;
    if (Math.abs(g.netShares) >= 1) continue; // still holding but not in /positions → skip (no MTM available)
    // Closed-via-sale: realized PnL = cashFlow
    union.push({
      conditionId: key.split('|')[0],
      outcomeIndex: parseInt(key.split('|')[1] ?? '0', 10),
      title: g.title,
      initialValue: g.totalBoughtUsd,
      truePnl: g.cashFlow,
      source: 'trade-flow',
      isResolved: true, // by construction (net-zero shares)
    });
  }

  // Filters & metrics
  const wins = union.filter((u) => u.truePnl > 0).length;
  const losses = union.filter((u) => u.truePnl <= 0).length;
  const wrPct = union.length > 0 ? +((wins / union.length) * 100).toFixed(1) : null;
  const truePnlTotal = +union.reduce((s, u) => s + u.truePnl, 0).toFixed(2);
  const initVals = union.map((u) => u.initialValue).filter((v) => v > 0);
  const med = median(initVals);

  const newestTradeSec = trades.length > 0 ? trades[0].timestamp : null;
  const newestAge_h = newestTradeSec ? +((nowSec - newestTradeSec) / 3600).toFixed(1) : null;

  const rejections: string[] = [];
  if (union.length < MIN_GEO_POSITIONS) rejections.push(`geo<${MIN_GEO_POSITIONS} (got ${union.length})`);
  if (wrPct === null || wrPct < MIN_WR_PCT) rejections.push(`WR<${MIN_WR_PCT}% (got ${wrPct ?? 'n/a'}%)`);
  if (med === null || med < MIN_MEDIAN_SIZE) rejections.push(`medSize<$${MIN_MEDIAN_SIZE} (got $${med?.toFixed(2) ?? 'n/a'})`);
  if (med !== null && med > MAX_MEDIAN_SIZE) rejections.push(`medSize>$${MAX_MEDIAN_SIZE} (got $${med.toFixed(2)})`);
  if (newestAge_h === null || newestAge_h > ACTIVE_WITHIN_H) rejections.push(`inactive_>14d (newest ${newestAge_h ?? 'n/a'}h)`);

  return {
    wallet,
    source: sources,
    leaderboardName: lbName,
    leaderboardBestRank: lbRank,
    leaderboardMaxPnl: lbPnl,
    geoPositionsTotal: union.length,
    fromPositions: union.filter((u) => u.source === 'positions').length,
    fromTradeFlow: union.filter((u) => u.source === 'trade-flow').length,
    wins,
    losses,
    wrPct,
    truePnlTotal,
    medianInitialValue: med ? +med.toFixed(2) : null,
    minInitialValue: initVals.length ? +Math.min(...initVals).toFixed(2) : null,
    maxInitialValue: initVals.length ? +Math.max(...initVals).toFixed(2) : null,
    newestTradeAge_h: newestAge_h,
    passes: rejections.length === 0,
    rejections,
  };
}

async function main() {
  const nowSec = Math.floor(Date.now() / 1000);

  console.log('▸ Phase 2 v3 — combined /positions + /trades-flow screening');
  console.log(`  filters: geo≥${MIN_GEO_POSITIONS} | WR≥${MIN_WR_PCT}% | median $${MIN_MEDIAN_SIZE}-$${MAX_MEDIAN_SIZE} | active≤14d`);
  console.log();

  const p1a = JSON.parse(readFileSync(P1A_V2, 'utf-8'));
  const p1b = JSON.parse(readFileSync(P1B, 'utf-8'));

  // Build candidate map with provenance + leaderboard metadata
  interface CandSrc {
    sources: string[];
    lbName?: string;
    lbRank?: number;
    lbPnl?: number;
  }
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

  console.log(`  candidate pool: ${cands.size} unique wallets (politics leaderboard ∪ watchlist)`);
  console.log();

  const results: Audit[] = [];
  let i = 0;
  for (const [wallet, { sources, lbName, lbRank, lbPnl }] of cands) {
    i++;
    process.stdout.write(`  [${String(i).padStart(3)}/${cands.size}] ${wallet.slice(0, 12)}... `);
    const audit = await auditWallet(wallet, sources, lbName, lbRank, lbPnl, nowSec);
    results.push(audit);
    const marker = audit.passes ? '✅' : (audit.geoPositionsTotal >= 5 ? '◯' : '·');
    process.stdout.write(
      `geo=${String(audit.geoPositionsTotal).padStart(3)} (pos=${String(audit.fromPositions).padStart(2)}+flow=${String(audit.fromTradeFlow).padStart(3)}) WR=${(audit.wrPct ?? 'n/a').toString().padStart(5)}% truePnl=$${audit.truePnlTotal.toFixed(0).padStart(7)} medSz=$${(audit.medianInitialValue ?? 0).toFixed(0).padStart(5)} ${marker}\n`,
    );
  }

  const passing = results.filter((r) => r.passes).sort((a, b) => b.truePnlTotal - a.truePnlTotal);
  const interesting = results.filter((r) => !r.passes && r.geoPositionsTotal >= 5).sort((a, b) => b.truePnlTotal - a.truePnlTotal);
  const sleeping = results.filter((r) => !r.passes && r.geoPositionsTotal < 5);

  const output = {
    fetchedAt: new Date().toISOString(),
    method: 'union of /positions (buy-and-hold) + /trades-flow (sell-out closed). Geopolitics filter via broader keyword set matching the prod categoriser as of 2026-05-11.',
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
      console.log(`  ${r.wallet} (${r.leaderboardName ?? '?'})`);
      console.log(`    geo=${r.geoPositionsTotal} (pos=${r.fromPositions}, flow=${r.fromTradeFlow})  WR=${r.wrPct}%  truePnl=$${r.truePnlTotal}  medSize=$${r.medianInitialValue}  newestTrade=${r.newestTradeAge_h}h`);
      console.log(`    leaderboard bestRank=${r.leaderboardBestRank}  maxPnl=$${r.leaderboardMaxPnl}  src=${r.source.join(',')}`);
    }
  }
  console.log();
  console.log('=== INTERESTING (≥5 geo positions, failed ≥1 filter) — top 15 by truePnl ===');
  for (const r of interesting.slice(0, 15)) {
    console.log(`  ${r.wallet} (${r.leaderboardName ?? '?'})  geo=${r.geoPositionsTotal} WR=${r.wrPct}% truePnl=$${r.truePnlTotal} medSz=$${r.medianInitialValue}`);
    console.log(`    REJECT: ${r.rejections.join(' | ')}`);
  }
  console.log();
  console.log(`saved → ${OUT}`);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
