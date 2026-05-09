// Pure decoder for Polymarket production matchOrders calls.
//
// Function signature (selector 0x3c2b4399, verified 2026-05-08):
//   matchOrders(
//     bytes32 conditionId,
//     Order takerOrder,
//     Order[] makerOrders,
//     uint256 takerFillCollateral,
//     uint256[] makerFillCollaterals,
//     uint256 arg5_opaque,
//     uint256[] arg6_unused
//   )
//
// Order (12 fields, double-bytes32 — NOT the 13-field MIT format):
//   uint256 salt, address maker, address signer, uint256 tokenId,
//   uint256 makerAmount, uint256 takerAmount, uint8 side, uint8 signatureType,
//   uint256 timestamp, bytes32 metadata, bytes32 builder, bytes signature
//
// Field semantics confirmed by the EIP-712 type string embedded in maker
// signatures and triangulated across 60 sampled txs (see
// `_NEXT_STEPS/branch-2-recon-phase-1.md`).

import { Interface, type TransactionResponse } from 'ethers';
import type { Side } from '../types/index.js';

// Polymarket runs at least TWO active matchOrders contracts on Polygon, both
// using the same ABI and selector. Verified 2026-05-10 by enumeration:
//   0xE111180000d2663C0091e4f400237545B87B996B  ~75% of volume
//   0xe2222d279d744050d28e00520010520000310F59  ~25% of volume
// A wallet's data-api `/trades` history is the union of both. The decoder must
// accept either address; restricting to one was the root cause of Phase 6's
// inverted recall numbers (2026-05-09 forensic).
const PRODUCTION_CONTRACTS = [
  '0xE111180000d2663C0091e4f400237545B87B996B',
  '0xe2222d279d744050d28e00520010520000310F59',
].map((a) => a.toLowerCase());
const SELECTOR = '0x3c2b4399';
const ORDER_TUPLE =
  '(uint256,address,address,uint256,uint256,uint256,uint8,uint8,uint256,bytes32,bytes32,bytes)';
const FN_SIG = `matchOrders(bytes32,${ORDER_TUPLE},${ORDER_TUPLE}[],uint256,uint256[],uint256,uint256[])`;

const iface = new Interface([`function ${FN_SIG}`]);

export const MATCH_ORDERS_CONTRACTS = PRODUCTION_CONTRACTS;
export const MATCH_ORDERS_SELECTOR = SELECTOR;

export interface ParsedTrade {
  wallet: string;            // lowercase; equals data-api proxyWallet
  side: Side;                // 'buy' | 'sell' (decoded from Order.side enum: 0=buy, 1=sell)
  tokenId: string;           // ERC-1155 conditional-token id (YES or NO leg)
  conditionId: string;       // 0x… — top-level matchOrders arg
  entryPrice: number;        // 0..1 fill price per outcome token
  size: number;              // USDC notional (price × tokens) — matches existing LeaderTrade.size convention
  txHash: string;
  blockNumber: number;
  timestamp: number;         // ms epoch (from Order.timestamp)
  fromAddress: string;       // tx sender (relayer / Safe operator) — informational
  arg5: string;              // opaque per-tx field (logged, not load-bearing)
  matchType: 'taker' | 'maker';
}

export interface DecoderInputTx {
  data: string;
  to: string | null;
  from: string;
  hash: string;
  blockNumber: number | null;
  value: bigint;
}

/**
 * Decode a Polymarket matchOrders tx and return one ParsedTrade per Order whose
 * `maker` field is in `watchedWallets`.
 *
 * Returns:
 *   - `null` if the tx is not a matchOrders call to the production contract
 *     (caller can use this to skip cheaply during block scanning)
 *   - `[]` if it is matchOrders but no Order matches a watched wallet
 *   - `ParsedTrade[]` otherwise (length 1..N)
 *
 * Pricing model:
 *   mintSize = arg3 + sum(arg4)                       — total complete-set mint or trade quantity
 *   For BUY:  fillPrice = own_collateral / mintSize    — USDC paid per token
 *   For SELL: fillPrice = (mintSize - own_collateral) / mintSize  — USDC received per token
 *   USDC notional = fillPrice * (mintSize / 1e6)       — in dollars
 *
 * This handles both NegRisk complete-set matches (taker + maker prices ≈ 1.0,
 * both technically BUYs on opposite legs) and orderbook matches (taker SELL vs
 * maker BUY on same tokenId) uniformly.
 */
export function decodeMatchOrders(
  tx: DecoderInputTx,
  watchedWallets: Iterable<string>,
): ParsedTrade[] | null {
  if (!tx.to || !PRODUCTION_CONTRACTS.includes(tx.to.toLowerCase())) return null;
  if (!tx.data || !tx.data.startsWith(SELECTOR)) return null;

  let parsed;
  try {
    parsed = iface.parseTransaction({ data: tx.data, value: tx.value });
  } catch {
    return null;
  }
  if (!parsed) return null;

  const watched = new Set<string>();
  for (const w of watchedWallets) watched.add(w.toLowerCase());
  if (watched.size === 0) return [];

  const [conditionId, takerOrder, makerOrders, arg3, arg4Arr, arg5] = parsed.args as unknown as [
    string,
    unknown[],
    unknown[][],
    bigint,
    bigint[],
    bigint,
    bigint[],
  ];

  const mintSize = arg3 + arg4Arr.reduce((a, b) => a + b, 0n);
  if (mintSize === 0n) return [];

  const trades: ParsedTrade[] = [];

  const buildTrade = (
    order: unknown[],
    ownCollateral: bigint,
    matchType: 'taker' | 'maker',
  ): ParsedTrade | null => {
    const wallet = (order[1] as string).toLowerCase();
    if (!watched.has(wallet)) return null;

    const tokenId = (order[3] as bigint).toString();
    const sideEnum = Number(order[6]);
    const side: Side = sideEnum === 0 ? 'buy' : 'sell';
    const timestampMs = Number(order[8] as bigint);

    // Numerator chosen so that `numerator / mintSize` equals the wallet's actual fill price.
    // For BUY: wallet paid USDC = own_collateral.
    // For SELL: wallet received USDC = mintSize - own_collateral.
    const numerator = side === 'buy' ? ownCollateral : mintSize - ownCollateral;
    // 4-dp price computed in integer math to avoid float drift on division.
    const entryPrice = Number((numerator * 10000n) / mintSize) / 10000;
    // USDC notional to match existing LeaderTrade.size = tokens * price (in USDC, 6 decimals → number).
    const sizeUsdc = Number(numerator) / 1_000_000;

    return {
      wallet,
      side,
      tokenId,
      conditionId,
      entryPrice,
      size: sizeUsdc,
      txHash: tx.hash,
      blockNumber: tx.blockNumber ?? 0,
      timestamp: timestampMs,
      fromAddress: tx.from.toLowerCase(),
      arg5: arg5.toString(),
      matchType,
    };
  };

  const takerTrade = buildTrade(takerOrder, arg3, 'taker');
  if (takerTrade) trades.push(takerTrade);

  for (let i = 0; i < makerOrders.length; i++) {
    const t = buildTrade(makerOrders[i], arg4Arr[i], 'maker');
    if (t) trades.push(t);
  }

  return trades;
}

/** Convenience for callers that already have an ethers TransactionResponse. */
export function decodeFromTransactionResponse(
  tx: TransactionResponse,
  watchedWallets: Iterable<string>,
): ParsedTrade[] | null {
  return decodeMatchOrders(
    {
      data: tx.data,
      to: tx.to,
      from: tx.from,
      hash: tx.hash,
      blockNumber: tx.blockNumber,
      value: tx.value,
    },
    watchedWallets,
  );
}

/**
 * Decode every Order in the matchOrders tx without the watched-wallet filter.
 * Used by verification / debugging. Production code should use `decodeMatchOrders`
 * with a watch list to avoid emitting noise.
 */
export function decodeAllOrders(tx: DecoderInputTx): ParsedTrade[] | null {
  if (!tx.to || !PRODUCTION_CONTRACTS.includes(tx.to.toLowerCase())) return null;
  if (!tx.data || !tx.data.startsWith(SELECTOR)) return null;

  let parsed;
  try {
    parsed = iface.parseTransaction({ data: tx.data, value: tx.value });
  } catch {
    return null;
  }
  if (!parsed) return null;

  const [conditionId, takerOrder, makerOrders, arg3, arg4Arr, arg5] = parsed.args as unknown as [
    string,
    unknown[],
    unknown[][],
    bigint,
    bigint[],
    bigint,
    bigint[],
  ];

  const mintSize = arg3 + arg4Arr.reduce((a, b) => a + b, 0n);
  if (mintSize === 0n) return [];

  const trades: ParsedTrade[] = [];

  const buildTrade = (
    order: unknown[],
    ownCollateral: bigint,
    matchType: 'taker' | 'maker',
  ): ParsedTrade => {
    const wallet = (order[1] as string).toLowerCase();
    const tokenId = (order[3] as bigint).toString();
    const sideEnum = Number(order[6]);
    const side: Side = sideEnum === 0 ? 'buy' : 'sell';
    const timestampMs = Number(order[8] as bigint);

    const numerator = side === 'buy' ? ownCollateral : mintSize - ownCollateral;
    const entryPrice = Number((numerator * 10000n) / mintSize) / 10000;
    const sizeUsdc = Number(numerator) / 1_000_000;

    return {
      wallet,
      side,
      tokenId,
      conditionId,
      entryPrice,
      size: sizeUsdc,
      txHash: tx.hash,
      blockNumber: tx.blockNumber ?? 0,
      timestamp: timestampMs,
      fromAddress: tx.from.toLowerCase(),
      arg5: arg5.toString(),
      matchType,
    };
  };

  trades.push(buildTrade(takerOrder, arg3, 'taker'));
  for (let i = 0; i < makerOrders.length; i++) {
    trades.push(buildTrade(makerOrders[i], arg4Arr[i], 'maker'));
  }
  return trades;
}

export function decodeAllFromTransactionResponse(tx: TransactionResponse): ParsedTrade[] | null {
  return decodeAllOrders({
    data: tx.data,
    to: tx.to,
    from: tx.from,
    hash: tx.hash,
    blockNumber: tx.blockNumber,
    value: tx.value,
  });
}
