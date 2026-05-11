// Phase 1b — audit the existing 11-wallet watch list for actual geopolitics
// activity in last 90 days. Uses Polymarket data-api (no auth, proven path).
//
// Output: _NEXT_STEPS/branch-3-phase1b-watchlist-audit.json
//   { fetchedAt, audit: [ { wallet, totalTrades, politicsTrades, byMonth, ... } ] }
//
// Run: cd ~/Desktop/POLYMARKET_TRADING_3.0 && npx tsx scripts/research/phase1b-audit-watchlist.ts

import { writeFileSync } from 'node:fs';
import { categoriseMarket } from '../../src/signals/market-categoriser.js';

const DATA_API = 'https://data-api.polymarket.com';
const WINDOW_DAYS = 90;
const OUT = `${process.env.HOME}/Desktop/POLYMARKET_TRADING_3.0/_NEXT_STEPS/branch-3-phase1b-watchlist-audit.json`;

// Current watch list from scripts/backtest/branch3-geopolitics.ts (11 wallets,
// "12" in the file comment is stale — only 11 entries in the array)
const WATCH_LIST = [
  '0x204f72f35326db932158cba6adff0b9a1da95e14',
  '0x2005d16a84ceefa912d4e380cd32e7ff827875ea',
  '0xee613b3fc183ee44f9da9c05f53e2da107e3debf',
  '0x2a2c53bd278c04da9962fcf96490e17f3dfb9bc1',
  '0x5d05b1f588780423488a09d9aefeb64df54d6320',
  '0x6ac5bb06a9eb05641fd5e82640268b92f3ab4b6e',
  '0x507e52ef684ca2dd91f90a9d26d149dd3288beae',
  '0x37c1874a60d348903594a96703e0507c518fc53a',
  '0x492442eab586f242b53bda933fd5de859c8a3782',
  '0xfe787d2da716d60e8acff57fb87eb13cd4d10319',
  '0x0c154c190e293b7e5f8d453b5f690c4dc9599a45',
];

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
      if (!res.ok) {
        console.warn(`  ⚠ data-api ${res.status} for ${wallet.slice(0, 10)}... offset=${offset}`);
        break;
      }
      const page = (await res.json()) as RawTrade[];
      if (!Array.isArray(page) || page.length === 0) break;
      all.push(...page);
      const oldestInPage = page[page.length - 1].timestamp;
      if (oldestInPage < sinceSec) break;
      if (page.length < pageSize) break;
      offset += pageSize;
      await new Promise((r) => setTimeout(r, 80));
    } catch (e) {
      console.warn(`  ⚠ fetch error for ${wallet.slice(0, 10)}... ${(e as Error).message}`);
      break;
    }
  }
  return all.filter((t) => t.timestamp >= sinceSec);
}

interface WalletAudit {
  wallet: string;
  windowDays: number;
  totalTradesInWindow: number;
  politicsTrades: number;
  sportsTrades: number;
  cryptoTrades: number;
  financeTrades: number;
  otherTrades: number;
  newestTradeAge_h: number | null;       // hours since most recent trade
  oldestTradeAge_d: number | null;       // days since oldest trade in window
  uniquePoliticsMarkets: number;
  politicsTradesByMonth: Record<string, number>;     // 'YYYY-MM' → count
  politicsAvgUsdcNotional: number | null;
  politicsMedianUsdcNotional: number | null;
  politicsBuyCount: number;
  politicsSellCount: number;
}

function audit(wallet: string, trades: RawTrade[], nowSec: number): WalletAudit {
  const categorised = trades.map((t) => ({
    ...t,
    cat: categoriseMarket(t.title ?? ''),
    usdcNotional: t.size * t.price,
  }));

  const politics = categorised.filter((t) => t.cat === 'politics');
  const sports = categorised.filter((t) => t.cat === 'sports');
  const crypto = categorised.filter((t) => t.cat === 'crypto');
  const finance = categorised.filter((t) => t.cat === 'finance');
  const other = categorised.filter((t) => t.cat === 'other');

  const newest = trades.length > 0 ? trades[0].timestamp : null;
  const oldest = trades.length > 0 ? trades[trades.length - 1].timestamp : null;

  const politicsNotionals = politics.map((t) => t.usdcNotional).sort((a, b) => a - b);
  const median =
    politicsNotionals.length > 0 ? politicsNotionals[Math.floor(politicsNotionals.length / 2)] : null;
  const mean =
    politicsNotionals.length > 0
      ? politicsNotionals.reduce((a, b) => a + b, 0) / politicsNotionals.length
      : null;

  const byMonth: Record<string, number> = {};
  for (const t of politics) {
    const d = new Date(t.timestamp * 1000);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    byMonth[key] = (byMonth[key] ?? 0) + 1;
  }

  return {
    wallet,
    windowDays: WINDOW_DAYS,
    totalTradesInWindow: trades.length,
    politicsTrades: politics.length,
    sportsTrades: sports.length,
    cryptoTrades: crypto.length,
    financeTrades: finance.length,
    otherTrades: other.length,
    newestTradeAge_h: newest ? +((nowSec - newest) / 3600).toFixed(1) : null,
    oldestTradeAge_d: oldest ? +((nowSec - oldest) / 86400).toFixed(1) : null,
    uniquePoliticsMarkets: new Set(politics.map((t) => t.conditionId)).size,
    politicsTradesByMonth: byMonth,
    politicsAvgUsdcNotional: mean ? +mean.toFixed(2) : null,
    politicsMedianUsdcNotional: median ? +median.toFixed(2) : null,
    politicsBuyCount: politics.filter((t) => t.side === 'BUY').length,
    politicsSellCount: politics.filter((t) => t.side === 'SELL').length,
  };
}

async function main() {
  const nowSec = Math.floor(Date.now() / 1000);
  const sinceSec = nowSec - WINDOW_DAYS * 86400;

  console.log('▸ Phase 1b — audit existing 11-wallet watch list');
  console.log(`  window: last ${WINDOW_DAYS} days (since ${new Date(sinceSec * 1000).toISOString()})`);
  console.log(`  output: ${OUT}`);
  console.log();

  const results: WalletAudit[] = [];
  for (const w of WATCH_LIST) {
    process.stdout.write(`  ${w.slice(0, 12)}... `);
    const trades = await fetchAllRecentTrades(w, sinceSec);
    const a = audit(w, trades, nowSec);
    results.push(a);
    process.stdout.write(
      `total=${a.totalTradesInWindow} politics=${a.politicsTrades} unique_mkts=${a.uniquePoliticsMarkets} newest=${a.newestTradeAge_h ?? 'n/a'}h\n`,
    );
  }

  const output = {
    fetchedAt: new Date().toISOString(),
    windowDays: WINDOW_DAYS,
    sinceSec,
    audit: results,
    summary: {
      walletsWithAnyTrade: results.filter((r) => r.totalTradesInWindow > 0).length,
      walletsWithPoliticsTrade: results.filter((r) => r.politicsTrades > 0).length,
      walletsActiveLast14d: results.filter((r) => r.newestTradeAge_h !== null && r.newestTradeAge_h <= 14 * 24).length,
      totalPoliticsTrades: results.reduce((s, r) => s + r.politicsTrades, 0),
      topByPoliticsTradeCount: [...results].sort((a, b) => b.politicsTrades - a.politicsTrades).slice(0, 5).map((r) => ({
        wallet: r.wallet,
        politicsTrades: r.politicsTrades,
        newestH: r.newestTradeAge_h,
        avgUsdc: r.politicsAvgUsdcNotional,
      })),
    },
  };

  writeFileSync(OUT, JSON.stringify(output, null, 2));

  console.log();
  console.log('=== SUMMARY ===');
  console.log(`  wallets with ANY trade in 90d:        ${output.summary.walletsWithAnyTrade}/11`);
  console.log(`  wallets with politics trade in 90d:   ${output.summary.walletsWithPoliticsTrade}/11`);
  console.log(`  wallets active in last 14d:           ${output.summary.walletsActiveLast14d}/11`);
  console.log(`  total politics trades:                ${output.summary.totalPoliticsTrades}`);
  console.log();
  console.log('  TOP 5 by politics trade count:');
  for (const r of output.summary.topByPoliticsTradeCount) {
    console.log(`    ${r.wallet} — ${r.politicsTrades} pol trades, newest ${r.newestH ?? 'n/a'}h ago, avg $${r.avgUsdc ?? 'n/a'}`);
  }
  console.log();
  console.log(`saved → ${OUT}`);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
