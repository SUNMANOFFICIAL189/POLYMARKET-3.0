// Phase 3 smoke test — runs PolygonBlockListener against a list of high-traffic
// wallets for ~30 seconds. Verifies WS connects, blocks are processed, and at
// least some trades are detected. No assertions on specific values.
//
// Run: ./node_modules/.bin/tsx scripts/recon/test-block-listener.ts [SECONDS]

import { PolygonBlockListener } from '../../src/monitor/polygon-block-listener.js';
import type { ParsedTrade } from '../../src/monitor/match-orders-decoder.js';

// Watch a generous list of wallets known to trade actively (data-api top traders +
// the geopolitics list from the master handoff). Higher hit rate during smoke test.
const WATCHED = [
  '0x204f72f35326db932158cba6adff0b9a1da95e14', // golden test tx maker (top leader)
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

const SECONDS = Number(process.argv[2] ?? '30');

async function main() {
  const listener = new PolygonBlockListener();
  listener.setWatchers(WATCHED);

  let blocksObserved = new Set<number>();
  let trades: ParsedTrade[] = [];
  let connections: string[] = [];
  let errors: string[] = [];

  listener.on('new-trade', (t: ParsedTrade) => {
    trades.push(t);
    blocksObserved.add(t.blockNumber);
    console.log(
      `  trade: block=${t.blockNumber} wallet=${t.wallet.slice(0, 10)}... side=${t.side} price=${t.entryPrice.toFixed(4)} size=$${t.size.toFixed(2)} match=${t.matchType}`,
    );
  });
  listener.on('connection', (ev) => {
    const tag = `${ev.mode}/${ev.status}${ev.attempt ? `#${ev.attempt}` : ''}`;
    connections.push(tag);
    console.log(`  conn: ${tag}`);
  });
  listener.on('error', (err: Error) => {
    errors.push(err.message);
    console.log(`  err : ${err.message}`);
  });

  console.log(`▸ starting listener (running ${SECONDS}s)...`);
  await listener.start();

  await new Promise((r) => setTimeout(r, SECONDS * 1000));

  console.log(`\n▸ stopping listener...`);
  await listener.stop();

  console.log('\n=== summary ===');
  console.log(`runtime              : ${SECONDS}s`);
  console.log(`watched wallets      : ${WATCHED.length}`);
  console.log(`connection events    : ${connections.length} — ${connections.join(', ')}`);
  console.log(`unique blocks seen   : ${blocksObserved.size}`);
  console.log(`watched trades found : ${trades.length}`);
  console.log(`non-fatal errors     : ${errors.length}`);

  // Pass gates
  const connected = connections.includes('ws/connected');
  const sawBlocks = blocksObserved.size > 0;
  const noFatalErrors = errors.length < 5; // a handful is OK on free RPC

  console.log('\n=== gates ===');
  console.log(`connected (ws or fallback)        : ${connected || connections.some(c => c.startsWith('http')) ? '✓' : '✗'}`);
  console.log(`processed at least one block      : ${sawBlocks ? '✓' : '✗'}`);
  console.log(`error count under threshold (<5)  : ${noFatalErrors ? '✓' : '✗'}`);

  const allPass = (connected || connections.some(c => c.startsWith('http'))) && sawBlocks && noFatalErrors;
  console.log(`\n${allPass ? '✓ PASS' : '✗ FAIL'}`);
  process.exit(allPass ? 0 : 1);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
