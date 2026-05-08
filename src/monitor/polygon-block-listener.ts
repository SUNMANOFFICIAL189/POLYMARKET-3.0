// Polygon block listener — subscribes to newHeads via WSS (primary) with HTTP-polling
// fallback. For each new block, fetches full transactions, runs the matchOrders decoder
// against the watched-wallet list, and emits one 'new-trade' event per matched Order.
//
// EventEmitter API parallel to existing WalletMonitor (so Phase 4 wiring is symmetric):
//   listener.setWatchers(addresses)
//   listener.start()
//   listener.stop()
//   listener.on('new-trade', (trade: ParsedTrade) => ...)
//   listener.on('connection', ({ mode, status, attempt? }) => ...)
//   listener.on('error', (err) => ...)  // non-fatal transport errors

import { EventEmitter } from 'events';
import { JsonRpcProvider, WebSocketProvider } from 'ethers';
import { logger } from '../utils/logger.js';
import {
  decodeFromTransactionResponse,
  type ParsedTrade,
} from './match-orders-decoder.js';

export interface PolygonBlockListenerOpts {
  /** WSS endpoint. Default: publicnode (verified working 2026-05-08). */
  wssUrl?: string;
  /** HTTPS endpoint for fallback. Default: same publicnode host over HTTPS. */
  httpUrl?: string;
  /** HTTP polling interval in ms. Default: 1500 (~1 polygon block). */
  pollIntervalMs?: number;
  /** WS reconnect attempts before downgrading to HTTP polling. Default: 5. */
  maxWsReconnectAttempts?: number;
  /** Initial WS reconnect backoff (ms). Default: 1000. Caps at 30s. */
  initialBackoffMs?: number;
}

type ConnectionMode = 'ws' | 'http-poll' | 'idle';

export interface ConnectionEvent {
  mode: ConnectionMode;
  status: 'connected' | 'reconnecting' | 'http-fallback' | 'closed';
  attempt?: number;
}

const DEFAULTS = {
  wssUrl: 'wss://polygon-bor-rpc.publicnode.com',
  httpUrl: 'https://polygon-bor-rpc.publicnode.com',
  pollIntervalMs: 1500,
  maxWsReconnectAttempts: 5,
  initialBackoffMs: 1000,
} as const;

export class PolygonBlockListener extends EventEmitter {
  private opts: Required<PolygonBlockListenerOpts>;
  private watched: Set<string> = new Set();
  private wsProvider: WebSocketProvider | null = null;
  private httpProvider: JsonRpcProvider;
  private mode: ConnectionMode = 'idle';
  private wsAttempts = 0;
  private lastBlockProcessed = 0;
  private pollHandle: ReturnType<typeof setInterval> | null = null;
  private reconnectHandle: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private blockHandler = (n: number) => this.handleNewBlock(n).catch((e) => this.emitError(e));

  constructor(opts: PolygonBlockListenerOpts = {}) {
    super();
    this.opts = { ...DEFAULTS, ...opts };
    this.httpProvider = new JsonRpcProvider(this.opts.httpUrl);
  }

  setWatchers(addresses: Iterable<string>): void {
    this.watched = new Set(Array.from(addresses, (a) => a.toLowerCase()));
    logger.info(`PolygonBlockListener: watching ${this.watched.size} wallet(s)`);
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    // Seed lastBlockProcessed from current head so we don't replay history on first start
    try {
      this.lastBlockProcessed = await this.httpProvider.getBlockNumber();
      logger.info(`PolygonBlockListener: starting at head block ${this.lastBlockProcessed}`);
    } catch (e) {
      logger.warn(`PolygonBlockListener: failed to seed head block, starting from 0: ${(e as Error).message}`);
    }
    await this.connectWs();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.reconnectHandle) {
      clearTimeout(this.reconnectHandle);
      this.reconnectHandle = null;
    }
    if (this.pollHandle) {
      clearInterval(this.pollHandle);
      this.pollHandle = null;
    }
    if (this.wsProvider) {
      try {
        this.wsProvider.off('block', this.blockHandler);
        await this.wsProvider.destroy();
      } catch (e) {
        logger.debug(`PolygonBlockListener: WS destroy threw: ${(e as Error).message}`);
      }
      this.wsProvider = null;
    }
    this.mode = 'idle';
    this.emitConnection({ mode: 'idle', status: 'closed' });
  }

  // ─── WS path ────────────────────────────────────────────────────────────────

  private async connectWs(): Promise<void> {
    if (!this.running) return;
    try {
      this.wsProvider = new WebSocketProvider(this.opts.wssUrl);
      // Surface ws-level errors before they become uncaught
      this.wsProvider.on('error', (e: unknown) => this.handleWsError(e as Error));
      // ethers v6 emits a 'block' event when subscribed to newHeads
      this.wsProvider.on('block', this.blockHandler);
      // Probe with a single getBlockNumber to confirm the socket is alive
      await this.wsProvider.getBlockNumber();
      this.mode = 'ws';
      this.wsAttempts = 0;
      logger.info(`PolygonBlockListener: WS connected to ${this.opts.wssUrl}`);
      this.emitConnection({ mode: 'ws', status: 'connected' });
    } catch (e) {
      this.handleWsError(e as Error);
    }
  }

  private handleWsError(err: Error): void {
    if (!this.running) return;
    logger.warn(`PolygonBlockListener: WS error (attempt ${this.wsAttempts + 1}): ${err.message}`);
    this.emit('error', err);
    this.cleanupWsProvider();

    this.wsAttempts++;
    if (this.wsAttempts > this.opts.maxWsReconnectAttempts) {
      this.startHttpPolling();
      return;
    }
    const backoff = Math.min(
      this.opts.initialBackoffMs * 2 ** (this.wsAttempts - 1),
      30_000,
    );
    this.emitConnection({ mode: 'ws', status: 'reconnecting', attempt: this.wsAttempts });
    this.reconnectHandle = setTimeout(() => {
      this.reconnectHandle = null;
      this.connectWs().catch((e) => this.handleWsError(e as Error));
    }, backoff);
  }

  private cleanupWsProvider(): void {
    if (!this.wsProvider) return;
    try {
      this.wsProvider.off('block', this.blockHandler);
      void this.wsProvider.destroy();
    } catch {
      /* ignore */
    }
    this.wsProvider = null;
  }

  // ─── HTTP polling fallback ──────────────────────────────────────────────────

  private startHttpPolling(): void {
    if (this.pollHandle) return;
    this.mode = 'http-poll';
    logger.warn(
      `PolygonBlockListener: WS exhausted ${this.opts.maxWsReconnectAttempts} attempts → HTTP polling fallback every ${this.opts.pollIntervalMs}ms`,
    );
    this.emitConnection({ mode: 'http-poll', status: 'http-fallback' });

    this.pollHandle = setInterval(() => {
      void this.pollOnce().catch((e) => this.emitError(e));
    }, this.opts.pollIntervalMs);
  }

  private async pollOnce(): Promise<void> {
    if (!this.running) return;
    const head = await this.httpProvider.getBlockNumber();
    if (head <= this.lastBlockProcessed) return;
    // Cap catch-up so a long stall doesn't blow out a single poll
    const start = Math.max(this.lastBlockProcessed + 1, head - 50);
    for (let n = start; n <= head; n++) {
      await this.handleNewBlock(n);
    }
  }

  // ─── shared block handler ──────────────────────────────────────────────────

  private async handleNewBlock(blockNumber: number): Promise<void> {
    if (!this.running) return;
    if (blockNumber <= this.lastBlockProcessed) return;
    this.lastBlockProcessed = blockNumber;

    const provider = this.mode === 'ws' && this.wsProvider ? this.wsProvider : this.httpProvider;
    const block = await provider.getBlock(blockNumber, true);
    if (!block) return;

    if (this.watched.size === 0) return;

    let detected = 0;
    for (const tx of block.prefetchedTransactions ?? []) {
      const trades = decodeFromTransactionResponse(tx, this.watched);
      if (!trades || trades.length === 0) continue;
      for (const t of trades) {
        detected++;
        this.emit('new-trade', t);
      }
    }
    if (detected > 0) {
      logger.info(`PolygonBlockListener: block ${blockNumber} → ${detected} watched trade(s)`);
    }
  }

  // ─── helpers ───────────────────────────────────────────────────────────────

  private emitConnection(ev: ConnectionEvent): void {
    this.emit('connection', ev);
  }

  private emitError(e: unknown): void {
    const err = e instanceof Error ? e : new Error(String(e));
    this.emit('error', err);
  }
}
