/**
 * Tests for leader-mirrored exit pure functions.
 *
 * Two policies under test:
 *   1. shouldExitOnLeaderReduction(entrySize, currentSize, threshold)
 *      — exit when leader has sold >= threshold% of their position
 *   2. shouldExitOnDeepDrawdown(entryPrice, currentPrice, side, threshold)
 *      — backstop: exit when our position has lost >= threshold% (default 50%)
 *
 * Triggered by 2026-06-06 health check: 6 of 12 closed StarMaster mirrors hit
 * our existing 30% stop-loss while StarMaster held through the dip (5 of those
 * positions are now profitable in her wallet). Mismatch between her trading
 * style (averages down through volatility) and our fixed % stop.
 *
 * Run with: npx tsx scripts/test-leader-exit.ts
 */

import assert from 'node:assert/strict';
import {
  shouldExitOnLeaderReduction,
  shouldExitOnDeepDrawdown,
} from '../src/core/risk-manager.js';

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

console.log('Leader-mirrored exit policy — pure function tests');
console.log('==================================================\n');

// =====================================================
// shouldExitOnLeaderReduction
// =====================================================

test('leader holds full position → no exit', () => {
  // Entry size 1000, current 1000 (no change)
  assert.equal(shouldExitOnLeaderReduction(1000, 1000), false);
});

test('leader added to position → no exit (negative reduction)', () => {
  // She bought more — definitely should NOT exit
  assert.equal(shouldExitOnLeaderReduction(1000, 1500), false);
});

test('leader sold 30% → no exit at default 50% threshold', () => {
  // Current = 700, was 1000 → 30% reduction. Under default 50% threshold.
  assert.equal(shouldExitOnLeaderReduction(1000, 700), false);
});

test('leader sold exactly 50% → exit (at threshold boundary)', () => {
  // 500/1000 = 50% remaining = 50% reduction. Boundary case — should exit.
  assert.equal(shouldExitOnLeaderReduction(1000, 500), true);
});

test('leader sold 80% → exit', () => {
  // 200/1000 = 20% remaining = 80% reduction. Well above threshold.
  assert.equal(shouldExitOnLeaderReduction(1000, 200), true);
});

test('leader sold everything → exit', () => {
  assert.equal(shouldExitOnLeaderReduction(1000, 0), true);
});

test('custom threshold (30%) — leader sold 35% → exit', () => {
  // 650/1000 = 35% reduction, threshold 30% → exit
  assert.equal(shouldExitOnLeaderReduction(1000, 650, 0.30), true);
});

test('zero/negative entry size → no exit (defensive)', () => {
  // Bad input — fail-safe to no-exit
  assert.equal(shouldExitOnLeaderReduction(0, 0), false);
  assert.equal(shouldExitOnLeaderReduction(-1, 100), false);
});

test('negative current size → no exit (defensive on garbage)', () => {
  assert.equal(shouldExitOnLeaderReduction(1000, -50), false);
});

// =====================================================
// shouldExitOnDeepDrawdown — 50% backstop
// =====================================================

test('BUY at $0.50, current $0.50 → no exit (flat)', () => {
  assert.equal(shouldExitOnDeepDrawdown(0.50, 0.50, 'buy'), false);
});

test('BUY at $0.50, current $0.30 → no exit (40% loss, under 50% backstop)', () => {
  // Loss = (0.50 - 0.30) / 0.50 = 40%. Under default 50% threshold.
  assert.equal(shouldExitOnDeepDrawdown(0.50, 0.30, 'buy'), false);
});

test('BUY at $0.50, current $0.25 → exit (50% loss exactly)', () => {
  // Loss = (0.50 - 0.25) / 0.50 = 50%. At threshold — exit.
  assert.equal(shouldExitOnDeepDrawdown(0.50, 0.25, 'buy'), true);
});

test('BUY at $0.50, current $0.10 → exit (80% loss, well past 50%)', () => {
  assert.equal(shouldExitOnDeepDrawdown(0.50, 0.10, 'buy'), true);
});

test('SELL at $0.20, current $0.30 → exit (50% adverse move)', () => {
  // SELL adverse = price rising. Loss% = (0.30 - 0.20) / 0.20 = 50%. Exit.
  assert.equal(shouldExitOnDeepDrawdown(0.20, 0.30, 'sell'), true);
});

test('SELL at $0.20, current $0.10 → no exit (favorable move)', () => {
  // SELL at $0.20 and price dropped to $0.10 → we're winning
  assert.equal(shouldExitOnDeepDrawdown(0.20, 0.10, 'sell'), false);
});

test('custom threshold (30%) — BUY $0.50 → $0.30 → exit at 40%', () => {
  // Loss 40% > custom 30% threshold → exit
  assert.equal(shouldExitOnDeepDrawdown(0.50, 0.30, 'buy', 0.30), true);
});

test('zero entry price → no exit (defensive)', () => {
  assert.equal(shouldExitOnDeepDrawdown(0, 0.50, 'buy'), false);
});

test('negative current price → no exit (defensive)', () => {
  assert.equal(shouldExitOnDeepDrawdown(0.50, -0.10, 'buy'), false);
});

// =====================================================
// Reproduction: today's failed StarMaster trades
// =====================================================

test('REPRO: "US Iran ceasefire Jun 30" — entry $0.57, current $0.93, BUY → no 50% backstop exit (price went UP for us)', () => {
  // BUY at $0.57, current $0.93 — we're WINNING. No exit on drawdown.
  assert.equal(shouldExitOnDeepDrawdown(0.57, 0.93, 'buy'), false);
});

test('REPRO: hypothetical leader sells everything → exit even though price is favorable', () => {
  // She bought 5000, then sold all of it. Even if market moves our way, we follow her exit.
  assert.equal(shouldExitOnLeaderReduction(5000, 0), true);
});

// =====================================================
// SUMMARY
// =====================================================

const failed = results.filter(r => !r.passed);
console.log('\n==================================================');
console.log(`Total: ${results.length}  Passed: ${results.length - failed.length}  Failed: ${failed.length}`);
if (failed.length > 0) {
  console.log('\nFailures:');
  for (const f of failed) console.log(`  ${f.name}: ${f.error}`);
  process.exit(1);
}
console.log('All tests pass.');
process.exit(0);
