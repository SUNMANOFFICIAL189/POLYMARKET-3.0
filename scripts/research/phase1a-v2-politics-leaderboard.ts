// Phase 1a v2 — Polymarket politics-leaderboard fetcher
//
// REPLACES the v1 Puppeteer DOM scraper. The v1 was capped at 27-35 wallets per
// window by React virtualisation. THIS script hits the SSR JSON endpoint that
// powers the leaderboard pages directly:
//
//   https://polymarket.com/_next/data/<buildId>/en/leaderboard/<category>/<window>/<sort>.json
//
// Each fetch returns a `pageProps.dehydratedState.queries[]` array. Each query
// has a queryKey like `["/leaderboard", "profit"|"volume"|"biggestWins", "30d",
// limit, "politics", null]` and state.data = the ranked list (rich metadata).
// One fetch covers all 3 sort variants for that window.
//
// Output: _NEXT_STEPS/branch-3-phase1a-v2-politics.json
//   {
//     fetchedAt, buildId,
//     queries: [ { window, sort, results: [...] } ],  // 4 windows × 3 sorts = 12 ranking lists
//     uniqueWallets: [ ... ],
//     walletMeta: { '0x...': { name, pseudonym, appearsIn: [...], maxPnl, maxVolume, ... } }
//   }
//
// Run: cd ~/Desktop/POLYMARKET_TRADING_3.0 && npx tsx scripts/research/phase1a-v2-politics-leaderboard.ts

import { writeFileSync } from 'node:fs';

const BASE = 'https://polymarket.com/_next/data';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const OUT = `${process.env.HOME}/Desktop/POLYMARKET_TRADING_3.0/_NEXT_STEPS/branch-3-phase1a-v2-politics.json`;

const WINDOWS = ['today', 'weekly', 'monthly', 'all'] as const;
type Window = typeof WINDOWS[number];

// Per-window, one fetch returns all 3 sorts in the dehydrated state. So we
// only need to make 4 requests (one per window).

interface LeaderboardEntry {
  rank?: number;
  winRank?: string;
  proxyWallet: string;
  name?: string;
  pseudonym?: string;
  userName?: string;
  amount?: number;
  pnl?: number;
  volume?: number;
  realized?: number;
  unrealized?: number;
  initialValue?: number;
  finalValue?: number;
  eventSlug?: string;
  eventTitle?: string;
}

interface RankingResult {
  window: Window;
  sort: 'profit' | 'volume' | 'biggestWins';
  rawQueryKey: unknown[];
  results: LeaderboardEntry[];
}

interface WalletMeta {
  wallet: string;
  name?: string;
  pseudonym?: string;
  appearsIn: string[]; // e.g., ['politics-monthly-profit:rank=7', 'politics-all-volume:rank=2', 'politics-weekly-biggestWins:rank=3']
  bestRank: number;    // lowest rank across all appearances
  maxPnl: number;
  maxVolume: number;
  topBiggestWin?: { eventTitle: string; pnl: number };
}

async function discoverBuildId(): Promise<string> {
  const res = await fetch('https://polymarket.com/leaderboard', {
    headers: { 'User-Agent': UA },
  });
  const html = await res.text();
  const m = html.match(/build-[A-Za-z0-9_-]+/);
  if (!m) throw new Error('could not find build ID in leaderboard HTML');
  return m[0];
}

async function fetchWindow(buildId: string, window: Window): Promise<RankingResult[]> {
  // The URL path includes a sort segment ('profit'), but the dehydrated state
  // contains ALL three sort rankings. We only need one fetch per window.
  const url = `${BASE}/${buildId}/en/leaderboard/politics/${window}/profit.json`;
  console.log(`  ▸ politics/${window} — fetching ${url.slice(0, 80)}...`);
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) {
    console.warn(`    ⚠ HTTP ${res.status}`);
    return [];
  }
  const data = await res.json();
  const queries = data?.pageProps?.dehydratedState?.queries ?? [];

  const out: RankingResult[] = [];
  for (const q of queries) {
    const qk = q?.queryKey;
    const list = q?.state?.data;
    if (!Array.isArray(qk) || !Array.isArray(list) || list.length === 0) continue;
    const sortRaw = String(qk[1] ?? '');
    if (!['profit', 'volume', 'biggestWins'].includes(sortRaw)) continue;
    out.push({
      window,
      sort: sortRaw as RankingResult['sort'],
      rawQueryKey: qk,
      results: list as LeaderboardEntry[],
    });
  }
  console.log(`    captured ${out.length} ranking lists (${out.map((r) => `${r.sort}=${r.results.length}`).join(', ')})`);
  return out;
}

function aggregate(allRankings: RankingResult[]): { unique: string[]; meta: Record<string, WalletMeta> } {
  const meta: Record<string, WalletMeta> = {};
  for (const r of allRankings) {
    for (let i = 0; i < r.results.length; i++) {
      const e = r.results[i];
      const wallet = (e.proxyWallet ?? '').toLowerCase();
      if (!wallet.startsWith('0x') || wallet.length !== 42) continue;
      let m = meta[wallet];
      if (!m) {
        m = {
          wallet,
          name: e.name ?? e.userName,
          pseudonym: e.pseudonym ?? e.name ?? e.userName,
          appearsIn: [],
          bestRank: 999,
          maxPnl: -Infinity,
          maxVolume: 0,
        };
        meta[wallet] = m;
      }
      // Preserve first-seen name (may be richer than later entries)
      if (!m.name) m.name = e.name ?? e.userName;
      if (!m.pseudonym) m.pseudonym = e.pseudonym ?? e.name ?? e.userName;
      // Rank tracking
      const rank = r.sort === 'biggestWins' ? Number(e.winRank ?? (i + 1)) : (e.rank ?? (i + 1));
      m.appearsIn.push(`politics-${r.window}-${r.sort}:rank=${rank}`);
      if (rank < m.bestRank) m.bestRank = rank;
      // Pnl tracking
      if (typeof e.pnl === 'number' && e.pnl > m.maxPnl) m.maxPnl = e.pnl;
      if (typeof e.volume === 'number' && e.volume > m.maxVolume) m.maxVolume = e.volume;
      // biggestWins specific
      if (r.sort === 'biggestWins' && e.eventTitle && typeof e.pnl === 'number') {
        if (!m.topBiggestWin || e.pnl > m.topBiggestWin.pnl) {
          m.topBiggestWin = { eventTitle: e.eventTitle, pnl: e.pnl };
        }
      }
    }
  }
  // Replace -Infinity with 0 for output cleanliness
  for (const m of Object.values(meta)) {
    if (m.maxPnl === -Infinity) m.maxPnl = 0;
  }
  return { unique: Object.keys(meta), meta };
}

async function main() {
  console.log('▸ Phase 1a v2 — Polymarket politics-leaderboard fetcher');
  console.log(`  output: ${OUT}`);
  console.log();

  const buildId = await discoverBuildId();
  console.log(`  build ID: ${buildId}`);
  console.log();

  const allRankings: RankingResult[] = [];
  for (const w of WINDOWS) {
    const rankings = await fetchWindow(buildId, w);
    allRankings.push(...rankings);
    await new Promise((r) => setTimeout(r, 200));
  }

  console.log();
  const { unique, meta } = aggregate(allRankings);

  // Sort wallets by best (lowest) rank, then by maxPnl desc
  const sorted = [...unique].sort((a, b) => {
    const ma = meta[a], mb = meta[b];
    if (ma.bestRank !== mb.bestRank) return ma.bestRank - mb.bestRank;
    return mb.maxPnl - ma.maxPnl;
  });

  const output = {
    fetchedAt: new Date().toISOString(),
    buildId,
    windows: WINDOWS,
    rankings: allRankings.map((r) => ({
      window: r.window,
      sort: r.sort,
      count: r.results.length,
      results: r.results,
    })),
    uniqueWallets: sorted,
    walletMeta: meta,
    summary: {
      uniqueTotal: sorted.length,
      perRanking: Object.fromEntries(
        allRankings.map((r) => [`${r.window}/${r.sort}`, r.results.length]),
      ),
    },
  };

  writeFileSync(OUT, JSON.stringify(output, null, 2));

  console.log('=== SUMMARY ===');
  console.log(`  unique politics-leaderboard wallets across 4 windows × 3 sorts: ${sorted.length}`);
  console.log();
  console.log('  per-ranking counts:');
  for (const [k, v] of Object.entries(output.summary.perRanking)) {
    console.log(`    ${k.padEnd(28)} → ${v}`);
  }
  console.log();
  console.log('  TOP 15 by best-rank (then maxPnl):');
  for (const w of sorted.slice(0, 15)) {
    const m = meta[w];
    console.log(`    ${w} (${(m.pseudonym ?? '?').padEnd(20).slice(0, 20)})  bestRank=${m.bestRank}  maxPnl=$${m.maxPnl.toFixed(0).padStart(10)}  appearsIn=${m.appearsIn.length}`);
  }
  console.log();
  console.log(`saved → ${OUT}`);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
