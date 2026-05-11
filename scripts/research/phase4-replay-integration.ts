// Phase 4 — Replay-mode integration test.
//
// Feeds historical politics trades from the new Tier-1 wallets (balthazar +
// Car) through the ACTUAL production GeopoliticsExecutor + PaperTradingEngine
// + RiskManager — same code paths the live bot will use. Tests:
//   - Does the BUY-only filter behave correctly?
//   - Does the politics-category filter accept the right markets?
//   - Does the capital cap actually trigger?
//   - Does the position count cap actually trigger?
//   - Do leader SELLs correctly trigger our closePosition?
//   - What's the actual mirror-rate vs. naive "every trade gets mirrored"?
//
// Output: chronological replay log + aggregate stats + P&L estimate.
//
// Run: cd ~/Desktop/POLYMARKET_TRADING_3.0 && npx tsx scripts/research/phase4-replay-integration.ts

import { PaperTradingEngine } from '../../src/core/paper-trading.js';
import { RiskManager } from '../../src/core/risk-manager.js';
import { RiskDial } from '../../src/core/config.js';
import { GeopoliticsExecutor } from '../../src/execution/geopolitics-executor.js';
import { TIER_1 } from '../../src/geopolitics/watchlist.js';
import { RISK_PRESETS } from '../../src/types/index.js';
import type { LeaderTrade, Side } from '../../src/types/index.js';

// Mutate the paper preset's maxOpenPositions BEFORE instantiating any
// engine/dial. Mirrors what config.ts does via process.env.MAX_OPEN_POSITIONS.
// In production runner.ts honors the same env var. Without this override, the
// paper preset cap of 5 starves any multi-pipeline setup (signal + geopolitics).
const MAX_OPEN_OVERRIDE = Number(process.env.MAX_OPEN_POSITIONS ?? '15');
RISK_PRESETS.paper.maxOpenPositions = MAX_OPEN_OVERRIDE;

const DATA_API = 'https://data-api.polymarket.com';
const REPLAY_DAYS = 30;
// Capital values mirror what runner.ts actually configures in production:
//   - PaperTradingEngine gets cfg.totalCapitalUsdc ($6300 default) — its
//     internal per-position cap is 2% of that = $126, allowing flat $75
//   - GeopoliticsExecutor + RiskManager get GEOPOLITICS_CAPITAL ($1500 pool)
const TOTAL_CAPITAL = Number(process.env.TOTAL_CAPITAL_USDC ?? '6300');
const GEO_CAPITAL = Number(process.env.GEOPOLITICS_CAPITAL ?? '1500');
const FLAT_SIZE = Number(process.env.GEOPOLITICS_FLAT_SIZE ?? '75');

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

async function fetchAllTrades(wallet: string, sinceSec: number, hardLimit = 3500): Promise<RawTrade[]> {
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

function rawToLeaderTrade(t: RawTrade): LeaderTrade {
  return {
    leaderWallet: t.proxyWallet,
    marketId: t.slug ?? t.conditionId ?? '?',
    marketQuestion: t.title ?? '',
    tokenId: t.asset,
    outcome: t.outcome ?? 'Yes',
    side: t.side.toLowerCase() as Side,
    entryPrice: t.price,
    size: t.size,
    timestamp: new Date(t.timestamp * 1000).toISOString(),
  };
}

async function main() {
  const nowSec = Math.floor(Date.now() / 1000);
  const sinceSec = nowSec - REPLAY_DAYS * 86400;

  console.log('▸ Phase 4 — Replay-mode integration test');
  console.log(`  Tier-1: ${TIER_1.map((s) => s.name).join(', ')}`);
  console.log(`  Replay window: last ${REPLAY_DAYS} days`);
  console.log(`  Total capital (paperEngine): $${TOTAL_CAPITAL}`);
  console.log(`  Geopolitics pool (executor/RM): $${GEO_CAPITAL}, flat size: $${FLAT_SIZE}`);
  console.log();

  // ── Production-equivalent instantiation ──
  const dial = new RiskDial('paper');
  const riskManager = new RiskManager('geopolitics', dial, GEO_CAPITAL);
  // Critical: paperEngine sees TOTAL bot capital (matches runner.ts which
  // constructs it with cfg.totalCapitalUsdc). Its 2% per-position cap is
  // computed off total; with $6300, that's $126 — leaves headroom for the
  // flat $75 geopolitics size.
  const paperEngine = new PaperTradingEngine(TOTAL_CAPITAL, 'paper');
  const executor = new GeopoliticsExecutor({
    paperEngine,
    riskManager,
    paperMode: true,
    capitalPool: GEO_CAPITAL,
    riskLevel: 'paper',
    flatSizeUsdc: FLAT_SIZE,
  });

  // ── Fetch all trades for Tier-1 wallets ──
  console.log('Fetching historical trades for Tier-1...');
  const allTrades: RawTrade[] = [];
  for (const spec of TIER_1) {
    process.stdout.write(`  ${spec.name} (${spec.walletAddress.slice(0, 12)}...) `);
    const trades = await fetchAllTrades(spec.walletAddress, sinceSec);
    process.stdout.write(`${trades.length} trades fetched\n`);
    allTrades.push(...trades);
  }
  // Chronological order (oldest first) for sequential replay
  allTrades.sort((a, b) => a.timestamp - b.timestamp);
  console.log(`  total trades to replay: ${allTrades.length}\n`);

  // ── Replay ──
  const rejections: Record<string, number> = {};
  const acceptedTrades: Array<{ when: string; wallet: string; market: string; ourSize: number; side: Side }> = [];
  const closedTrades: Array<{ when: string; wallet: string; market: string; pnl?: number; reason: string }> = [];
  let buyAttempts = 0;
  let sellAttempts = 0;
  let closeAttempts = 0;

  for (const raw of allTrades) {
    const leaderTrade = rawToLeaderTrade(raw);

    if (leaderTrade.side === 'buy') {
      buyAttempts++;
      const result = await executor.execute(leaderTrade);
      if (result.success && result.copyTrade) {
        acceptedTrades.push({
          when: new Date(raw.timestamp * 1000).toISOString(),
          wallet: raw.proxyWallet.slice(0, 12),
          market: (raw.title ?? '').slice(0, 60),
          ourSize: result.copyTrade.ourSize,
          side: leaderTrade.side,
        });
      } else {
        const reason = (result.reason ?? 'unknown').split(' (')[0].split(':')[0].trim();
        rejections[reason] = (rejections[reason] || 0) + 1;
      }
    } else {
      sellAttempts++;
      // Leader SELL → try to close our position on this market (if open)
      if (executor.hasOpenPositionForMarket(leaderTrade.marketId)) {
        closeAttempts++;
        const closed = await executor.closePosition(leaderTrade.marketId, leaderTrade.entryPrice, 'leader_closed');
        if (closed) {
          closedTrades.push({
            when: new Date(raw.timestamp * 1000).toISOString(),
            wallet: raw.proxyWallet.slice(0, 12),
            market: (raw.title ?? '').slice(0, 60),
            pnl: closed.pnl,
            reason: 'leader_closed',
          });
        }
      }
    }
  }

  // ── Summary ──
  const stats = executor.getStats();
  const paperStats = paperEngine.getStats();
  const openAtEnd = executor.getOpenTrades();
  const openValue = openAtEnd.reduce((s, t) => s + (t.ourSize ?? 0), 0);
  const totalRealizedPnl = closedTrades.reduce((s, t) => s + (t.pnl ?? 0), 0);

  console.log('=== EXECUTION STATS ===');
  console.log(`  Leader BUY attempts:           ${buyAttempts}`);
  console.log(`  Leader SELL attempts:          ${sellAttempts}`);
  console.log(`  Our trades executed (mirrors): ${acceptedTrades.length}`);
  console.log(`  Mirror rate (accepted/BUYs):   ${(acceptedTrades.length / Math.max(buyAttempts, 1) * 100).toFixed(1)}%`);
  console.log(`  Total deployed at peak:        $${Math.max(...[openValue], 0).toFixed(0)} of $${GEO_CAPITAL} geopolitics cap`);
  console.log();

  console.log('=== REJECTION REASONS (sorted by count) ===');
  for (const [reason, count] of Object.entries(rejections).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(4)} × ${reason}`);
  }
  console.log();

  console.log('=== CLOSE EVENTS ===');
  console.log(`  Total leader SELLs on markets we had open:  ${closeAttempts}`);
  console.log(`  Of those, our closePosition resolved:        ${closedTrades.length}`);
  if (closedTrades.length > 0) {
    const wins = closedTrades.filter((t) => (t.pnl ?? 0) > 0).length;
    const losses = closedTrades.filter((t) => (t.pnl ?? 0) <= 0).length;
    console.log(`  Closed wins / losses:                        ${wins} / ${losses}`);
    console.log(`  Win rate:                                    ${(wins / closedTrades.length * 100).toFixed(1)}%`);
    console.log(`  Realized P&L from leader-close events:       $${totalRealizedPnl.toFixed(2)}`);
  }
  console.log();

  console.log('=== FINAL STATE ===');
  console.log(`  Open positions at replay end:    ${openAtEnd.length} (deploying $${openValue.toFixed(0)})`);
  console.log(`  Paper engine balance:            $${paperStats.balance.toFixed(2)}`);
  console.log(`  Paper engine total P&L:          $${paperStats.totalPnl.toFixed(2)}`);
  console.log(`  Paper engine closed trades:      ${paperStats.totalTrades}`);
  console.log(`  Paper engine win rate:           ${paperStats.totalTrades > 0 ? paperStats.winRate.toFixed(1) + '%' : 'n/a'}`);
  console.log();

  // ── Sample accepted trades ──
  if (acceptedTrades.length > 0) {
    console.log('=== Sample of accepted mirrors (first 5) ===');
    for (const t of acceptedTrades.slice(0, 5)) {
      console.log(`  ${t.when.slice(0, 16)}  ${t.wallet}  $${t.ourSize.toFixed(2)} BUY  "${t.market}"`);
    }
    if (acceptedTrades.length > 5) {
      console.log(`  ... and ${acceptedTrades.length - 5} more`);
    }
  }
  console.log();

  // ── Sample closed trades (winners + losers) ──
  if (closedTrades.length > 0) {
    const sorted = [...closedTrades].sort((a, b) => (b.pnl ?? 0) - (a.pnl ?? 0));
    console.log('=== Top 3 winners ===');
    for (const t of sorted.slice(0, 3)) {
      console.log(`  ${t.when.slice(0, 16)}  +$${(t.pnl ?? 0).toFixed(2)}  "${t.market}"`);
    }
    console.log('=== Top 3 losers ===');
    for (const t of sorted.slice(-3).reverse()) {
      console.log(`  ${t.when.slice(0, 16)}   $${(t.pnl ?? 0).toFixed(2)}  "${t.market}"`);
    }
  }
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
