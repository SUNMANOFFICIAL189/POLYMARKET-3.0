// Standalone verification script for src/signals/market-categoriser.ts
//
// Run: cd ~/Desktop/POLYMARKET_TRADING_3.0 && npx tsx scripts/verify-categoriser.ts
//
// Assertions:
//   - Sprint-discovered geopolitics titles now categorise as 'politics' (new behaviour)
//   - Already-matched titles still categorise the same (no regression)
//   - Sports / crypto / finance / other markets still categorise correctly
//
// Background: 2026-05-11 Branch 3 research sprint discovered the categoriser
// missed Iran/Israel/Gaza/Netanyahu/etc., causing ~half of the geopolitics
// market universe to fall through to 'other'. The keyword list was extended;
// this script pins the new behaviour.

import { categoriseMarket, MarketCategory } from '../src/signals/market-categoriser.js';

interface Case {
  title: string;
  expected: MarketCategory;
  note: string;
}

const CASES: Case[] = [
  // ─── Geopolitics — NEW behaviour from sprint additions ───
  { title: 'US forces enter Iran by March 31?', expected: 'politics', note: 'iran keyword' },
  { title: 'Netanyahu out by March 31?', expected: 'politics', note: 'netanyahu keyword' },
  { title: 'Netanyahu out by June 30?', expected: 'politics', note: 'netanyahu keyword' },
  { title: 'Will the Iranian regime fall before 2027?', expected: 'politics', note: 'iran substring of "Iranian"' },
  { title: 'Will Iran strike Iraq by April 30, 2026?', expected: 'politics', note: 'iran keyword' },
  { title: 'Will Israel and Hamas reach a hostage deal?', expected: 'politics', note: 'israel + hamas keywords' },
  { title: 'Gaza ceasefire by end of June?', expected: 'politics', note: 'gaza keyword (ceasefire already matched)' },
  { title: 'Will Hezbollah retaliate against Israel by year end?', expected: 'politics', note: 'hezbollah + israel keywords' },
  { title: 'Will Taiwan declare independence in 2026?', expected: 'politics', note: 'taiwan keyword' },
  { title: 'North Korea missile test by Q3?', expected: 'politics', note: 'north korea keyword' },
  { title: 'Will Howard Lutnick leave the Trump administration before 2027?', expected: 'politics', note: 'lutnick + trump' },
  { title: 'Will Kristi Noem resign before EOY?', expected: 'politics', note: 'noem keyword' },
  { title: 'Will Rubio negotiate a treaty with Iran?', expected: 'politics', note: 'rubio + treaty + iran keywords' },
  { title: 'Will Epstein files be fully released in 2026?', expected: 'politics', note: 'epstein keyword' },
  { title: 'Erdogan re-elected in next Turkish election?', expected: 'politics', note: 'erdogan keyword (election already matched)' },
  { title: 'Zelensky meets Putin in 2026?', expected: 'politics', note: 'zelensky keyword (putin already matched)' },
  { title: 'Kim Jong-un visits Beijing in 2026?', expected: 'politics', note: 'kim jong keyword' },
  { title: 'Will Starmer remain UK PM through 2026?', expected: 'politics', note: 'starmer keyword' },
  { title: 'US ambassador to Lebanon recalled by Q3?', expected: 'politics', note: 'ambassador + lebanon keywords' },
  { title: 'New peace deal in the Middle East by June?', expected: 'politics', note: 'middle east + peace deal already matched' },
  { title: 'Will Venezuela hold free elections in 2026?', expected: 'politics', note: 'venezuela keyword (election already matched)' },

  // ─── Already-matched politics — regression check ───
  { title: 'Will Russia invade a NATO country by June 30, 2026?', expected: 'politics', note: 'nato keyword (pre-existing)' },
  { title: 'Trump announces end of military operations against Iran', expected: 'politics', note: 'trump (pre-existing) + iran (new) both match — politics' },
  { title: 'Will the GOP use Nuclear Option to break filibuster?', expected: 'politics', note: 'gop + filibuster (pre-existing)' },
  { title: 'Putin offers ceasefire to Ukraine?', expected: 'politics', note: 'putin + ceasefire + ukraine (pre-existing)' },
  { title: 'Will Modi visit Washington in 2026?', expected: 'politics', note: 'modi (pre-existing)' },

  // ─── Sports — should remain sports (sports iterates first) ───
  { title: 'Lakers win the 2026 NBA championship?', expected: 'sports', note: 'lakers + championship + nba' },
  { title: 'Real Madrid wins Champions League 2026?', expected: 'sports', note: 'real madrid + champions league' },
  { title: 'Wimbledon 2026 mens singles winner?', expected: 'sports', note: 'wimbledon' },
  // Test: a market with "China" in it but in a sports context — should still go sports
  // because sports keywords iterate first. (No bare 'china' in our additions but
  // this confirms order is intact.)

  // ─── Crypto — should remain crypto ───
  { title: 'Bitcoin above $100k by EOY 2026?', expected: 'crypto', note: 'bitcoin + $100k' },
  { title: 'Will Ethereum spot ETF launch in Q3?', expected: 'crypto', note: 'ethereum + spot etf' },

  // ─── Finance — should remain finance ───
  { title: 'Will the Federal Reserve cut rates in June?', expected: 'finance', note: 'federal reserve + rate cut' },
  { title: 'S&P 500 above 6000 by EOY?', expected: 'finance', note: 's&p 500' },

  // ─── Other — sanity check (these should NOT match any category) ───
  { title: 'Will the highest temperature in Hong Kong be 23°C on April 24?', expected: 'other', note: 'no political/sport/crypto/finance keyword' },
  { title: 'Will OpenAI release GPT-6 in 2026?', expected: 'other', note: 'tech market — no matching category yet' },
  { title: 'Will a new Pope be elected by year end?', expected: 'other', note: '"elected" is NOT a substring of "election" (categoriser uses literal substring match). Pope markets are categorisation-orphans — fine for our purposes.' },
];

let pass = 0;
let fail = 0;
const failures: Array<{ case: Case; got: MarketCategory }> = [];

console.log(`▸ Verifying market-categoriser — ${CASES.length} cases`);
console.log();

for (const c of CASES) {
  const got = categoriseMarket(c.title);
  const ok = got === c.expected;
  if (ok) {
    pass++;
  } else {
    fail++;
    failures.push({ case: c, got });
  }
  const marker = ok ? '✓' : '✗';
  console.log(`  ${marker} [${c.expected.padEnd(8)} → ${got.padEnd(8)}] "${c.title.slice(0, 75)}"`);
}

console.log();
console.log(`pass=${pass} / fail=${fail} / total=${CASES.length}`);

if (fail > 0) {
  console.log();
  console.log('=== FAILURES ===');
  for (const f of failures) {
    console.log(`  expected ${f.case.expected} got ${f.got}`);
    console.log(`    title: "${f.case.title}"`);
    console.log(`    note:  ${f.case.note}`);
  }
  process.exit(1);
}

console.log();
console.log('all cases pass.');
