// Phase 2 — Screen candidate wallets by hard filters and produce ranked shortlist.
//
// Inputs:
//   _NEXT_STEPS/branch-3-phase1a-leaderboard.json    (71 leaderboard wallets)
//   _NEXT_STEPS/branch-3-phase1b-watchlist-audit.json (11 already-audited)
//
// Filters (locked — no goalpost shifting):
//   - ≥15 politics-market trades in last 90 days
//   - Win rate ≥55% on CLOSED politics positions (open positions excluded)
//   - Avg politics trade size $10-$500
//   - Active in last 14 days (newest trade)
//   - At least 5 closed politics positions (WR stability gate)
//
// Output: _NEXT_STEPS/branch-3-phase2-shortlist.json
//
// Run: cd ~/Desktop/POLYMARKET_TRADING_3.0 && npx tsx scripts/research/phase2-screen-candidates.ts

import { readFileSync, writeFileSync } from 'node:fs';
import { categoriseMarket } from '../../src/signals/market-categoriser.js';

const DATA_API = 'https://data-api.polymarket.com';
const WINDOW_DAYS = 90;
const PHASE1A_IN = `${process.env.HOME}/Desktop/POLYMARKET_TRADING_3.0/_NEXT_STEPS/branch-3-phase1a-leaderboard.json`;
const PHASE1B_IN = `${process.env.HOME}/Desktop/POLYMARKET_TRADING_3.0/_NEXT_STEPS/branch-3-phase1b-watchlist-audit.json`;
const OUT = `${process.env.HOME}/Desktop/POLYMARKET_TRADING_3.0/_NEXT_STEPS/branch-3-phase2-shortlist.json`;

// Hard filters
const MIN_POLITICS_TRADES = 15;
const MIN_CLOSED_POSITIONS = 5;
const MIN_WR_PCT = 55;
const MIN_AVG_SIZE = 10;
const MAX_AVG_SIZE = 500;
const ACTIVE_WITHIN_HOURS = 14 * 24;

interface RawTrade {
  proxyWallet: string;
  side: 'BUY' | 'SELL';
  asset?: string;
  conditionId?: string;
  size: number;
  price: number;
  timestamp: number;
  title?: string;
  slug?: string;
  outcome?: string;
  outcomeIndex?: number;
}

async function fetchAllRecentTrades(wallet: string, sinceSec: number, hardLimit = 4000): Promise<RawTrade[]> {
  const all: RawTrade[] = [];
  let offset = 0;
  const pageSize = 500;
  while (all.length < hardLimit) {
    const url = `${DATA_API}/trades?user=${wallet}&limit=${pageSize}&offset=${offset}`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) break;
      const page = (await res.json()) as RawTrade[];
      if (!Array.isArray(page) || page.length === 0) break;
      all.push(...page);
      const oldestInPage = page[page.length - 1].timestamp;
      if (oldestInPage < sinceSec) break;
      if (page.length < pageSize) break;
      offset += pageSize;
      await new Promise((r) => setTimeout(r, 70));
    } catch {
      break;
    }
  }
  return all.filter((t) => t.timestamp >= sinceSec);
}

interface CandidateMetrics {
  wallet: string;
  source: ('leaderboard-Weekly' | 'leaderboard-Monthly' | 'leaderboard-All' | 'watchlist')[];
  // Activity
  totalTradesInWindow: number;
  politicsTrades: number;
  newestTradeAge_h: number | null;
  // Sizing
  politicsAvgUsdc: number | null;
  politicsMedianUsdc: number | null;
  politicsMinUsdc: number | null;
  politicsMaxUsdc: number | null;
  // Position economics
  uniquePoliticsPositions: number;
  closedPoliticsPositions: number;
  closedWins: number;
  closedLosses: number;
  closedWrPct: number | null;
  realizedPoliticsPnl: number | null;
  // Reasons rejected (if any)
  passesAllFilters: boolean;
  rejections: string[];
}

function analyseWallet(wallet: string, trades: RawTrade[], nowSec: number): Omit<CandidateMetrics, 'source' | 'passesAllFilters' | 'rejections'> {
  const politicsTrades = trades
    .map((t) => ({ ...t, cat: categoriseMarket(t.title ?? ''), usdc: t.size * t.price }))
    .filter((t) => t.cat === 'politics');

  const newest = trades.length > 0 ? trades[0].timestamp : null;

  const notionals = politicsTrades.map((t) => t.usdc).sort((a, b) => a - b);
  const avg = notionals.length ? notionals.reduce((a, b) => a + b, 0) / notionals.length : null;
  const median = notionals.length ? notionals[Math.floor(notionals.length / 2)] : null;

  // Closed-position WR: group by (conditionId, outcomeIndex), check |netShares| < 1
  interface Position {
    netShares: number;
    cashFlow: number;
  }
  const positions = new Map<string, Position>();
  for (const t of politicsTrades) {
    const key = `${t.conditionId ?? '?'}|${t.outcomeIndex ?? 0}`;
    let p = positions.get(key);
    if (!p) {
      p = { netShares: 0, cashFlow: 0 };
      positions.set(key, p);
    }
    if (t.side === 'BUY') {
      p.netShares += t.size;
      p.cashFlow -= t.usdc;
    } else {
      p.netShares -= t.size;
      p.cashFlow += t.usdc;
    }
  }

  const allPositions = Array.from(positions.values());
  const closed = allPositions.filter((p) => Math.abs(p.netShares) < 1);
  const closedWins = closed.filter((p) => p.cashFlow > 0).length;
  const closedLosses = closed.filter((p) => p.cashFlow <= 0).length;
  const realizedPnl = closed.reduce((s, p) => s + p.cashFlow, 0);
  const wrPct = closed.length > 0 ? (closedWins / closed.length) * 100 : null;

  return {
    wallet,
    totalTradesInWindow: trades.length,
    politicsTrades: politicsTrades.length,
    newestTradeAge_h: newest ? +((nowSec - newest) / 3600).toFixed(1) : null,
    politicsAvgUsdc: avg ? +avg.toFixed(2) : null,
    politicsMedianUsdc: median ? +median.toFixed(2) : null,
    politicsMinUsdc: notionals.length ? +notionals[0].toFixed(2) : null,
    politicsMaxUsdc: notionals.length ? +notionals[notionals.length - 1].toFixed(2) : null,
    uniquePoliticsPositions: allPositions.length,
    closedPoliticsPositions: closed.length,
    closedWins,
    closedLosses,
    closedWrPct: wrPct ? +wrPct.toFixed(1) : null,
    realizedPoliticsPnl: closed.length ? +realizedPnl.toFixed(2) : null,
  };
}

function evaluateFilters(m: Omit<CandidateMetrics, 'source' | 'passesAllFilters' | 'rejections'>): { pass: boolean; rejections: string[] } {
  const rejections: string[] = [];
  if (m.politicsTrades < MIN_POLITICS_TRADES) rejections.push(`politics_trades<${MIN_POLITICS_TRADES} (got ${m.politicsTrades})`);
  if (m.closedPoliticsPositions < MIN_CLOSED_POSITIONS) rejections.push(`closed_positions<${MIN_CLOSED_POSITIONS} (got ${m.closedPoliticsPositions})`);
  if (m.closedWrPct === null || m.closedWrPct < MIN_WR_PCT) rejections.push(`wr<${MIN_WR_PCT}% (got ${m.closedWrPct ?? 'n/a'}%)`);
  if (m.politicsAvgUsdc === null || m.politicsAvgUsdc < MIN_AVG_SIZE) rejections.push(`avg_size<$${MIN_AVG_SIZE} (got $${m.politicsAvgUsdc ?? 'n/a'})`);
  if (m.politicsAvgUsdc !== null && m.politicsAvgUsdc > MAX_AVG_SIZE) rejections.push(`avg_size>$${MAX_AVG_SIZE} (got $${m.politicsAvgUsdc})`);
  if (m.newestTradeAge_h === null || m.newestTradeAge_h > ACTIVE_WITHIN_HOURS) rejections.push(`inactive_>14d (newest ${m.newestTradeAge_h ?? 'n/a'}h)`);
  return { pass: rejections.length === 0, rejections };
}

async function main() {
  const nowSec = Math.floor(Date.now() / 1000);
  const sinceSec = nowSec - WINDOW_DAYS * 86400;

  console.log('▸ Phase 2 — screen candidates by hard filters');
  console.log(`  filters: politics≥${MIN_POLITICS_TRADES} | closed≥${MIN_CLOSED_POSITIONS} | WR≥${MIN_WR_PCT}% | size $${MIN_AVG_SIZE}-$${MAX_AVG_SIZE} | active≤14d`);
  console.log();

  // Load Phase 1 outputs
  const p1a = JSON.parse(readFileSync(PHASE1A_IN, 'utf-8'));
  const p1b = JSON.parse(readFileSync(PHASE1B_IN, 'utf-8'));

  // Build candidate map with provenance
  interface CandSrc { sources: CandidateMetrics['source'] }
  const cands = new Map<string, CandSrc>();
  for (const w of p1a.windows.Weekly.wallets) {
    cands.set(w.toLowerCase(), { sources: ['leaderboard-Weekly'] });
  }
  for (const w of p1a.windows.Monthly.wallets) {
    const c = cands.get(w.toLowerCase()) ?? { sources: [] as CandidateMetrics['source'] };
    if (!c.sources.includes('leaderboard-Monthly')) c.sources.push('leaderboard-Monthly');
    cands.set(w.toLowerCase(), c);
  }
  for (const w of p1a.windows.All.wallets) {
    const c = cands.get(w.toLowerCase()) ?? { sources: [] as CandidateMetrics['source'] };
    if (!c.sources.includes('leaderboard-All')) c.sources.push('leaderboard-All');
    cands.set(w.toLowerCase(), c);
  }
  for (const audit of p1b.audit) {
    const c = cands.get(audit.wallet.toLowerCase()) ?? { sources: [] as CandidateMetrics['source'] };
    if (!c.sources.includes('watchlist')) c.sources.push('watchlist');
    cands.set(audit.wallet.toLowerCase(), c);
  }

  console.log(`  candidate pool: ${cands.size} unique wallets`);
  console.log();

  // For wallets already in 1b audit, reuse the raw data → but we need to re-fetch
  // because we need WR + closed-position data which 1b didn't compute.
  // Cheap enough — 11 extras.

  const results: CandidateMetrics[] = [];
  let i = 0;
  for (const [wallet, { sources }] of cands) {
    i++;
    process.stdout.write(`  [${i}/${cands.size}] ${wallet.slice(0, 12)}... `);
    const trades = await fetchAllRecentTrades(wallet, sinceSec);
    const m = analyseWallet(wallet, trades, nowSec);
    const f = evaluateFilters(m);
    const entry: CandidateMetrics = { ...m, source: sources, passesAllFilters: f.pass, rejections: f.rejections };
    results.push(entry);
    process.stdout.write(`tot=${m.totalTradesInWindow} pol=${m.politicsTrades} closed=${m.closedPoliticsPositions} wr=${m.closedWrPct ?? 'n/a'}% ${f.pass ? '✅ PASS' : '❌'}\n`);
  }

  // Sort: pass first (by realized PnL desc), then fail (by politics trades desc)
  const passing = results.filter((r) => r.passesAllFilters).sort((a, b) => (b.realizedPoliticsPnl ?? -Infinity) - (a.realizedPoliticsPnl ?? -Infinity));
  const failing = results.filter((r) => !r.passesAllFilters).sort((a, b) => b.politicsTrades - a.politicsTrades);

  const output = {
    fetchedAt: new Date().toISOString(),
    windowDays: WINDOW_DAYS,
    filters: {
      minPoliticsTrades: MIN_POLITICS_TRADES,
      minClosedPositions: MIN_CLOSED_POSITIONS,
      minWrPct: MIN_WR_PCT,
      minAvgSize: MIN_AVG_SIZE,
      maxAvgSize: MAX_AVG_SIZE,
      activeWithinHours: ACTIVE_WITHIN_HOURS,
    },
    candidatePoolSize: cands.size,
    shortlistSize: passing.length,
    shortlist: passing,
    rejected: failing,
    summary: {
      passingCount: passing.length,
      topByRealizedPnl: passing.slice(0, 10).map((r) => ({
        wallet: r.wallet,
        politicsTrades: r.politicsTrades,
        closedPositions: r.closedPoliticsPositions,
        wrPct: r.closedWrPct,
        realizedPnl: r.realizedPoliticsPnl,
        avgSize: r.politicsAvgUsdc,
        source: r.source,
      })),
      nearMisses: failing
        .filter((r) => r.politicsTrades >= 5)
        .slice(0, 10)
        .map((r) => ({
          wallet: r.wallet,
          politicsTrades: r.politicsTrades,
          closedPositions: r.closedPoliticsPositions,
          wrPct: r.closedWrPct,
          avgSize: r.politicsAvgUsdc,
          rejections: r.rejections,
        })),
    },
  };

  writeFileSync(OUT, JSON.stringify(output, null, 2));

  console.log();
  console.log('=== SHORTLIST (passes all hard filters) ===');
  if (passing.length === 0) {
    console.log('  ❌ EMPTY — no wallet in the candidate pool passes all filters');
  } else {
    for (const r of passing) {
      console.log(`  ${r.wallet}`);
      console.log(`    politics=${r.politicsTrades} closed=${r.closedPoliticsPositions} WR=${r.closedWrPct}% realized=$${r.realizedPoliticsPnl} avg_size=$${r.politicsAvgUsdc} sources=${r.source.join(',')}`);
    }
  }
  console.log();
  console.log('=== NEAR-MISSES (≥5 politics trades but failed ≥1 filter) ===');
  for (const r of output.summary.nearMisses) {
    console.log(`  ${r.wallet}  pol=${r.politicsTrades} closed=${r.closedPositions} wr=${r.wrPct}% avg=$${r.avgSize}`);
    console.log(`    REJECTIONS: ${r.rejections.join(' | ')}`);
  }
  console.log();
  console.log(`saved → ${OUT}`);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
