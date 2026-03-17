/**
 * Polymarket CLI Wrapper
 * Spawns the official Rust CLI binary with `-o json` flag and parses output.
 * Handles parsing of CLI market format into our internal Market type.
 */

import { spawn } from 'node:child_process';
import { logger } from '../utils/logger.js';
import type { CLIResult, CLIError, Market, Orderbook, OrderbookLevel, Position, Side, TokenInfo } from '../types/index.js';

const CLI_BINARY = process.env.POLYMARKET_CLI_PATH ?? 'polymarket';
const DEFAULT_TIMEOUT = 30_000;

async function exec<T = unknown>(args: string[], timeoutMs = DEFAULT_TIMEOUT): Promise<CLIResult<T>> {
  const command = `${CLI_BINARY} ${args.join(' ')}`;
  const start = Date.now();

  return new Promise((resolve, reject) => {
    const proc = spawn(CLI_BINARY, ['-o', 'json', ...args], {
      timeout: timeoutMs,
      env: { ...process.env },
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    proc.on('close', (code) => {
      const executionMs = Date.now() - start;
      if (code !== 0) {
        const error: CLIError = { success: false, error: stderr.trim() || `CLI exited with code ${code}`, command, exitCode: code ?? 1, stderr: stderr.trim() };
        logger.error('CLI error', { command, code, stderr: stderr.trim() });
        reject(error);
        return;
      }
      try {
        const data = JSON.parse(stdout.trim()) as T;
        logger.debug('CLI success', { command, executionMs });
        resolve({ success: true, data, raw: stdout.trim(), command, executionMs });
      } catch {
        resolve({ success: true, data: stdout.trim() as unknown as T, raw: stdout.trim(), command, executionMs });
      }
    });

    proc.on('error', (err) => {
      reject({ success: false, error: err.message, command, exitCode: -1, stderr: err.message } satisfies CLIError);
    });
  });
}

function parseCliMarket(raw: any): Market {
  let outcomeNames: string[] = [];
  let prices: number[] = [];
  let tokenIds: string[] = [];

  try {
    outcomeNames = typeof raw.outcomes === 'string' ? JSON.parse(raw.outcomes) : (raw.outcomes ?? []);
  } catch { outcomeNames = []; }

  try {
    const rawPrices = typeof raw.outcomePrices === 'string' ? JSON.parse(raw.outcomePrices) : (raw.outcomePrices ?? []);
    prices = rawPrices.map((p: string | number) => parseFloat(String(p)));
  } catch { prices = []; }

  try {
    tokenIds = typeof raw.clobTokenIds === 'string' ? JSON.parse(raw.clobTokenIds) : (raw.clobTokenIds ?? []);
  } catch { tokenIds = []; }

  const tokens: TokenInfo[] = outcomeNames.map((name: string, i: number) => ({
    tokenId: tokenIds[i] ?? '',
    outcome: name,
    price: prices[i] ?? 0,
  }));

  return {
    id: raw.id ?? raw.condition_id ?? '',
    conditionId: raw.conditionId ?? raw.condition_id ?? '',
    questionId: raw.questionID ?? raw.question_id ?? '',
    question: raw.question ?? '',
    slug: raw.slug ?? '',
    active: raw.active ?? false,
    closed: raw.closed ?? false,
    volume: parseFloat(raw.volumeNum ?? raw.volume ?? '0'),
    liquidity: parseFloat(raw.liquidityNum ?? raw.liquidity ?? '0'),
    outcomes: tokens,
    outcomePrices: prices,
    tokens,
    endDate: raw.endDate ?? '',
    tags: raw.tags ?? [],
  };
}

export async function healthCheck(): Promise<boolean> {
  try { await exec(['status']); return true; } catch { return false; }
}

export async function listMarkets(opts: { limit?: number; active?: boolean; offset?: number } = {}): Promise<CLIResult<Market[]>> {
  const args = ['markets', 'list'];
  if (opts.limit) args.push('--limit', String(opts.limit));
  if (opts.active !== undefined) args.push('--active', String(opts.active));
  if (opts.offset) args.push('--offset', String(opts.offset));
  const result = await exec<any[]>(args);
  const markets = (result.data ?? []).map(parseCliMarket);
  return { ...result, data: markets };
}

export async function getMarket(idOrSlug: string): Promise<CLIResult<Market>> {
  const result = await exec<any>(['markets', 'get', idOrSlug]);
  return { ...result, data: parseCliMarket(result.data) };
}

interface RawOrderbook { bids: Array<{ price: string; size: string }>; asks: Array<{ price: string; size: string }>; }

export async function getOrderbook(tokenId: string): Promise<CLIResult<Orderbook>> {
  const result = await exec<RawOrderbook>(['clob', 'book', tokenId]);
  const raw = result.data;
  const bids: OrderbookLevel[] = (raw.bids ?? []).map((l) => ({ price: parseFloat(l.price), size: parseFloat(l.size) }));
  const asks: OrderbookLevel[] = (raw.asks ?? []).map((l) => ({ price: parseFloat(l.price), size: parseFloat(l.size) }));
  const bestBid = bids[0]?.price ?? 0;
  const bestAsk = asks[0]?.price ?? 1;
  const orderbook: Orderbook = { tokenId, bids, asks, spread: bestAsk - bestBid, midpoint: (bestAsk + bestBid) / 2, timestamp: new Date().toISOString() };
  return { ...result, data: orderbook };
}

export async function marketOrder(tokenId: string, side: Side, amount: number): Promise<CLIResult> {
  logger.info('Placing market order', { tokenId, side, amount });
  return exec(['clob', 'market-order', '--token', tokenId, '--side', side, '--amount', String(amount)]);
}

export async function limitOrder(tokenId: string, side: Side, price: number, size: number): Promise<CLIResult> {
  logger.info('Placing limit order', { tokenId, side, price, size });
  return exec(['clob', 'create-order', '--token', tokenId, '--side', side, '--price', String(price), '--size', String(size)]);
}

export async function cancelOrder(orderId: string): Promise<CLIResult> { return exec(['clob', 'cancel', orderId]); }
export async function cancelAll(): Promise<CLIResult> { return exec(['clob', 'cancel-all']); }

export async function getBalance(): Promise<CLIResult<{ balance: number }>> {
  return exec(['clob', 'balance', '--asset-type', 'collateral']);
}

export async function getPositions(address: string): Promise<CLIResult<Position[]>> {
  return exec<Position[]>(['data', 'positions', address]);
}

export async function getOpenOrders(): Promise<CLIResult> { return exec(['clob', 'orders']); }
export async function getTradeHistory(): Promise<CLIResult> { return exec(['clob', 'trades']); }

export async function walletShow(): Promise<CLIResult> { return exec(['wallet', 'show']); }

// ADR-010: Smart order routing — spread > 3¢ = limit at midpoint, else market
export async function smartOrder(tokenId: string, side: Side, amount: number): Promise<CLIResult> {
  const ob = await getOrderbook(tokenId);
  const { spread, midpoint } = ob.data;
  if (spread > 0.03) {
    logger.info('Spread > 3¢, using limit order at midpoint', { spread, midpoint });
    const size = Math.floor(amount / midpoint);
    return limitOrder(tokenId, side, midpoint, size);
  }
  logger.info('Spread ≤ 3¢, using market order', { spread });
  return marketOrder(tokenId, side, amount);
}
