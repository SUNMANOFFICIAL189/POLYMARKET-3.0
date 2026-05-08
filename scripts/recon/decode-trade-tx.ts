// Branch 2 Phase 1 — throwaway recon (DO NOT IMPORT FROM PRODUCTION CODE).
// Decodes the verified test transaction with the verified-correct production ABI
// (selector 0x3c2b4399, 12-field Order tuple, 7-arg matchOrders) and prints every
// field for cross-referencing against data-api ground truth.
//
// Run: ./node_modules/.bin/tsx scripts/recon/decode-trade-tx.ts
//
// Reference: _NEXT_STEPS/2026-05-08-master-handoff.md

import { Interface, JsonRpcProvider } from 'ethers';

const RPC_URL = process.env.POLYGON_RPC ?? 'https://polygon-bor-rpc.publicnode.com';
const TX_HASH = '0xda0cc9a69a86c60f4cc82b9be586b910419a74dbfef4ae1c78250d903a749085';
const EXPECTED_SELECTOR = '0x3c2b4399';
const EXPECTED_TO = '0xE111180000d2663C0091e4f400237545B87B996B';

// Verified-correct production ABI (per 2026-05-08 CTDD investigation).
// Order tuple is 12 fields with double-bytes32 — NOT the 13-field MIT format.
const ORDER_TUPLE =
  '(uint256,address,address,uint256,uint256,uint256,uint8,uint8,uint256,bytes32,bytes32,bytes)';
const FN_SIG = `matchOrders(bytes32,${ORDER_TUPLE},${ORDER_TUPLE}[],uint256,uint256[],uint256,uint256[])`;

const iface = new Interface([`function ${FN_SIG}`]);

// Slot-position labels for the 12-field Order tuple. We don't yet know the field
// MEANINGS — that's the whole point of this recon. These are just position keys.
const SLOT = [
  '[ 0] uint256',
  '[ 1] address',
  '[ 2] address',
  '[ 3] uint256',
  '[ 4] uint256',
  '[ 5] uint256',
  '[ 6] uint8   ',
  '[ 7] uint8   ',
  '[ 8] uint256',
  '[ 9] bytes32',
  '[10] bytes32',
  '[11] bytes  ',
];

function fmt(v: unknown): string {
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return `[array len=${v.length}]`;
  return String(v);
}

async function main() {
  // 1. Selector roundtrip — sanity check before fetching anything
  const computedSelector = iface.getFunction('matchOrders')!.selector;
  console.log('=== ABI SANITY ===');
  console.log('signature       :', FN_SIG);
  console.log('computed select :', computedSelector);
  console.log('expected select :', EXPECTED_SELECTOR);
  console.log('selector match  :', computedSelector === EXPECTED_SELECTOR ? 'YES' : 'NO');
  if (computedSelector !== EXPECTED_SELECTOR) {
    console.error('\nSELECTOR MISMATCH — ABI does not produce the expected selector. Aborting.');
    process.exit(1);
  }

  // 2. Fetch tx by hash
  const provider = new JsonRpcProvider(RPC_URL);
  const tx = await provider.getTransaction(TX_HASH);
  if (!tx) {
    console.error('tx not found at RPC', RPC_URL);
    process.exit(1);
  }
  const actualSelector = tx.data.slice(0, 10);

  console.log('\n=== TX BASICS ===');
  console.log('rpc             :', RPC_URL);
  console.log('txHash          :', TX_HASH);
  console.log('blockNumber     :', tx.blockNumber);
  console.log('from            :', tx.from);
  console.log('to              :', tx.to);
  console.log('to matches expected contract :', tx.to?.toLowerCase() === EXPECTED_TO.toLowerCase() ? 'YES' : 'NO');
  console.log('value (wei)     :', tx.value.toString());
  console.log('calldata bytes  :', (tx.data.length - 2) / 2);
  console.log('actual selector :', actualSelector);
  console.log('selector match  :', actualSelector === EXPECTED_SELECTOR ? 'YES' : 'NO');

  if (actualSelector !== EXPECTED_SELECTOR) {
    console.error('\nThe tx does not call matchOrders. Aborting.');
    process.exit(1);
  }

  // 3. Parse calldata with the 7-arg ABI
  const parsed = iface.parseTransaction({ data: tx.data, value: tx.value });
  if (!parsed) {
    console.error('parseTransaction returned null');
    process.exit(1);
  }

  console.log('\n=== PARSED FUNCTION ===');
  console.log('name :', parsed.name);
  console.log('signature reconstructed :', parsed.signature);

  const [arg0, takerOrder, makerOrders, arg3, arg4Arr, arg5, arg6Arr] = parsed.args as [
    string,
    unknown[],
    unknown[][],
    bigint,
    bigint[],
    bigint,
    bigint[],
  ];

  console.log('\n=== TOP-LEVEL ARGS (besides Order tuples) ===');
  console.log('arg0 bytes32   :', arg0);
  console.log('arg3 uint256   :', arg3.toString());
  console.log('arg4 uint256[] :', arg4Arr.map((x) => x.toString()));
  console.log('arg5 uint256   :', arg5.toString());
  console.log('arg6 uint256[] :', arg6Arr.map((x) => x.toString()));

  console.log('\n=== TAKER ORDER (12 fields, slot positions only) ===');
  takerOrder.forEach((v, i) => {
    console.log(`  ${SLOT[i]} =`, fmt(v));
  });

  console.log(`\n=== MAKER ORDERS — count: ${makerOrders.length} ===`);
  makerOrders.forEach((mo, j) => {
    console.log(`\nmaker[${j}]:`);
    mo.forEach((v, i) => {
      console.log(`  ${SLOT[i]} =`, fmt(v));
    });
  });

  // 4. Ground-truth cross-reference reminders
  console.log('\n=== CROSS-REFERENCE TARGETS (data-api ground truth) ===');
  console.log('proxyWallet   :  0x204f72f35326db932158cba6adff0b9a1da95e14');
  console.log('side          :  BUY');
  console.log('size          :  376.02');
  console.log('price         :  0.17');
  console.log('conditionId   :  0xf30520eba63519f7f6f63b9de643d4ef8bac865e310e15d8e673448d56f17003');
  console.log('slug          :  wta-gibson-shnaide-2026-05-07');
  console.log('\nField-mapping notes go in _NEXT_STEPS/branch-2-recon-phase-1.md');
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
