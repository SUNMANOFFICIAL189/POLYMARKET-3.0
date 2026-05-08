// Branch 2 Phase 1 triangulation — throwaway recon (DO NOT IMPORT FROM PRODUCTION).
// Scans recent Polygon blocks for matchOrders txs to the verified production
// contract and decodes a sample. Surfaces distinct values across the run so the
// remaining unknowns (arg5, arg6, side=1, multi-maker, signatureType set) can be
// nailed down before building the production decoder.
//
// Run: ./node_modules/.bin/tsx scripts/recon/scan-recent-matchorders.ts [BLOCKS] [SAMPLE]
//   BLOCKS  — how many recent blocks to scan (default 30 ≈ 1 min of activity)
//   SAMPLE  — max candidates to decode (default 60)

import { Interface, JsonRpcProvider, type TransactionResponse } from 'ethers';

const PRIMARY_RPC = process.env.POLYGON_RPC ?? 'https://polygon-bor-rpc.publicnode.com';
const FALLBACK_RPC = 'https://polygon-pokt.nodies.app';
const CONTRACT = '0xE111180000d2663C0091e4f400237545B87B996B'.toLowerCase();
const SELECTOR = '0x3c2b4399';
const BLOCKS = Number(process.argv[2] ?? '30');
const SAMPLE = Number(process.argv[3] ?? '60');

const ORDER_TUPLE =
  '(uint256,address,address,uint256,uint256,uint256,uint8,uint8,uint256,bytes32,bytes32,bytes)';
const FN_SIG = `matchOrders(bytes32,${ORDER_TUPLE},${ORDER_TUPLE}[],uint256,uint256[],uint256,uint256[])`;
const iface = new Interface([`function ${FN_SIG}`]);

async function getProvider(): Promise<JsonRpcProvider> {
  for (const url of [PRIMARY_RPC, FALLBACK_RPC]) {
    try {
      const p = new JsonRpcProvider(url);
      await p.getBlockNumber();
      console.log('using rpc:', url);
      return p;
    } catch (e) {
      console.warn('rpc dead:', url, (e as Error).message);
    }
  }
  throw new Error('no working rpc');
}

interface TradeSummary {
  txHash: string;
  block: number;
  conditionId: string;
  arg3: string;
  arg4: string[];
  arg5: string;
  arg6: string[];
  takerMaker: string;
  takerSide: number;
  takerSigType: number;
  takerPriceRatio: string;
  makerCount: number;
  makers: { addr: string; side: number; sigType: number; priceRatio: string }[];
  fillSize6dec: bigint;
}

function ratio(makerAmount: bigint, takerAmount: bigint): string {
  if (takerAmount === 0n) return 'div0';
  const r = Number((makerAmount * 10000n) / takerAmount) / 10000;
  return r.toFixed(4);
}

function decodeTxFromData(tx: TransactionResponse): TradeSummary | null {
  let parsed;
  try {
    parsed = iface.parseTransaction({ data: tx.data, value: tx.value });
  } catch {
    return null;
  }
  if (!parsed) return null;

  const [arg0, takerOrder, makerOrders, arg3, arg4Arr, arg5, arg6Arr] = parsed.args as [
    string,
    unknown[],
    unknown[][],
    bigint,
    bigint[],
    bigint,
    bigint[],
  ];

  const tMakerAmt = takerOrder[4] as bigint;
  const tTakerAmt = takerOrder[5] as bigint;

  return {
    txHash: tx.hash,
    block: tx.blockNumber ?? 0,
    conditionId: arg0,
    arg3: arg3.toString(),
    arg4: arg4Arr.map((x) => x.toString()),
    arg5: arg5.toString(),
    arg6: arg6Arr.map((x) => x.toString()),
    takerMaker: takerOrder[1] as string,
    takerSide: Number(takerOrder[6]),
    takerSigType: Number(takerOrder[7]),
    takerPriceRatio: ratio(tMakerAmt, tTakerAmt),
    makerCount: makerOrders.length,
    makers: makerOrders.map((mo) => ({
      addr: mo[1] as string,
      side: Number(mo[6]),
      sigType: Number(mo[7]),
      priceRatio: ratio(mo[4] as bigint, mo[5] as bigint),
    })),
    fillSize6dec: arg3 + arg4Arr.reduce((a, b) => a + b, 0n),
  };
}

async function main() {
  const provider = await getProvider();
  const head = await provider.getBlockNumber();
  const startBlock = head - BLOCKS + 1;
  console.log(`scanning blocks ${startBlock}..${head} (${BLOCKS} blocks ≈ ${(BLOCKS * 2 / 60).toFixed(1)} min of activity)`);
  console.log(`sample cap: ${SAMPLE} candidates`);

  // Walk blocks; collect candidate txs from prefetched data (no extra getTransaction calls)
  const candidates: TransactionResponse[] = [];
  let totalSeen = 0;
  for (let n = startBlock; n <= head; n++) {
    const b = await provider.getBlock(n, true);
    if (!b) continue;
    for (const tx of b.prefetchedTransactions ?? []) {
      if ((tx.to ?? '').toLowerCase() === CONTRACT && tx.data?.startsWith(SELECTOR)) {
        totalSeen++;
        if (candidates.length < SAMPLE) candidates.push(tx);
      }
    }
    if ((n - startBlock + 1) % 5 === 0) process.stdout.write(`.${n - startBlock + 1}/${BLOCKS} `);
  }
  process.stdout.write('\n');
  console.log(`scanned: ${BLOCKS} blocks · matchOrders txs found: ${totalSeen} · sampling: ${candidates.length}`);

  if (candidates.length === 0) {
    console.log('no matchOrders txs in window — try widening BLOCKS');
    return;
  }

  // Decode (no extra RPC calls — calldata is already on the prefetched tx)
  const trades: TradeSummary[] = [];
  for (const tx of candidates) {
    const t = decodeTxFromData(tx);
    if (t) trades.push(t);
  }
  console.log(`decoded: ${trades.length}/${candidates.length}`);

  // Per-tx table (truncated columns)
  console.log('\n=== PER-TX (sampled) ===');
  console.log('block      | mks | tSide | tSig | tPrice | mSides    | mSigs   | mPrices       | size(6d)        | arg5      | arg6');
  console.log('-----------|-----|-------|------|--------|-----------|---------|---------------|------------------|-----------|---------');
  for (const t of trades.slice(0, 30)) {
    const mSides = t.makers.map((m) => m.side).join(',');
    const mSigs = t.makers.map((m) => m.sigType).join(',');
    const mPrices = t.makers.map((m) => m.priceRatio).join(',').slice(0, 13);
    console.log(
      `${String(t.block).padEnd(10)} | ${String(t.makerCount).padEnd(3)} | ${String(t.takerSide).padEnd(5)} | ${String(t.takerSigType).padEnd(4)} | ${t.takerPriceRatio.padEnd(6)} | ${mSides.padEnd(9)} | ${mSigs.padEnd(7)} | ${mPrices.padEnd(13)} | ${t.fillSize6dec.toString().padEnd(16)} | ${t.arg5.padEnd(9)} | [${t.arg6.join(',')}]`,
    );
  }
  if (trades.length > 30) console.log(`(... ${trades.length - 30} more rows omitted)`);

  // Aggregate
  const distinct = <T>(arr: T[]): T[] => Array.from(new Set(arr));
  const allTakerSides = distinct(trades.map((t) => t.takerSide));
  const allMakerSides = distinct(trades.flatMap((t) => t.makers.map((m) => m.side)));
  const allTakerSigs = distinct(trades.map((t) => t.takerSigType));
  const allMakerSigs = distinct(trades.flatMap((t) => t.makers.map((m) => m.sigType)));
  const arg5Set = distinct(trades.map((t) => t.arg5));
  const arg6Flat = distinct(trades.flatMap((t) => t.arg6));
  const makerCountDist: Record<number, number> = {};
  for (const t of trades) makerCountDist[t.makerCount] = (makerCountDist[t.makerCount] ?? 0) + 1;

  console.log('\n=== AGGREGATE ===');
  console.log('distinct taker.side       :', allTakerSides);
  console.log('distinct maker[*].side    :', allMakerSides);
  console.log('distinct taker.sigType    :', allTakerSigs);
  console.log('distinct maker[*].sigType :', allMakerSigs);
  console.log('distinct arg5 (uint256)   :', arg5Set.length, '— sample:', arg5Set.slice(0, 8));
  console.log('distinct arg6 (uint256)   :', arg6Flat.length, '— sample:', arg6Flat.slice(0, 8));
  console.log('makerCount distribution   :', makerCountDist);

  // Price-math sanity: arg3 / fillSize6dec should equal taker price ratio when taker is BUY,
  // or (1 - takerPriceRatio) when taker is SELL.
  console.log('\n=== PRICE-MATH SANITY ===');
  const sample = trades.slice(0, 6);
  for (const t of sample) {
    const fillSize = Number(t.fillSize6dec);
    if (fillSize === 0) continue;
    const arg3Pct = Number(BigInt(t.arg3) * 10000n / t.fillSize6dec) / 10000;
    const tPrice = Number(t.takerPriceRatio);
    const matchesBUY = Math.abs(arg3Pct - tPrice) < 0.001;
    const matchesSELL = Math.abs(arg3Pct - (1 - tPrice)) < 0.001;
    console.log(`  side=${t.takerSide} tPrice=${tPrice.toFixed(4)} arg3/size=${arg3Pct.toFixed(4)} → ${matchesBUY ? 'matches BUY (arg3=takerPrice·size)' : matchesSELL ? 'matches SELL (arg3=(1-takerPrice)·size)' : 'NEITHER'}`);
  }

  // Patterns of interest
  const sellSamples = trades.filter((t) => t.takerSide === 1).slice(0, 3);
  const multiMaker = trades.filter((t) => t.makerCount >= 2).slice(0, 3);
  const nonZeroArg6 = trades.filter((t) => t.arg6.some((x) => x !== '0')).slice(0, 3);
  const distinctArg5 = trades.filter((t) => t.arg5 !== '1591690').slice(0, 3);

  console.log('\n=== PATTERNS OF INTEREST ===');
  console.log('SELL-side taker examples:', sellSamples.length);
  for (const t of sellSamples) console.log(`  ${t.txHash}  block=${t.block} tPrice=${t.takerPriceRatio} arg3=${t.arg3} fillSize=${t.fillSize6dec} sig=${t.takerSigType}`);

  console.log('\nMulti-maker examples    :', multiMaker.length);
  for (const t of multiMaker) console.log(`  ${t.txHash}  block=${t.block} makers=${t.makerCount} mSides=${t.makers.map(m=>m.side).join(',')} mPrices=${t.makers.map(m=>m.priceRatio).join(',')}`);

  console.log('\nNon-zero arg6 examples  :', nonZeroArg6.length);
  for (const t of nonZeroArg6) console.log(`  ${t.txHash}  arg6=${JSON.stringify(t.arg6)}`);

  console.log('\nNon-1591690 arg5 samples:', distinctArg5.length);
  for (const t of distinctArg5.slice(0, 5)) console.log(`  ${t.txHash}  arg5=${t.arg5} fillSize=${t.fillSize6dec}`);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
