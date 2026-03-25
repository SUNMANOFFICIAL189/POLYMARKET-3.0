import { EventEmitter } from 'events';
import { logger } from '../utils/logger.js';
import { categoriseMarket, detectSpecialistCategory } from '../signals/market-categoriser.js';
import type { MarketCategory } from '../signals/market-categoriser.js';
import type { Leader, LeaderTrade, DataAPITrade, DataAPIPosition, WatcherConfig } from '../types/index.js';

/**
 * WalletMonitor — polls the Polymarket Data API for up to 5 traders simultaneously.
 *
 * Detection method:
 *   - Poll /trades?user={address}&limit=50 every POLL_INTERVAL_MS for each watcher
 *   - Diff against per-wallet snapshot by trade ID
 *   - Emit 'new-trade' with rank tag for each new trade detected
 *
 * Rank semantics:
 *   - rank=1: primary leader (unconditional copy path)
 *   - rank=2-5: watchers (corroboration gate applied by ConfirmationLayer)
 */

const DATA_API_BASE = 'https://data-api.polymarket.com';
const GAMMA_API_BASE = 'https://gamma-api.polymarket.com';

export class WalletMonitor extends EventEmitter {
  // address → rank (1=leader, 2-5=watchers)
  private watchers: Map<string, number> = new Map();
  // slug:outcome → CLOB tokenId cache
  private tokenIdCache: Map<string, string> = new Map();
  // per-wallet seen trade key sets
  private seenTradeIds: Map<string, Set<string>> = new Map();
  // per-wallet open positions
  private walletPositions: Map<string, Map<string, DataAPIPosition>> = new Map();
  // per-wallet category history (last 30 trades) for specialist detection
  private walletCategories: Map<string, MarketCategory[]> = new Map();
  // per-wallet most recent trade timestamp
  private walletLastTradeTime: Map<string, string> = new Map();
  // addresses currently running initSnapshot (poll skips them)
  private snapshotActive: Set<string> = new Set();

  private currentLeader: Leader | null = null; // kept for getCurrentLeader() compat
  private pollIntervalMs: number;
  private rank1PollIntervalMs: number;
  private intervalId: ReturnType<typeof setInterval> | null = null;       // rank 2-5
  private rank1IntervalId: ReturnType<typeof setInterval> | null = null;  // rank 1 fast-poll
  private pollCount = 0;
  private lastPollTime = 0;

  constructor(opts: { pollIntervalMs?: number; rank1PollIntervalMs?: number } = {}) {
    super();
    this.pollIntervalMs = opts.pollIntervalMs ?? 30_000;
    this.rank1PollIntervalMs = opts.rank1PollIntervalMs ?? 10_000;
  }

  /**
   * Replace the watcher list. New addresses are seeded immediately; removed addresses
   * have their state cleaned up. Existing addresses just get their rank updated.
   */
  setWatchers(list: WatcherConfig[]): void {
    // Normalise to lowercase and deduplicate (leaderboard may return same address with different casing).
    // Keep the lowest rank (highest priority) for any duplicate.
    const deduped = new Map<string, WatcherConfig>();
    for (const w of list) {
      const key = w.walletAddress.toLowerCase();
      const existing = deduped.get(key);
      if (!existing || w.rank < existing.rank) {
        deduped.set(key, { walletAddress: w.walletAddress, rank: w.rank });
      }
    }
    list = Array.from(deduped.values());

    const newAddressSet = new Set(list.map(w => w.walletAddress.toLowerCase()));

    // Remove wallets no longer in the list
    for (const addr of this.watchers.keys()) {
      if (!newAddressSet.has(addr.toLowerCase())) {
        this.watchers.delete(addr);
        this.seenTradeIds.delete(addr);
        this.walletPositions.delete(addr);
        this.walletCategories.delete(addr);
        this.walletLastTradeTime.delete(addr);
        this.snapshotActive.delete(addr);
        logger.debug(`WalletMonitor: Removed watcher ${addr.slice(0, 10)}...`);
      }
    }

    // Add new / update rank for existing
    for (const w of list) {
      const isNew = !this.watchers.has(w.walletAddress);
      this.watchers.set(w.walletAddress, w.rank);

      if (isNew) {
        this.seenTradeIds.set(w.walletAddress, new Set());
        this.walletPositions.set(w.walletAddress, new Map());
        this.walletCategories.set(w.walletAddress, []);

        // Seed if monitor is already running
        if (this.intervalId !== null) {
          this.snapshotActive.add(w.walletAddress);
          this.initSnapshot(w.walletAddress).finally(() => {
            this.snapshotActive.delete(w.walletAddress);
          });
        }
      }
    }

    // Track rank-1 as currentLeader for backwards compatibility
    const rank1 = list.find(w => w.rank === 1);
    if (rank1 && rank1.walletAddress !== this.currentLeader?.walletAddress) {
      this.currentLeader = { walletAddress: rank1.walletAddress } as Leader;
    }

    const summary = list.map(w => `${w.walletAddress.slice(0, 8)}(r${w.rank})`).join(', ');
    logger.info(`WalletMonitor: Watching ${list.length} trader(s): ${summary}`);
  }

  /**
   * Backwards-compatibility wrapper — sets a single rank-1 watcher.
   * Used by legacy code paths; runner will call setWatchers() with full top-5 list.
   */
  setLeader(leader: Leader): void {
    if (this.currentLeader?.walletAddress === leader.walletAddress) return;

    const prev = this.currentLeader?.walletAddress;
    this.currentLeader = leader;

    logger.info(`WalletMonitor: Switched to leader ${leader.walletAddress.slice(0, 10)}...${prev ? ` (was: ${prev.slice(0, 10)}...)` : ''}`);
    this.setWatchers([{ walletAddress: leader.walletAddress, rank: 1 }]);
  }

  start(): void {
    if (this.intervalId) return;
    logger.info(`WalletMonitor starting — rank-1 poll every ${this.rank1PollIntervalMs / 1000}s, rank 2-5 every ${this.pollIntervalMs / 1000}s`);

    // Seed all current watchers before starting the intervals
    const addrs = Array.from(this.watchers.keys());
    if (addrs.length === 0) {
      this.rank1IntervalId = setInterval(() => this.pollByRank(1), this.rank1PollIntervalMs);
      this.intervalId = setInterval(() => this.pollByRank(2, 5), this.pollIntervalMs);
      return;
    }

    for (const addr of addrs) this.snapshotActive.add(addr);
    const seeds = addrs.map(addr =>
      this.initSnapshot(addr).finally(() => this.snapshotActive.delete(addr))
    );

    Promise.all(seeds).then(() => {
      this.rank1IntervalId = setInterval(() => this.pollByRank(1), this.rank1PollIntervalMs);
      this.intervalId = setInterval(() => this.pollByRank(2, 5), this.pollIntervalMs);
    });
  }

  stop(): void {
    if (this.rank1IntervalId) { clearInterval(this.rank1IntervalId); this.rank1IntervalId = null; }
    if (this.intervalId) { clearInterval(this.intervalId); this.intervalId = null; }
    logger.info('WalletMonitor stopped');
  }

  /**
   * Seed seen-trades and positions for one address without emitting trades.
   */
  private async initSnapshot(address: string): Promise<void> {
    try {
      const trades = await this.fetchTrades(address, 50);
      const seenSet = this.seenTradeIds.get(address) ?? new Set<string>();
      const categories = this.walletCategories.get(address) ?? [];
      for (const t of trades) {
        seenSet.add(this.tradeKey(t));
        const cat = categoriseMarket(t.title || t.slug || t.market || '');
        categories.push(cat);
        const ts = this.toISOTimestamp(t.timestamp || t.created_at);
        const cur = this.walletLastTradeTime.get(address);
        if (!cur || ts > cur) this.walletLastTradeTime.set(address, ts);
      }
      if (categories.length > 30) categories.splice(0, categories.length - 30);
      this.seenTradeIds.set(address, seenSet);
      this.walletCategories.set(address, categories);
      const specialist = detectSpecialistCategory(categories);
      logger.info(`WalletMonitor: Seeded ${seenSet.size} existing trades for ${address.slice(0, 10)}... specialist=${specialist ?? 'none'}`);

      const positions = await this.fetchPositions(address);
      const posMap = new Map<string, DataAPIPosition>();
      for (const p of positions) posMap.set(p.condition_id || p.asset, p);
      this.walletPositions.set(address, posMap);
      logger.info(`WalletMonitor: Seeded ${posMap.size} existing positions for ${address.slice(0, 10)}...`);
    } catch (err) {
      logger.warn(`WalletMonitor: Init snapshot failed for ${address.slice(0, 10)}...: ${err}`);
    }
  }

  private async pollByRank(minRank: number, maxRank = minRank): Promise<void> {
    if (this.watchers.size === 0) return;
    this.pollCount++;
    this.lastPollTime = Date.now();

    for (const [addr, rank] of this.watchers) {
      if (rank < minRank || rank > maxRank) continue;
      if (this.snapshotActive.has(addr)) {
        logger.debug(`WalletMonitor: Snapshot in progress for ${addr.slice(0, 10)}... — skipping`);
        continue;
      }
      await this.pollWallet(addr, rank);
    }
  }

  private async pollWallet(addr: string, rank: number): Promise<void> {
    try {
      const trades = await this.fetchTrades(addr, 50);
      const seenSet = this.seenTradeIds.get(addr) ?? new Set<string>();
      const newTrades: DataAPITrade[] = [];

      for (const t of trades) {
        const key = this.tradeKey(t);
        if (!seenSet.has(key)) {
          seenSet.add(key);
          newTrades.push(t);
        }
      }
      this.seenTradeIds.set(addr, seenSet);

      if (newTrades.length > 0) {
        logger.info(`WalletMonitor: ${newTrades.length} new trade(s) from rank-${rank} ${addr.slice(0, 10)}...`);
        const categories = this.walletCategories.get(addr) ?? [];
        for (const t of newTrades) {
          const cat = categoriseMarket(t.title || t.slug || t.market || '');
          categories.push(cat);
          if (categories.length > 30) categories.splice(0, categories.length - 30);
          const ts = this.toISOTimestamp(t.timestamp || t.created_at);
          const cur = this.walletLastTradeTime.get(addr);
          if (!cur || ts > cur) this.walletLastTradeTime.set(addr, ts);
          const tokenId = await this.resolveTokenId(t.slug || t.market || '', t.outcome || 'Yes');
          this.emitLeaderTrade(t, addr, rank, detectSpecialistCategory(categories), tokenId);
        }
        this.walletCategories.set(addr, categories);
      }

      // Check for closed positions
      const positions = await this.fetchPositions(addr);
      const posMap = new Map(positions.map(p => [p.condition_id || p.asset, p]));
      const oldPosMap = this.walletPositions.get(addr) ?? new Map();

      for (const [key, oldPos] of oldPosMap) {
        if (!posMap.has(key) && oldPos.quantity_owned > 0) {
          logger.info(`WalletMonitor: Rank-${rank} ${addr.slice(0, 10)}... closed position on ${oldPos.title?.slice(0, 50) || key}`);
          this.emit('leader-closed', {
            marketId: key,
            marketQuestion: oldPos.title || '',
            leaderWallet: addr,
            rank,
          });
        }
      }

      this.walletPositions.set(addr, posMap);
    } catch (err) {
      logger.warn(`WalletMonitor: Poll failed for ${addr.slice(0, 10)}...: ${err}`);
    }
  }

  private emitLeaderTrade(t: DataAPITrade, leaderWallet: string, rank: number, specialistCategory?: MarketCategory | null, tokenId?: string): void {
    const leaderTrade: LeaderTrade = {
      leaderWallet,
      marketId: t.market || t.condition_id || t.slug || '',
      marketQuestion: t.title || t.slug || t.market || '',
      tokenId: tokenId || t.asset_id || '',
      outcome: t.outcome || 'Yes',
      side: this.normalizeSide(t.side || t.type || 'buy'),
      entryPrice: Number(t.price || 0),
      size: Number(t.size || 0) * Number(t.price || 1),
      timestamp: this.toISOTimestamp(t.timestamp || t.created_at),
      tradeId: t.id || t.taker_order_id,
      rank,
      specialistCategory,
    };

    logger.debug(`WalletMonitor: trade ts raw=${t.timestamp} created_at=${t.created_at} → ${leaderTrade.timestamp}`);
    logger.info(`WalletMonitor: Rank-${rank} trade → ${leaderTrade.side.toUpperCase()} ${leaderTrade.outcome} on "${leaderTrade.marketQuestion.slice(0, 50)}" @ $${leaderTrade.entryPrice.toFixed(3)}`);
    this.emit('new-trade', leaderTrade);
  }

  /**
   * Normalize a raw API timestamp to ISO string.
   * Polymarket Data API returns Unix timestamps in seconds; treat any value
   * less than 1e12 as seconds and multiply by 1000 to get milliseconds.
   */
  private toISOTimestamp(raw: number | string | undefined): string {
    if (!raw) return new Date().toISOString();
    if (typeof raw === 'string') {
      const d = new Date(raw);
      return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
    }
    const ms = raw < 1e12 ? raw * 1000 : raw;
    return new Date(ms).toISOString();
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

  /**
   * Resolve a CLOB token ID for a given market slug and outcome.
   * Uses the Gamma API and caches results to avoid repeated lookups.
   */
  private async resolveTokenId(slug: string, outcome: string): Promise<string> {
    if (!slug) return '';
    const cacheKey = `${slug}:${outcome}`;
    if (this.tokenIdCache.has(cacheKey)) return this.tokenIdCache.get(cacheKey)!;

    try {
      const res = await this.fetchWithTimeout(`${GAMMA_API_BASE}/markets?slug=${encodeURIComponent(slug)}`, 8_000);
      if (!res.ok) return '';
      const data = await res.json();
      const market = Array.isArray(data) ? data[0] : data;
      if (!market) return '';

      const rawOutcomes = market.outcomes ?? '[]';
      const rawTokenIds = market.clobTokenIds ?? '[]';
      const outcomes: string[] = typeof rawOutcomes === 'string' ? JSON.parse(rawOutcomes) : rawOutcomes;
      const tokenIds: string[] = typeof rawTokenIds === 'string' ? JSON.parse(rawTokenIds) : rawTokenIds;

      const idx = outcomes.findIndex((o: string) => o.toLowerCase() === outcome.toLowerCase());
      const tokenId = idx >= 0 ? (tokenIds[idx] ?? '') : '';

      if (tokenId) {
        this.tokenIdCache.set(cacheKey, tokenId);
        logger.debug(`WalletMonitor: Resolved tokenId for "${slug}" / ${outcome} → ${tokenId.slice(0, 16)}...`);
      }
      return tokenId;
    } catch (err) {
      logger.debug(`WalletMonitor: tokenId lookup failed for ${slug}: ${err}`);
      return '';
    }
  }

  getSpecialistCategory(address: string): MarketCategory | null {
    const categories = this.walletCategories.get(address) ?? [];
    return detectSpecialistCategory(categories);
  }

  getWalletStats(address: string): { tradeCount: number; lastTradeTime?: string } {
    return {
      tradeCount: this.seenTradeIds.get(address)?.size ?? 0,
      lastTradeTime: this.walletLastTradeTime.get(address),
    };
  }

  getCurrentLeader(): Leader | null { return this.currentLeader; }

  getWatchers(): Map<string, number> { return new Map(this.watchers); }

  getStats() {
    return {
      pollCount: this.pollCount,
      lastPollTime: this.lastPollTime,
      watcherCount: this.watchers.size,
      watchers: Array.from(this.watchers.entries()).map(([addr, rank]) => ({
        address: addr.slice(0, 10),
        rank,
        seenTrades: this.seenTradeIds.get(addr)?.size ?? 0,
        openPositions: this.walletPositions.get(addr)?.size ?? 0,
      })),
    };
  }
}
