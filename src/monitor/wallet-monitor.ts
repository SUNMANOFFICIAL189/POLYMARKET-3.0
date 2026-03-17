import { EventEmitter } from 'events';
import { logger } from '../utils/logger.js';
import type { Leader, LeaderTrade, DataAPITrade, DataAPIPosition } from '../types/index.js';

/**
 * WalletMonitor — polls the Polymarket Data API for the current leader's trades.
 *
 * Detection method:
 *   - Poll /trades?user={address}&limit=50 every POLL_INTERVAL_MS
 *   - Diff against previous snapshot by trade ID
 *   - Emit 'new-trade' for each new position opened
 *
 * Fallback cross-reference:
 *   - If Glint captures a whale trade from the leader, the runner can call
 *     checkWhaleMatch() for instant detection
 */

const DATA_API_BASE = 'https://data-api.polymarket.com';

export class WalletMonitor extends EventEmitter {
  private currentLeader: Leader | null = null;
  private pollIntervalMs: number;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private seenTradeIds = new Set<string>();
  private currentPositions: Map<string, DataAPIPosition> = new Map();
  private pollCount = 0;
  private lastPollTime = 0;

  constructor(opts: { pollIntervalMs?: number } = {}) {
    super();
    this.pollIntervalMs = opts.pollIntervalMs ?? 30_000; // 30 seconds
  }

  setLeader(leader: Leader): void {
    if (this.currentLeader?.walletAddress === leader.walletAddress) return;

    const prev = this.currentLeader?.walletAddress;
    this.currentLeader = leader;

    // Clear seen trades when switching leaders to avoid missing first trades
    this.seenTradeIds.clear();
    this.currentPositions.clear();

    logger.info(`WalletMonitor: Switched to leader ${leader.walletAddress.slice(0, 10)}...${prev ? ` (was: ${prev.slice(0, 10)}...)` : ''}`);
  }

  start(): void {
    if (this.intervalId) return;
    logger.info(`WalletMonitor starting — poll every ${this.pollIntervalMs / 1000}s`);
    // Initial snapshot (don't emit trades — just seed seenTradeIds)
    this.initSnapshot().then(() => {
      this.intervalId = setInterval(() => this.poll(), this.pollIntervalMs);
    });
  }

  stop(): void {
    if (this.intervalId) { clearInterval(this.intervalId); this.intervalId = null; }
    logger.info('WalletMonitor stopped');
  }

  /**
   * Seed the seen-trades set without emitting. Called once on start and on leader switch.
   */
  private async initSnapshot(): Promise<void> {
    if (!this.currentLeader) return;
    try {
      const trades = await this.fetchTrades(this.currentLeader.walletAddress, 50);
      for (const t of trades) this.seenTradeIds.add(this.tradeKey(t));
      logger.info(`WalletMonitor: Seeded ${this.seenTradeIds.size} existing trades for ${this.currentLeader.walletAddress.slice(0, 10)}...`);

      const positions = await this.fetchPositions(this.currentLeader.walletAddress);
      for (const p of positions) this.currentPositions.set(p.condition_id || p.asset, p);
      logger.info(`WalletMonitor: Seeded ${this.currentPositions.size} existing positions`);
    } catch (err) {
      logger.warn(`WalletMonitor: Init snapshot failed: ${err}`);
    }
  }

  private async poll(): Promise<void> {
    if (!this.currentLeader) return;

    this.pollCount++;
    const addr = this.currentLeader.walletAddress;

    try {
      // Check for new trades
      const trades = await this.fetchTrades(addr, 50);
      const newTrades: DataAPITrade[] = [];

      for (const t of trades) {
        const key = this.tradeKey(t);
        if (!this.seenTradeIds.has(key)) {
          this.seenTradeIds.add(key);
          newTrades.push(t);
        }
      }

      if (newTrades.length > 0) {
        logger.info(`WalletMonitor: ${newTrades.length} new trade(s) detected for ${addr.slice(0, 10)}...`);
        for (const t of newTrades) {
          this.emitLeaderTrade(t, addr);
        }
      }

      // Check for closed positions (leader sold something we copied)
      const positions = await this.fetchPositions(addr);
      const positionMap = new Map(positions.map(p => [p.condition_id || p.asset, p]));

      for (const [key, oldPos] of this.currentPositions) {
        if (!positionMap.has(key) && oldPos.quantity_owned > 0) {
          // Position closed or sold
          logger.info(`WalletMonitor: Leader closed position on ${oldPos.title?.slice(0, 50) || key}`);
          this.emit('leader-closed', {
            marketId: key,
            marketQuestion: oldPos.title || '',
            leaderWallet: addr,
          });
        }
      }

      this.currentPositions = positionMap;
      this.lastPollTime = Date.now();

    } catch (err) {
      logger.warn(`WalletMonitor: Poll failed: ${err}`);
    }
  }

  private emitLeaderTrade(t: DataAPITrade, leaderWallet: string): void {
    // Only emit BUY trades (new positions). Sells are handled via position close detection.
    const side = (t.side || t.type || '').toLowerCase();
    if (side !== 'buy' && !side.includes('yes') && !side.includes('no')) {
      // Try to infer from outcome
    }

    const leaderTrade: LeaderTrade = {
      leaderWallet,
      marketId: t.market || t.condition_id || '',
      marketQuestion: t.title || t.slug || t.market || '',
      tokenId: t.asset_id || '',
      outcome: t.outcome || 'Yes',
      side: this.normalizeSide(t.side || t.type || 'buy'),
      entryPrice: Number(t.price || 0),
      size: Number(t.size || 0) * Number(t.price || 1), // Convert shares → USDC
      timestamp: t.timestamp || new Date(t.created_at * 1000).toISOString(),
      tradeId: t.id || t.taker_order_id,
    };

    logger.info(`WalletMonitor: New leader trade → ${leaderTrade.side.toUpperCase()} ${leaderTrade.outcome} on "${leaderTrade.marketQuestion.slice(0, 50)}" @ $${leaderTrade.entryPrice.toFixed(3)}`);
    this.emit('new-trade', leaderTrade);
  }

  private async fetchTrades(address: string, limit = 50): Promise<DataAPITrade[]> {
    const url = `${DATA_API_BASE}/trades?user=${address}&limit=${limit}`;
    const res = await this.fetchWithTimeout(url, 10_000);
    if (!res.ok) throw new Error(`Trades API ${res.status}`);
    const data = await res.json();
    return Array.isArray(data) ? data : data.data ?? data.trades ?? [];
  }

  private async fetchPositions(address: string): Promise<DataAPIPosition[]> {
    const url = `${DATA_API_BASE}/positions?user=${address}`;
    const res = await this.fetchWithTimeout(url, 10_000);
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : data.data ?? data.positions ?? [];
  }

  private normalizeSide(side: string): 'buy' | 'sell' {
    const s = side.toLowerCase();
    if (s === 'sell' || s === 'short' || s.includes('no')) return 'sell';
    return 'buy';
  }

  private tradeKey(t: DataAPITrade): string {
    return t.id || t.taker_order_id || `${t.market}:${t.created_at}:${t.size}`;
  }

  private async fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  }

  getCurrentLeader(): Leader | null { return this.currentLeader; }

  getStats() {
    return {
      pollCount: this.pollCount,
      lastPollTime: this.lastPollTime,
      seenTradeCount: this.seenTradeIds.size,
      openPositionCount: this.currentPositions.size,
      currentLeader: this.currentLeader?.walletAddress,
    };
  }
}
