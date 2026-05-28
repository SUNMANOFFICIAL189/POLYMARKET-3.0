/**
 * Tests for diffLeaders — the pure function that decides which leaders need a write.
 * Extracted from upsertLeaders so the per-row samePayload logic is testable in isolation.
 *
 * Run with: npx tsx scripts/test-leader-diff.ts
 */

import assert from 'node:assert/strict';
import { diffLeaders } from '../src/data/supabase.js';
import type { Leader } from '../src/types/index.js';

function makeLeader(addr: string, overrides: Partial<Leader> = {}): Leader {
  return {
    walletAddress: addr,
    displayName: `Trader ${addr.slice(0, 6)}`,
    compositeScore: 50,
    winRate30d: 0.55,
    profitFactor14d: 1.2,
    tradeCount30d: 30,
    totalPnl30d: 1000,
    lastTradeTime: '2026-05-28T00:00:00.000Z',
    trackedSince: '2026-05-01T00:00:00.000Z',
    ...overrides,
  } as Leader;
}

function makeExistingRow(leader: Leader) {
  return {
    wallet_address: leader.walletAddress.toLowerCase(),
    display_name: leader.displayName,
    composite_score: leader.compositeScore,
    win_rate_30d: leader.winRate30d,
    profit_factor_14d: leader.profitFactor14d,
    trade_count_30d: leader.tradeCount30d,
    total_pnl_30d: leader.totalPnl30d,
    last_trade_time: leader.lastTradeTime,
    tracked_since: leader.trackedSince,
  };
}

const results: { name: string; passed: boolean; error?: string }[] = [];
function test(name: string, fn: () => void): void {
  try {
    fn();
    results.push({ name, passed: true });
    console.log(`  PASS  ${name}`);
  } catch (err) {
    results.push({ name, passed: false, error: String(err) });
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err}`);
  }
}

console.log('diffLeaders — Supabase IO fix tests');
console.log('====================================\n');

// TEST 1: empty input → empty output
test('empty leaders list returns empty', () => {
  const out = diffLeaders(new Map(), []);
  assert.deepEqual(out, []);
});

// TEST 2: all leaders identical to existing → no diffs, empty output
test('all unchanged leaders → no upserts needed', () => {
  const a = makeLeader('0xAAA');
  const b = makeLeader('0xBBB');
  const existing = new Map([
    [a.walletAddress.toLowerCase(), makeExistingRow(a)],
    [b.walletAddress.toLowerCase(), makeExistingRow(b)],
  ]);
  const out = diffLeaders(existing, [a, b]);
  assert.equal(out.length, 0, 'no leaders changed → empty output');
});

// TEST 3: one leader changed (composite_score) → only that one in output
test('one changed field on one leader → only that leader is upserted', () => {
  const a = makeLeader('0xAAA');
  const b = makeLeader('0xBBB');
  const existing = new Map([
    [a.walletAddress.toLowerCase(), makeExistingRow(a)],
    [b.walletAddress.toLowerCase(), makeExistingRow(b)],
  ]);
  const bChanged = makeLeader('0xBBB', { compositeScore: 99 });
  const out = diffLeaders(existing, [a, bChanged]);
  assert.equal(out.length, 1, 'only the changed leader should be in output');
  assert.equal(out[0].walletAddress, '0xBBB');
  assert.equal(out[0].compositeScore, 99);
});

// TEST 4: new leader not in existing map → included in output
test('new leader not in existing → included', () => {
  const a = makeLeader('0xAAA');
  const existing = new Map([
    [a.walletAddress.toLowerCase(), makeExistingRow(a)],
  ]);
  const newLeader = makeLeader('0xCCC');
  const out = diffLeaders(existing, [a, newLeader]);
  assert.equal(out.length, 1);
  assert.equal(out[0].walletAddress, '0xCCC');
});

// TEST 5: wallet address case-insensitive match (existing is lowercase per upsert convention)
test('case-insensitive wallet match — uppercase input matches lowercase existing', () => {
  const a = makeLeader('0xABCDEF');
  const existing = new Map([
    ['0xabcdef', makeExistingRow(a)],  // lowercase key
  ]);
  // Same data but uppercase input — should match and return no diffs
  const out = diffLeaders(existing, [makeLeader('0xABCDEF')]);
  assert.equal(out.length, 0, 'case difference should not cause spurious upsert');
});

// TEST 6: every individual field flips the diff (regression test for samePayload completeness)
test('every payload field is checked — none silently ignored', () => {
  const a = makeLeader('0xAAA');
  const existing = new Map([[a.walletAddress.toLowerCase(), makeExistingRow(a)]]);
  const fields: Array<Partial<Leader>> = [
    { displayName: 'Different Name' },
    { compositeScore: 999 },
    { winRate30d: 0.99 },
    { profitFactor14d: 99 },
    { tradeCount30d: 999 },
    { totalPnl30d: 999999 },
    { lastTradeTime: '2027-01-01T00:00:00.000Z' },
    { trackedSince: '2027-01-01T00:00:00.000Z' },
  ];
  for (const change of fields) {
    const changed = makeLeader('0xAAA', change);
    const out = diffLeaders(existing, [changed]);
    assert.equal(out.length, 1, `change to ${Object.keys(change)[0]} should flag diff`);
  }
});

// TEST 7: empty existing map (first run on a fresh DB) → all leaders need upsert
test('first-run: empty existing map → all leaders included', () => {
  const out = diffLeaders(new Map(), [makeLeader('0xAAA'), makeLeader('0xBBB'), makeLeader('0xCCC')]);
  assert.equal(out.length, 3);
});

// SUMMARY
const failed = results.filter(r => !r.passed);
console.log('\n====================================');
console.log(`Total: ${results.length}  Passed: ${results.length - failed.length}  Failed: ${failed.length}`);
if (failed.length > 0) {
  console.log('\nFailures:');
  for (const f of failed) console.log(`  ${f.name}: ${f.error}`);
  process.exit(1);
}
console.log('All tests pass.');
process.exit(0);
