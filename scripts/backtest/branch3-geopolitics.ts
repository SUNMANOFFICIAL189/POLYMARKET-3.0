// Branch 3 backtest — would proportional-sizing copy of the 12 geopolitics
// leaders have been profitable over the last 30 days?
//
// Sequencing (this script grows incrementally — v1 is just the fetcher + filter):
//   v1: pull leader trade history, filter to politics category, dump counts
//   v2: implement proportional sizing
//   v3: look up market resolutions via Gamma
//   v4: compute hypothetical PnL + aggregate output
//
// Run: ./node_modules/.bin/tsx scripts/backtest/branch3-geopolitics.ts

import { categoriseMarket } from '../../src/signals/market-categoriser.js';

const DATA_API = 'https://data-api.polymarket.com';
const WINDOW_DAYS = 30;

// 12 geopolitics leaders identified by the convergence backtest (from master
// handoff doc — see vault Decision Log "2026-05-08 Branch 2 PAUSED" entry).
// Counts beside each are the historical trade counts from that backtest era.
const LEADERS: { wallet: string; historicalTrades: number }[] = [
  { wallet: '0x204f72f35326db932158cba6adff0b9a1da95e14', historicalTrades: 211 },
  { wallet: '0x2005d16a84ceefa912d4e380cd32e7ff827875ea', historicalTrades: 92 },
  { wallet: '0xee613b3fc183ee44f9da9c05f53e2da107e3debf', historicalTrades: 34 },
  { wallet: '0x2a2c53bd278c04da9962fcf96490e17f3dfb9bc1', historicalTrades: 28 },
  { wallet: '0x5d05b1f588780423488a09d9aefeb64df54d6320', historicalTrades: 19 },
  { wallet: '0x6ac5bb06a9eb05641fd5e82640268b92f3ab4b6e', historicalTrades: 12 },
  { wallet: '0x507e52ef684ca2dd91f90a9d26d149dd3288beae', historicalTrades: 7 },
  { wallet: '0x37c1874a60d348903594a96703e0507c518fc53a', historicalTrades: 6 },
  { wallet: '0x492442eab586f242b53bda933fd5de859c8a3782', historicalTrades: 6 },
  { wallet: '0xfe787d2da716d60e8acff57fb87eb13cd4d10319', historicalTrades: 5 },
  { wallet: '0x0c154c190e293b7e5f8d453b5f690c4dc9599a45', historicalTrades: 2 },
];

interface DataApiTrade {
  proxyWallet: string;
  side: 'BUY' | 'SELL';
  asset?: string;
  conditionId?: string;
  size: number;       // tokens
  price: number;      // per-token, 0-1
  timestamp: number;  // unix seconds
  title?: string;
  slug?: string;
  outcome?: string;
  outcomeIndex?: number;
  transactionHash?: string;
}

interface Trade extends DataApiTrade {
  category: ReturnType<typeof categoriseMarket>;
  ageSec: number;
  usdcNotional: number;  // size * price, in USDC
}

async function fetchAllRecentTrades(wallet: string, sinceSec: number, hardLimit = 1500): Promise<DataApiTrade[]> {
  // data-api `/trades?user=X&limit=N&offset=N` for pagination. Fetch in 500-page
  // chunks until we get older than `sinceSec` or hit hardLimit (sanity cap).
  const all: DataApiTrade[] = [];
  let offset = 0;
  const pageSize = 500;
  while (all.length < hardLimit) {
    const url = `${DATA_API}/trades?user=${wallet}&limit=${pageSize}&offset=${offset}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) {
      console.warn(`  ⚠ data-api ${res.status} for ${wallet.slice(0, 10)}... offset=${offset}`);
      break;
    }
    const page = (await res.json()) as DataApiTrade[];
    if (!Array.isArray(page) || page.length === 0) break;
    all.push(...page);
    const oldestInPage = page[page.length - 1].timestamp;
    if (oldestInPage < sinceSec) break; // past the window — stop paginating
    if (page.length < pageSize) break; // last page
    offset += pageSize;
  }
  return all;
}

async function main() {
  const nowSec = Math.floor(Date.now() / 1000);
  const sinceSec = nowSec - WINDOW_DAYS * 86400;

  console.log(`▸ Branch 3 backtest — geopolitics-only proportional copy`);
  console.log(`  window: last ${WINDOW_DAYS} days (since ${new Date(sinceSec * 1000).toISOString()})`);
  console.log(`  leaders watched: ${LEADERS.length}`);
  console.log();

  console.log('=== STAGE 1: leader trade fetch + category filter ===\n');

  const allFiltered: { leader: string; trade: Trade }[] = [];
  const summary: Record<string, { total: number; politics: number; sports: number; crypto: number; finance: number; other: number; oldestInWindow: number | null; newestInWindow: number | null }> = {};

  for (const { wallet, historicalTrades } of LEADERS) {
    process.stdout.write(`  ${wallet.slice(0, 12)}... (hist ${historicalTrades})  `);
    const raw = await fetchAllRecentTrades(wallet, sinceSec);
    process.stdout.write(`fetched ${raw.length}, `);
    const inWindow = raw.filter((t) => t.timestamp >= sinceSec);
    process.stdout.write(`in-window ${inWindow.length}, `);

    const byCategory: Record<string, number> = { sports: 0, politics: 0, crypto: 0, finance: 0, other: 0 };
    const filtered: Trade[] = [];
    for (const t of inWindow) {
      const cat = categoriseMarket(t.title ?? '');
      byCategory[cat] = (byCategory[cat] ?? 0) + 1;
      const enriched: Trade = {
        ...t,
        category: cat,
        ageSec: nowSec - t.timestamp,
        usdcNotional: t.size * t.price,
      };
      filtered.push(enriched);
      if (cat === 'politics') allFiltered.push({ leader: wallet, trade: enriched });
    }

    const polCount = byCategory.politics;
    process.stdout.write(`politics=${polCount}\n`);

    summary[wallet] = {
      total: inWindow.length,
      politics: byCategory.politics,
      sports: byCategory.sports,
      crypto: byCategory.crypto,
      finance: byCategory.finance,
      other: byCategory.other,
      oldestInWindow: inWindow.length ? inWindow[inWindow.length - 1].timestamp : null,
      newestInWindow: inWindow.length ? inWindow[0].timestamp : null,
    };
  }

  console.log();
  console.log('=== per-leader category breakdown (last 30d) ===');
  console.log('wallet                                       | total | politics | sports | crypto | finance | other | newest');
  console.log('-'.repeat(120));
  for (const { wallet } of LEADERS) {
    const s = summary[wallet];
    const newest = s.newestInWindow ? new Date(s.newestInWindow * 1000).toISOString().slice(0, 16) : '(none)';
    console.log(
      `${wallet} | ${String(s.total).padStart(5)} | ${String(s.politics).padStart(8)} | ${String(s.sports).padStart(6)} | ${String(s.crypto).padStart(6)} | ${String(s.finance).padStart(7)} | ${String(s.other).padStart(5)} | ${newest}`,
    );
  }

  console.log();
  console.log('=== politics-only trades across all leaders ===');
  console.log(`total politics trades in window: ${allFiltered.length}`);

  // BUY vs SELL split
  const buys = allFiltered.filter((x) => x.trade.side === 'BUY');
  const sells = allFiltered.filter((x) => x.trade.side === 'SELL');
  console.log(`  BUY: ${buys.length}, SELL: ${sells.length}`);

  // Size distribution
  if (allFiltered.length > 0) {
    const notionals = allFiltered.map((x) => x.trade.usdcNotional).sort((a, b) => a - b);
    const median = notionals[Math.floor(notionals.length / 2)];
    const mean = notionals.reduce((a, b) => a + b, 0) / notionals.length;
    const total = notionals.reduce((a, b) => a + b, 0);
    console.log(`  size (USDC notional): mean=$${mean.toFixed(2)} median=$${median.toFixed(2)} total=$${total.toFixed(2)}`);
    console.log(`  size range: min=$${notionals[0].toFixed(2)} max=$${notionals[notionals.length - 1].toFixed(2)}`);
  }

  // Sample 5 politics trades for sanity
  console.log();
  console.log('=== sample politics trades ===');
  for (const { leader, trade } of allFiltered.slice(0, 10)) {
    const ageH = (trade.ageSec / 3600).toFixed(1);
    console.log(`  ${leader.slice(0, 12)}... ${trade.side} ${trade.size.toFixed(0)} @ $${trade.price.toFixed(3)} = $${trade.usdcNotional.toFixed(2)}  (${ageH}h ago)  "${(trade.title ?? '').slice(0, 60)}"`);
  }

  console.log();
  console.log('=== STAGE 2: proportional sizing per leader ===');

  // Compute each leader's "typical" politics-trade size = median of their
  // politics USDC notionals over the window. Used as the conviction denominator.
  const leaderTypicals: Record<string, number> = {};
  for (const { wallet } of LEADERS) {
    const myPolitics = allFiltered.filter((x) => x.leader === wallet).map((x) => x.trade.usdcNotional);
    if (myPolitics.length === 0) continue;
    const sorted = [...myPolitics].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    leaderTypicals[wallet] = median;
  }

  // Our pipeline capital — match the conservative recommended Branch 3 allocation
  const GEOPOLITICS_CAPITAL = Number(process.env.GEOPOLITICS_CAPITAL ?? '1500');
  const MIRROR_SCALAR = Number(process.env.MIRROR_SCALAR ?? '0.02');  // 2% of capital per typical leader bet
  const MAX_LOSS_PCT = Number(process.env.MAX_LOSS_PCT_PER_TRADE ?? '0.05');
  const MIN_TRADE_SIZE = 5; // skip below this — uneconomic
  const SLIPPAGE_PCT = 0.003;  // 0.3% (matches paper-trading.ts midpoint)

  console.log(`  GEOPOLITICS_CAPITAL = $${GEOPOLITICS_CAPITAL}`);
  console.log(`  MIRROR_SCALAR = ${MIRROR_SCALAR} (${(MIRROR_SCALAR * 100).toFixed(1)}% of capital per typical leader bet)`);
  console.log(`  MAX_LOSS_PCT_PER_TRADE = ${MAX_LOSS_PCT}`);
  console.log(`  SLIPPAGE = ${(SLIPPAGE_PCT * 100).toFixed(1)}%`);
  console.log();

  console.log('  per-leader typical politics-trade size:');
  for (const [w, t] of Object.entries(leaderTypicals)) {
    console.log(`    ${w.slice(0, 12)}... → median $${t.toFixed(2)}`);
  }

  /**
   * Proportional sizing: our_size = (leader_size / leader_typical) * capital * scalar
   * Capped by max-loss-as-pct-of-balance and floored by MIN_TRADE_SIZE.
   * For SELL trades, max-loss is asymmetric: (1 - entry_price) per share.
   */
  function proportionalSize(leaderUsdc: number, leaderTypical: number, side: 'BUY' | 'SELL', entryPrice: number): number {
    if (leaderTypical <= 0) return 0;
    const convictionRatio = leaderUsdc / leaderTypical;
    const rawSize = convictionRatio * GEOPOLITICS_CAPITAL * MIRROR_SCALAR;
    // Cap by max-loss
    const maxLossDollars = MAX_LOSS_PCT * GEOPOLITICS_CAPITAL;
    const maxLossPerShare = side === 'SELL' ? (1 - entryPrice) : entryPrice;
    if (entryPrice <= 0 || entryPrice >= 1) return 0;
    const sharesAtRaw = rawSize / entryPrice;
    const proposedMaxLoss = maxLossPerShare * sharesAtRaw;
    let size = rawSize;
    if (proposedMaxLoss > maxLossDollars) {
      const allowedShares = maxLossDollars / maxLossPerShare;
      size = allowedShares * entryPrice;
    }
    if (size < MIN_TRADE_SIZE) return 0;
    return Math.floor(size * 100) / 100;
  }

  // Apply sizing to all politics trades
  interface SizedTrade {
    leader: string;
    trade: Trade;
    ourSize: number;
    ourShares: number;
    leaderTypical: number;
    convictionRatio: number;
  }
  const sized: SizedTrade[] = [];
  let skippedTinyConviction = 0;
  let skippedNoTypical = 0;
  for (const { leader, trade } of allFiltered) {
    const typical = leaderTypicals[leader];
    if (!typical) { skippedNoTypical++; continue; }
    const ourSize = proportionalSize(trade.usdcNotional, typical, trade.side, trade.price);
    if (ourSize === 0) { skippedTinyConviction++; continue; }
    // Apply slippage to entry price
    const slipped = trade.side === 'BUY' ? trade.price * (1 + SLIPPAGE_PCT) : trade.price * (1 - SLIPPAGE_PCT);
    const ourShares = ourSize / slipped;
    sized.push({
      leader,
      trade,
      ourSize,
      ourShares,
      leaderTypical: typical,
      convictionRatio: trade.usdcNotional / typical,
    });
  }

  console.log();
  console.log(`  after sizing: ${sized.length} candidate copies / ${allFiltered.length} politics trades`);
  console.log(`    skipped (below min size): ${skippedTinyConviction}`);
  console.log(`    skipped (no leader-typical): ${skippedNoTypical}`);

  if (sized.length > 0) {
    const sizes = sized.map((s) => s.ourSize).sort((a, b) => a - b);
    const totalDeployed = sizes.reduce((a, b) => a + b, 0);
    console.log(`  our position sizing: min=$${sizes[0].toFixed(2)} median=$${sizes[Math.floor(sizes.length / 2)].toFixed(2)} max=$${sizes[sizes.length - 1].toFixed(2)} total_deployed=$${totalDeployed.toFixed(2)}`);
  }

  console.log();
  console.log('=== STAGE 3a: fetch current outcome prices from Gamma (for MTM) ===');

  const GAMMA = 'https://gamma-api.polymarket.com';
  const priceCache = new Map<string, { outcomePrices: number[]; closed: boolean; error?: string }>();

  async function fetchCurrentPrices(conditionId: string): Promise<{ outcomePrices: number[]; closed: boolean; error?: string }> {
    const cached = priceCache.get(conditionId);
    if (cached) return cached;
    try {
      await new Promise((r) => setTimeout(r, 60));  // polite rate
      const url = `${GAMMA}/markets?condition_ids=${conditionId}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(12_000) });
      if (!res.ok) {
        const r = { outcomePrices: [], closed: false, error: `http_${res.status}` };
        priceCache.set(conditionId, r);
        return r;
      }
      const data = await res.json();
      const m = Array.isArray(data) ? data[0] : data;
      if (!m) {
        const r = { outcomePrices: [], closed: false, error: 'empty' };
        priceCache.set(conditionId, r);
        return r;
      }
      let prices: number[] = [];
      try {
        const raw = m.outcomePrices ?? '[]';
        prices = typeof raw === 'string' ? JSON.parse(raw).map(Number) : raw.map(Number);
      } catch { prices = []; }
      const r = { outcomePrices: prices, closed: m.closed === true };
      priceCache.set(conditionId, r);
      return r;
    } catch (e) {
      const r = { outcomePrices: [], closed: false, error: String((e as Error).message).slice(0, 50) };
      priceCache.set(conditionId, r);
      return r;
    }
  }

  console.log();
  console.log('=== STAGE 3b: leader-realized-PnL accounting (per leader+market+leg) ===');

  // Group ALL of each leader's politics trades by (conditionId, outcomeIndex)
  // = unique position. Compute net shares + net USD cash flow.
  //
  // Polymarket allows shorting (sell YES = open short or close long, depending
  // on whether you currently own YES shares). For backtest purposes we track
  // net share balance per (leader, conditionId, outcomeIndex):
  //   shares_balance = sum(BUY shares) - sum(SELL shares)
  //   cash_balance   = sum(SELL USD)   - sum(BUY USD)
  //
  // When shares_balance ≈ 0 by end of window: cash_balance IS realized PnL.
  // When non-zero: leader has an open position; we don't include in primary
  // verdict (need outcome resolution to close).

  interface LeaderPosition {
    leader: string;
    conditionId: string;
    outcomeIndex: number;
    title: string;
    netShares: number;          // positive = long, negative = short
    cashFlow: number;           // USD: revenue - cost (negative if currently long)
    grossUsd: number;           // sum of |USD| moved through this position
    tradeCount: number;
    side: 'BUY' | 'SELL' | 'MIXED';
    firstEntry: number;         // timestamp
    lastExit: number;           // timestamp
  }

  const positionMap = new Map<string, LeaderPosition>();
  for (const { leader, trade } of allFiltered) {
    const cid = trade.conditionId ?? '?';
    const oi = trade.outcomeIndex ?? 0;
    const key = `${leader}|${cid}|${oi}`;
    let pos = positionMap.get(key);
    if (!pos) {
      pos = {
        leader, conditionId: cid, outcomeIndex: oi,
        title: trade.title ?? '?',
        netShares: 0, cashFlow: 0, grossUsd: 0, tradeCount: 0,
        side: trade.side, firstEntry: trade.timestamp, lastExit: trade.timestamp,
      };
      positionMap.set(key, pos);
    }
    const usdSize = trade.usdcNotional;
    if (trade.side === 'BUY') {
      pos.netShares += trade.size;
      pos.cashFlow -= usdSize;
    } else {  // SELL
      pos.netShares -= trade.size;
      pos.cashFlow += usdSize;
    }
    pos.grossUsd += usdSize;
    pos.tradeCount += 1;
    pos.lastExit = Math.max(pos.lastExit, trade.timestamp);
    if (pos.side !== trade.side && pos.tradeCount > 1) pos.side = 'MIXED';
  }

  const allPositions = Array.from(positionMap.values());
  const CLOSED_SHARE_THRESHOLD = 1;

  // Fetch current MTM prices for ALL positions (we'll use these for open positions)
  const uniqueConditions = Array.from(new Set(allPositions.map((p) => p.conditionId)));
  console.log(`  fetching current outcome prices for ${uniqueConditions.length} markets...`);
  let fetched = 0;
  for (const c of uniqueConditions) {
    await fetchCurrentPrices(c);
    fetched++;
    if (fetched % 10 === 0) process.stdout.write(`    ${fetched}/${uniqueConditions.length}\n`);
  }
  const priceAvailable = uniqueConditions.filter((c) => (priceCache.get(c)?.outcomePrices.length ?? 0) > 0);
  console.log(`  markets with usable prices: ${priceAvailable.length}/${uniqueConditions.length}`);
  console.log();

  // For each position, compute total economic PnL = cashFlow + (netShares × current_price)
  // For fully-closed positions netShares ≈ 0, so total = cashFlow (pure realized).
  // For open positions, the second term marks the remaining position to current market price.
  type EnrichedPosition = LeaderPosition & { mtmPrice: number; mtmValue: number; totalPnl: number; status: 'closed' | 'mtm' | 'no_price' };
  const enrichedPositions: EnrichedPosition[] = allPositions.map((p) => {
    const isClosed = Math.abs(p.netShares) < CLOSED_SHARE_THRESHOLD;
    const cached = priceCache.get(p.conditionId);
    const mtmPrice = cached?.outcomePrices[p.outcomeIndex] ?? 0;
    const havePrice = cached && cached.outcomePrices.length > 0 && !cached.error;
    const mtmValue = havePrice ? p.netShares * mtmPrice : 0;
    const totalPnl = p.cashFlow + mtmValue;
    const status: 'closed' | 'mtm' | 'no_price' = isClosed ? 'closed' : (havePrice ? 'mtm' : 'no_price');
    return { ...p, mtmPrice, mtmValue, totalPnl, status };
  });

  const usable = enrichedPositions.filter((p) => p.status !== 'no_price');
  const closedOnly = enrichedPositions.filter((p) => p.status === 'closed');
  const mtmOnly = enrichedPositions.filter((p) => p.status === 'mtm');
  const noPrice = enrichedPositions.filter((p) => p.status === 'no_price');

  console.log(`  positions classification:`);
  console.log(`    fully closed (realized PnL): ${closedOnly.length}`);
  console.log(`    open + MTM available:        ${mtmOnly.length}`);
  console.log(`    open but no price (skipped): ${noPrice.length}`);
  console.log();

  const totalLeaderPnl = usable.reduce((s, p) => s + p.totalPnl, 0);
  const closedLeaderPnl = closedOnly.reduce((s, p) => s + p.cashFlow, 0);
  const mtmLeaderPnl = mtmOnly.reduce((s, p) => s + p.totalPnl, 0);
  const leaderWR = usable.length > 0 ? usable.filter((p) => p.totalPnl > 0).length / usable.length * 100 : 0;

  console.log('  ── LEADER PNL (closed = realized; open = MTM) ──');
  console.log(`    usable positions:   ${usable.length}`);
  console.log(`    winners:            ${usable.filter((p) => p.totalPnl > 0).length}  (WR ${leaderWR.toFixed(1)}%)`);
  console.log(`    sum total PnL:      $${totalLeaderPnl.toFixed(2)}  (realized $${closedLeaderPnl.toFixed(2)} + MTM $${mtmLeaderPnl.toFixed(2)})`);
  if (usable.length > 0) {
    const sorted = [...usable].sort((a, b) => a.totalPnl - b.totalPnl);
    console.log(`    best:               +$${sorted[sorted.length - 1].totalPnl.toFixed(2)} on "${sorted[sorted.length - 1].title.slice(0, 50)}" (${sorted[sorted.length - 1].status})`);
    console.log(`    worst:              $${sorted[0].totalPnl.toFixed(2)} on "${sorted[0].title.slice(0, 50)}" (${sorted[0].status})`);
  }

  console.log();
  console.log('=== STAGE 4: our hypothetical PnL via proportional sizing ===');

  // For each closed position, compute what we would have done.
  // Our trades = leader's trades scaled by per-trade proportional sizing.
  // Our PnL = leader PnL * (our_total_deployed / leader_total_deployed)

  interface CopyResult {
    leader: string;
    conditionId: string;
    title: string;
    leaderCashFlow: number;
    leaderDeployed: number;
    ourDeployedTotal: number;     // sum of our_size across the leg's trades
    sizingRatio: number;          // our_deployed / leader_deployed
    ourPnl: number;
    ourPnlPct: number;
    tradeCount: number;
  }

  // Group sized trades by the same position key
  const sizedByKey = new Map<string, SizedTrade[]>();
  for (const s of sized) {
    const cid = s.trade.conditionId ?? '?';
    const oi = s.trade.outcomeIndex ?? 0;
    const key = `${s.leader}|${cid}|${oi}`;
    if (!sizedByKey.has(key)) sizedByKey.set(key, []);
    sizedByKey.get(key)!.push(s);
  }

  const copyResults: CopyResult[] = [];
  for (const p of usable) {
    const key = `${p.leader}|${p.conditionId}|${p.outcomeIndex}`;
    const ourTrades = sizedByKey.get(key) ?? [];
    if (ourTrades.length === 0) continue;  // we wouldn't have sized any of these trades (all below min)
    const ourDeployed = ourTrades.reduce((s, t) => s + t.ourSize, 0);
    const leaderDeployed = ourTrades.reduce((s, t) => s + t.trade.usdcNotional, 0);
    if (leaderDeployed <= 0) continue;
    const sizingRatio = ourDeployed / leaderDeployed;
    // Our PnL = leader's total PnL (cash flow + MTM remainder) × proportional ratio of capital we deployed vs they did
    const ourPnl = p.totalPnl * sizingRatio;
    copyResults.push({
      leader: p.leader,
      conditionId: p.conditionId,
      title: p.title,
      leaderCashFlow: p.totalPnl,  // Note: now using totalPnl which includes MTM, but field name kept for compat
      leaderDeployed,
      ourDeployedTotal: ourDeployed,
      sizingRatio,
      ourPnl,
      ourPnlPct: ourDeployed > 0 ? (ourPnl / ourDeployed) * 100 : 0,
      tradeCount: ourTrades.length,
    });
  }

  function summarizeCopy(rows: CopyResult[], label: string) {
    if (rows.length === 0) { console.log(`  ${label.padEnd(30)}: (empty)`); return; }
    const wins = rows.filter((r) => r.ourPnl > 0).length;
    const total = rows.reduce((s, r) => s + r.ourPnl, 0);
    const totalDeployed = rows.reduce((s, r) => s + r.ourDeployedTotal, 0);
    const wr = (wins / rows.length) * 100;
    const roi = totalDeployed > 0 ? (total / totalDeployed) * 100 : 0;
    console.log(`  ${label.padEnd(30)} | positions=${String(rows.length).padStart(3)} | WR=${wr.toFixed(1).padStart(5)}% | total_pnl=$${total.toFixed(2).padStart(9)} | total_deployed=$${totalDeployed.toFixed(0).padStart(6)} | ROI=${roi.toFixed(2)}%`);
  }

  console.log('  ── OUR HYPOTHETICAL PNL (proportional sizing) ──');
  summarizeCopy(copyResults, 'all closed positions');
  console.log();
  console.log('  BY LEADER');
  const copyLeaderSet = new Set(copyResults.map((r) => r.leader));
  for (const w of copyLeaderSet) {
    summarizeCopy(copyResults.filter((r) => r.leader === w), w.slice(0, 14) + '...');
  }

  console.log();
  console.log('  SAMPLE POSITIONS (top 5 wins + top 5 losses)');
  const propSorted = [...copyResults].sort((a, b) => b.ourPnl - a.ourPnl);
  console.log('    ── BEST ──');
  for (const r of propSorted.slice(0, 5)) {
    console.log(`    leader $${r.leaderCashFlow.toFixed(2)}  /  our $${r.ourPnl.toFixed(2)} (deploy=$${r.ourDeployedTotal.toFixed(0)}, ratio=${r.sizingRatio.toFixed(3)})  "${r.title.slice(0, 60)}"`);
  }
  console.log('    ── WORST ──');
  for (const r of propSorted.slice(-5).reverse()) {
    console.log(`    leader $${r.leaderCashFlow.toFixed(2)}  /  our $${r.ourPnl.toFixed(2)} (deploy=$${r.ourDeployedTotal.toFixed(0)}, ratio=${r.sizingRatio.toFixed(3)})  "${r.title.slice(0, 60)}"`);
  }

  // Counterfactual: flat $75 sizing on the same positions
  const FLAT = 75;
  const flatResults: CopyResult[] = [];
  for (const p of usable) {
    const key = `${p.leader}|${p.conditionId}|${p.outcomeIndex}`;
    const ourTrades = sizedByKey.get(key) ?? [];
    if (ourTrades.length === 0) continue;
    const ourDeployedFlat = ourTrades.length * FLAT;
    const leaderDeployed = ourTrades.reduce((s, t) => s + t.trade.usdcNotional, 0);
    const sizingRatio = ourDeployedFlat / Math.max(leaderDeployed, 1);
    const ourPnl = p.totalPnl * sizingRatio;
    flatResults.push({
      leader: p.leader, conditionId: p.conditionId, title: p.title,
      leaderCashFlow: p.totalPnl, leaderDeployed,
      ourDeployedTotal: ourDeployedFlat, sizingRatio,
      ourPnl, ourPnlPct: ourDeployedFlat > 0 ? (ourPnl / ourDeployedFlat) * 100 : 0,
      tradeCount: ourTrades.length,
    });
  }

  console.log();
  console.log('  ── FLAT $75 COUNTERFACTUAL ──');
  summarizeCopy(flatResults, 'flat $75 on same positions');

  console.log();
  console.log('=== VERDICT ===');
  const propTotal = copyResults.reduce((s, r) => s + r.ourPnl, 0);
  const flatTotal = flatResults.reduce((s, r) => s + r.ourPnl, 0);
  const propDeployed = copyResults.reduce((s, r) => s + r.ourDeployedTotal, 0);
  const flatDeployed = flatResults.reduce((s, r) => s + r.ourDeployedTotal, 0);

  console.log(`  positions analyzed: ${usable.length}  (closed=${closedOnly.length}, mtm=${mtmOnly.length}, skipped=${noPrice.length})`);
  console.log(`  leader's total PnL on those: $${totalLeaderPnl.toFixed(2)}  (realized $${closedLeaderPnl.toFixed(2)} + MTM $${mtmLeaderPnl.toFixed(2)})`);
  console.log();
  console.log(`  Proportional sizing — pnl=$${propTotal.toFixed(2)}  deployed=$${propDeployed.toFixed(2)}  ROI=${propDeployed > 0 ? (propTotal/propDeployed*100).toFixed(2) : 'n/a'}%`);
  console.log(`  Flat $75 sizing     — pnl=$${flatTotal.toFixed(2)}  deployed=$${flatDeployed.toFixed(2)}  ROI=${flatDeployed > 0 ? (flatTotal/flatDeployed*100).toFixed(2) : 'n/a'}%`);
  console.log();

  if (propTotal > 0 && propTotal > flatTotal) {
    console.log(`  ✅ BRANCH 3 VIABLE: proportional sizing produces positive PnL AND beats flat sizing.`);
  } else if (propTotal > 0 && propTotal < flatTotal) {
    console.log(`  ⚠ MIXED: proportional is positive but flat is BETTER. Sizing rule may need tuning, but Branch 3 can earn money either way.`);
  } else if (propTotal < 0 && flatTotal > 0) {
    console.log(`  ⚠ MIXED: proportional loses but flat wins. Strategy works at flat sizing — sizing formula is broken.`);
  } else if (propTotal < 0 && flatTotal < 0) {
    console.log(`  ❌ KILL BRANCH 3: both sizing rules lose money on the leader's actual closed trades. The leaders don't have a copyable edge in this window.`);
  } else {
    console.log(`  ⚠ INCONCLUSIVE`);
  }
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
