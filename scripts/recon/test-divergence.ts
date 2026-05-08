// Phase 4 sanity test for DivergenceLogger.matching logic.
// Synchronously creates synthetic REST + WS events and verifies pairing.
// (No timers — sweep/grace-period behaviour is validated in Phase 6 against real traffic.)

import { DivergenceLogger } from '../../src/monitor/divergence-logger.js';
import type { LeaderTrade } from '../../src/types/index.js';
import type { ParsedTrade } from '../../src/monitor/match-orders-decoder.js';

function leaderTrade(overrides: Partial<LeaderTrade> = {}): LeaderTrade {
  return {
    leaderWallet: '0x204f72f35326db932158cba6adff0b9a1da95e14',
    marketId: '0xf30520eba63519f7f6f63b9de643d4ef8bac865e310e15d8e673448d56f17003',
    marketQuestion: 'Test market',
    tokenId: '80616901337614883623291452540840530353239629112698134114398556791331846243',
    outcome: 'Yes',
    side: 'buy',
    entryPrice: 0.17,
    size: 63.92,
    timestamp: new Date(Date.now()).toISOString(),
    ...overrides,
  };
}

function parsedTrade(overrides: Partial<ParsedTrade> = {}): ParsedTrade {
  return {
    wallet: '0x204f72f35326db932158cba6adff0b9a1da95e14',
    side: 'buy',
    tokenId: '80616901337614883623291452540840530353239629112698134114398556791331846243',
    conditionId: '0xf30520eba63519f7f6f63b9de643d4ef8bac865e310e15d8e673448d56f17003',
    entryPrice: 0.17,
    size: 63.92,
    txHash: '0xda0cc9a69a86c60f4cc82b9be586b910419a74dbfef4ae1c78250d903a749085',
    blockNumber: 86566942,
    timestamp: Date.now(),
    fromAddress: '0xf9dea1f827eab834f676d64f83328b5c8c8a0703',
    arg5: '1591690',
    matchType: 'taker',
    ...overrides,
  };
}

let pass = 0;
let fail = 0;
function assert(cond: boolean, label: string) {
  if (cond) {
    console.log(`  ✓ ${label}`);
    pass++;
  } else {
    console.log(`  ✗ ${label}`);
    fail++;
  }
}

console.log('▸ exact match (REST then WS within window)');
{
  const d = new DivergenceLogger();
  d.recordRest(leaderTrade());
  d.recordWs(parsedTrade());
  const s = d.getStats();
  assert(s.matched === 1, `matched count == 1 (got ${s.matched})`);
  assert(s.restOnly === 0, `restOnly == 0 (got ${s.restOnly})`);
  assert(s.wsOnly === 0, `wsOnly == 0 (got ${s.wsOnly})`);
  assert(s.totalRest === 1 && s.totalWs === 1, `totals 1/1 (got ${s.totalRest}/${s.totalWs})`);
}

console.log('\n▸ WS arrives BEFORE REST (negative latency delta = WS faster)');
{
  const d = new DivergenceLogger();
  d.recordWs(parsedTrade());
  d.recordRest(leaderTrade());
  const s = d.getStats();
  assert(s.matched === 1, 'matched == 1 (order does not matter)');
  assert(s.latencyDeltasMs.length === 1 && s.latencyDeltasMs[0]! <= 0, 'WS-faster delta recorded as ≤0');
}

console.log('\n▸ side mismatch — should NOT match');
{
  const d = new DivergenceLogger();
  d.recordRest(leaderTrade({ side: 'buy' }));
  d.recordWs(parsedTrade({ side: 'sell' }));
  const s = d.getStats();
  assert(s.matched === 0, 'matched == 0');
  assert(s.totalRest === 1 && s.totalWs === 1, 'both events stashed (totals=1/1)');
}

console.log('\n▸ wallet mismatch — should NOT match');
{
  const d = new DivergenceLogger();
  d.recordRest(leaderTrade());
  d.recordWs(parsedTrade({ wallet: '0x0000000000000000000000000000000000000001' }));
  const s = d.getStats();
  assert(s.matched === 0, 'matched == 0');
}

console.log('\n▸ price within tolerance (0.17 vs 0.175) — should match (≤1.5pp)');
{
  const d = new DivergenceLogger();
  d.recordRest(leaderTrade({ entryPrice: 0.17 }));
  d.recordWs(parsedTrade({ entryPrice: 0.175 }));
  const s = d.getStats();
  assert(s.matched === 1, 'matched == 1');
}

console.log('\n▸ price OUTSIDE tolerance (0.17 vs 0.20) — should NOT match');
{
  const d = new DivergenceLogger();
  d.recordRest(leaderTrade({ entryPrice: 0.17 }));
  d.recordWs(parsedTrade({ entryPrice: 0.20 }));
  const s = d.getStats();
  assert(s.matched === 0, 'matched == 0');
}

console.log('\n▸ size within 10% (63.92 vs 60.00) — should match');
{
  const d = new DivergenceLogger();
  d.recordRest(leaderTrade({ size: 63.92 }));
  d.recordWs(parsedTrade({ size: 60.0 }));
  const s = d.getStats();
  assert(s.matched === 1, 'matched == 1');
}

console.log('\n▸ size outside 10% (63.92 vs 30.00) — should NOT match');
{
  const d = new DivergenceLogger();
  d.recordRest(leaderTrade({ size: 63.92 }));
  d.recordWs(parsedTrade({ size: 30.0 }));
  const s = d.getStats();
  assert(s.matched === 0, 'matched == 0');
}

console.log(`\n=== ${pass} pass / ${fail} fail ===`);
process.exit(fail === 0 ? 0 : 1);
