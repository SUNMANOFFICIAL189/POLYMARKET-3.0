// Phase 2 verification — runs the production decoder against known test txs
// (no test framework in this repo; this script is the golden-vector check).
//
// Run: ./node_modules/.bin/tsx scripts/recon/verify-decoder.ts

import { JsonRpcProvider } from 'ethers';
import {
  decodeFromTransactionResponse,
  decodeAllFromTransactionResponse,
  type ParsedTrade,
} from '../../src/monitor/match-orders-decoder.js';

const RPC = process.env.POLYGON_RPC ?? 'https://polygon-bor-rpc.publicnode.com';

interface Case {
  name: string;
  txHash: string;
  watchedWallets: string[];
  asserts: (trades: ParsedTrade[]) => string[];
}

const CASES: Case[] = [
  {
    // The verified golden test tx — BUY 376.02 at 0.17 by data-api wallet 0x204f72…
    name: 'golden BUY taker — single maker (NegRisk match)',
    txHash: '0xda0cc9a69a86c60f4cc82b9be586b910419a74dbfef4ae1c78250d903a749085',
    watchedWallets: ['0x204f72f35326db932158cba6adff0b9a1da95e14'],
    asserts: (ts) => {
      const errs: string[] = [];
      if (ts.length !== 1) errs.push(`expected 1 trade, got ${ts.length}`);
      const t = ts[0];
      if (!t) return errs;
      if (t.wallet !== '0x204f72f35326db932158cba6adff0b9a1da95e14') errs.push(`wallet mismatch: ${t.wallet}`);
      if (t.side !== 'buy') errs.push(`side expected buy, got ${t.side}`);
      if (Math.abs(t.entryPrice - 0.17) > 0.001) errs.push(`entryPrice expected ~0.17, got ${t.entryPrice}`);
      if (Math.abs(t.size - 63.9234) > 0.01) errs.push(`size expected ~63.92 USDC, got ${t.size}`);
      if (t.conditionId !== '0xf30520eba63519f7f6f63b9de643d4ef8bac865e310e15d8e673448d56f17003')
        errs.push(`conditionId mismatch: ${t.conditionId}`);
      if (t.matchType !== 'taker') errs.push(`matchType expected taker, got ${t.matchType}`);
      if (!t.tokenId || t.tokenId.length < 70) errs.push(`tokenId looks malformed: ${t.tokenId.slice(0, 20)}...`);
      return errs;
    },
  },
  {
    // No-match case: same tx, but watching an unrelated wallet
    name: 'no watched wallet match returns empty array',
    txHash: '0xda0cc9a69a86c60f4cc82b9be586b910419a74dbfef4ae1c78250d903a749085',
    watchedWallets: ['0x0000000000000000000000000000000000000001'],
    asserts: (ts) => {
      const errs: string[] = [];
      if (ts.length !== 0) errs.push(`expected empty array, got ${ts.length} trades`);
      return errs;
    },
  },
  {
    // Multi-maker tx from triangulation pass (taker BUY at 0.30, 21 makers)
    // Watch the taker — should yield exactly 1 ParsedTrade
    name: 'multi-maker tx, only taker wallet watched',
    txHash: '', // filled at runtime from the triangulation if available
    watchedWallets: [],
    asserts: () => [],
  },
];

function fmtTrade(t: ParsedTrade): string {
  return `wallet=${t.wallet.slice(0, 10)}... side=${t.side} tokenId=${t.tokenId.slice(0, 14)}... price=${t.entryPrice.toFixed(4)} size=$${t.size.toFixed(4)} match=${t.matchType} arg5=${t.arg5}`;
}

async function main() {
  const provider = new JsonRpcProvider(RPC);
  console.log('rpc:', RPC);
  console.log();

  let pass = 0;
  let fail = 0;

  for (const c of CASES) {
    if (!c.txHash) continue; // skip placeholder cases
    process.stdout.write(`▸ ${c.name}\n  tx: ${c.txHash}\n`);
    try {
      const tx = await provider.getTransaction(c.txHash);
      if (!tx) {
        console.log('  ✗ FAIL: tx not found');
        fail++;
        continue;
      }
      const result = decodeFromTransactionResponse(tx, c.watchedWallets);
      if (result === null) {
        console.log('  ✗ FAIL: decoder returned null (tx not matchOrders or not to production contract)');
        fail++;
        continue;
      }
      console.log(`  decoded ${result.length} ParsedTrade(s):`);
      for (const t of result) console.log(`    ${fmtTrade(t)}`);

      const errs = c.asserts(result);
      if (errs.length === 0) {
        console.log('  ✓ PASS');
        pass++;
      } else {
        console.log('  ✗ FAIL:');
        for (const e of errs) console.log(`    - ${e}`);
        fail++;
      }
    } catch (e) {
      console.log(`  ✗ FAIL: ${(e as Error).message}`);
      fail++;
    }
    console.log();
  }

  // Smoke test against the latest block — decode every matchOrders Order without filter
  // to exercise the SELL path and multi-maker path on real data.
  console.log('▸ smoke-test on most recent block (decode all Orders, count by side, sanity-check price math)');
  const head = await provider.getBlockNumber();
  const block = await provider.getBlock(head, true);
  if (!block) {
    console.log('  ✗ could not fetch latest block');
    fail++;
  } else {
    let mo = 0;
    let totalOrders = 0;
    let buyCount = 0;
    let sellCount = 0;
    let multiMaker = 0;
    let priceOutOfRange = 0;
    for (const tx of block.prefetchedTransactions ?? []) {
      const all = decodeAllFromTransactionResponse(tx);
      if (all === null) continue;
      mo++;
      if (all.length > 2) multiMaker++;
      for (const t of all) {
        totalOrders++;
        if (t.side === 'buy') buyCount++;
        else sellCount++;
        if (t.entryPrice < 0 || t.entryPrice > 1.0001) priceOutOfRange++;
      }
    }
    console.log(`  block ${head}: matchOrders txs=${mo}, total Orders decoded=${totalOrders}`);
    console.log(`  side distribution: buy=${buyCount} sell=${sellCount}`);
    console.log(`  multi-maker txs (>2 Orders): ${multiMaker}`);
    console.log(`  prices outside [0,1]: ${priceOutOfRange}`);
    if (priceOutOfRange === 0) {
      console.log('  ✓ PASS: every decoded price is in [0, 1]');
      pass++;
    } else {
      console.log(`  ✗ FAIL: ${priceOutOfRange} Orders had prices outside [0, 1]`);
      fail++;
    }

    // Show a SELL sample if found
    let sellSample: ParsedTrade | null = null;
    for (const tx of block.prefetchedTransactions ?? []) {
      const all = decodeAllFromTransactionResponse(tx);
      if (!all) continue;
      const s = all.find((t) => t.side === 'sell');
      if (s) { sellSample = s; break; }
    }
    if (sellSample) {
      console.log('  sample SELL Order (sanity):');
      console.log(`    ${fmtTrade(sellSample)}`);
    } else {
      console.log('  (no SELL Order in this block — try again during active trading)');
    }
  }

  console.log(`\n=== ${pass} pass / ${fail} fail ===`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
