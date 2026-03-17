import { logger } from '../utils/logger.js';
import type { Leader } from '../types/index.js';

/**
 * LeaderboardScraper — fetches trader performance data from Polymarket.
 *
 * Strategy (in order):
 *  1. Try Polymarket's Data API leaderboard endpoint
 *  2. Try Gamma API activity endpoint
 *  3. Fall back to Puppeteer scraping with CDP network interception
 *
 * Emits a ranked list of Leader objects every POLL_INTERVAL_MS.
 */

const DATA_API_BASE = 'https://data-api.polymarket.com';
const GAMMA_API_BASE = 'https://gamma-api.polymarket.com';
const LEADERBOARD_URL = 'https://polymarket.com/leaderboard';

export interface RawLeaderboardEntry {
  address: string;
  name?: string;
  pseudonym?: string;
  profit?: number;
  pnl?: number;
  profiit?: number; // typo variants in API
  winRate?: number;
  win_rate?: number;
  numTrades?: number;
  num_trades?: number;
  tradeCount?: number;
  lastTrade?: string;
  last_trade?: string;
  volume?: number;
}

export class LeaderboardScraper {
  private pollIntervalMs: number;
  private topN: number;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private puppeteerBrowser: any = null;
  private lastRawData: RawLeaderboardEntry[] = [];
  private pollCount = 0;
  private lastPollTime = 0;

  constructor(opts: { pollIntervalMs?: number; topN?: number } = {}) {
    this.pollIntervalMs = opts.pollIntervalMs ?? 300_000; // 5 minutes
    this.topN = opts.topN ?? 20;
  }

  start(onLeaders: (leaders: Leader[]) => void): void {
    logger.info(`LeaderboardScraper starting — poll every ${this.pollIntervalMs / 1000}s, top ${this.topN}`);
    this.poll(onLeaders);
    this.intervalId = setInterval(() => this.poll(onLeaders), this.pollIntervalMs);
  }

  stop(): void {
    if (this.intervalId) { clearInterval(this.intervalId); this.intervalId = null; }
    if (this.puppeteerBrowser) {
      this.puppeteerBrowser.close().catch(() => {});
      this.puppeteerBrowser = null;
    }
    logger.info('LeaderboardScraper stopped');
  }

  private async poll(onLeaders: (leaders: Leader[]) => void): Promise<void> {
    this.pollCount++;
    logger.info(`LeaderboardScraper: Poll #${this.pollCount}`);

    try {
      let raw: RawLeaderboardEntry[] = [];

      // Strategy 1: Data API
      raw = await this.fetchFromDataAPI();
      if (raw.length > 0) {
        logger.info(`LeaderboardScraper: Got ${raw.length} entries from Data API`);
      } else {
        // Strategy 2: Gamma API
        raw = await this.fetchFromGammaAPI();
        if (raw.length > 0) {
          logger.info(`LeaderboardScraper: Got ${raw.length} entries from Gamma API`);
        } else {
          // Strategy 3: Puppeteer
          logger.info('LeaderboardScraper: Falling back to Puppeteer scraping...');
          raw = await this.fetchWithPuppeteer();
          logger.info(`LeaderboardScraper: Got ${raw.length} entries via Puppeteer`);
        }
      }

      if (raw.length === 0) {
        logger.warn('LeaderboardScraper: No data from any source');
        return;
      }

      this.lastRawData = raw;
      this.lastPollTime = Date.now();

      const leaders = this.normalizeEntries(raw).slice(0, this.topN);
      logger.info(`LeaderboardScraper: Normalized ${leaders.length} leaders, top wallet: ${leaders[0]?.walletAddress?.slice(0, 10)}...`);

      onLeaders(leaders);
    } catch (err) {
      logger.error(`LeaderboardScraper poll failed: ${err}`);
    }
  }

  /**
   * Try Polymarket Data API leaderboard endpoints.
   * Multiple endpoint patterns to probe.
   */
  private async fetchFromDataAPI(): Promise<RawLeaderboardEntry[]> {
    const endpoints = [
      `${DATA_API_BASE}/leaderboard?window=1m&limit=100`,
      `${DATA_API_BASE}/leaderboard?timeframe=30d&limit=100`,
      `${DATA_API_BASE}/activity?window=all&limit=100&sortBy=profit`,
    ];

    for (const url of endpoints) {
      try {
        const res = await this.fetchWithTimeout(url, 10_000);
        if (!res.ok) continue;
        const data = await res.json();
        const entries = this.extractEntries(data);
        if (entries.length > 0) return entries;
      } catch {}
    }
    return [];
  }

  /**
   * Try Gamma API endpoints.
   */
  private async fetchFromGammaAPI(): Promise<RawLeaderboardEntry[]> {
    const endpoints = [
      `${GAMMA_API_BASE}/leaderboard?limit=100`,
      `${GAMMA_API_BASE}/leaderboard?window=30d&limit=100`,
    ];

    for (const url of endpoints) {
      try {
        const res = await this.fetchWithTimeout(url, 10_000);
        if (!res.ok) continue;
        const data = await res.json();
        const entries = this.extractEntries(data);
        if (entries.length > 0) return entries;
      } catch {}
    }
    return [];
  }

  /**
   * Puppeteer fallback: open leaderboard page, intercept API calls via CDP.
   */
  private async fetchWithPuppeteer(): Promise<RawLeaderboardEntry[]> {
    try {
      const puppeteer = await import('puppeteer');

      if (!this.puppeteerBrowser) {
        this.puppeteerBrowser = await puppeteer.default.launch({
          headless: true,
          args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
        });
      }

      const page = await this.puppeteerBrowser.newPage();
      const capturedData: RawLeaderboardEntry[] = [];

      // Set up CDP network interception to capture API responses
      const cdp = await page.createCDPSession();
      await cdp.send('Network.enable');

      cdp.on('Network.responseReceived', async (event: any) => {
        const url = event.response.url;
        if (!url.includes('leaderboard') && !url.includes('activity') && !url.includes('users')) return;

        try {
          const body = await cdp.send('Network.getResponseBody', { requestId: event.requestId });
          const data = JSON.parse(body.body);
          const entries = this.extractEntries(data);
          capturedData.push(...entries);
        } catch {}
      });

      try {
        await page.goto(LEADERBOARD_URL, { waitUntil: 'networkidle2', timeout: 30_000 });
        // Wait for data to load
        await new Promise(resolve => setTimeout(resolve, 3000));
      } catch {}

      await page.close();

      if (capturedData.length > 0) return capturedData;

      // If no API interception worked, try DOM scraping
      return await this.scrapeDOMLeaderboard();
    } catch (err) {
      logger.warn(`LeaderboardScraper: Puppeteer failed: ${err}`);
      return [];
    }
  }

  /**
   * Last resort: scrape the DOM of the leaderboard page.
   */
  private async scrapeDOMLeaderboard(): Promise<RawLeaderboardEntry[]> {
    try {
      const puppeteer = await import('puppeteer');
      if (!this.puppeteerBrowser) {
        this.puppeteerBrowser = await puppeteer.default.launch({
          headless: true,
          args: ['--no-sandbox', '--disable-setuid-sandbox'],
        });
      }

      const page = await this.puppeteerBrowser.newPage();
      await page.goto(LEADERBOARD_URL, { waitUntil: 'networkidle2', timeout: 30_000 });
      await new Promise(resolve => setTimeout(resolve, 3000));

      const entries: RawLeaderboardEntry[] = await page.evaluate(() => {
        const results: any[] = [];
        // Look for rows with wallet addresses and P&L data
        const rows = document.querySelectorAll('[data-testid*="leaderboard"], tr, [class*="leaderboard"], [class*="trader"]');

        rows.forEach((row: Element) => {
          const text = row.textContent || '';
          // Look for Ethereum addresses (0x...)
          const addrMatch = text.match(/0x[a-fA-F0-9]{40}/);
          if (!addrMatch) return;

          // Try to extract P&L ($ amounts)
          const pnlMatch = text.match(/\$([0-9,]+\.?[0-9]*)/);
          const pctMatch = text.match(/([0-9]+\.?[0-9]*)%/);

          results.push({
            address: addrMatch[0],
            profit: pnlMatch ? parseFloat(pnlMatch[1].replace(/,/g, '')) : 0,
            winRate: pctMatch ? parseFloat(pctMatch[1]) / 100 : 0,
          });
        });

        return results;
      });

      await page.close();
      return entries;
    } catch (err) {
      logger.warn(`LeaderboardScraper: DOM scrape failed: ${err}`);
      return [];
    }
  }

  private extractEntries(data: any): RawLeaderboardEntry[] {
    if (!data) return [];

    // Handle various response shapes
    const arr: any[] = Array.isArray(data)
      ? data
      : data.data ?? data.results ?? data.leaderboard ?? data.traders ?? data.users ?? [];

    if (!Array.isArray(arr) || arr.length === 0) return [];

    return arr.filter(item => {
      const addr = item.address || item.wallet || item.user || item.proxy_wallet_address;
      return typeof addr === 'string' && addr.startsWith('0x') && addr.length === 42;
    }).map(item => ({
      address: item.address || item.wallet || item.user || item.proxy_wallet_address,
      name: item.name || item.pseudonym || item.username || item.display_name,
      profit: item.profit || item.pnl || item.total_profit || item.profitLoss || 0,
      winRate: item.winRate || item.win_rate || item.pct_positive || 0,
      numTrades: item.numTrades || item.num_trades || item.tradeCount || item.trade_count || 0,
      volume: item.volume || item.total_volume || 0,
      lastTrade: item.lastTrade || item.last_trade || item.last_trade_time,
    }));
  }

  private normalizeEntries(raw: RawLeaderboardEntry[]): Leader[] {
    const now = new Date().toISOString();

    return raw
      .filter(e => e.address && e.address.startsWith('0x'))
      .map(e => {
        const profit = Number(e.profit || e.pnl || 0);
        const winRate = Number(e.winRate || e.win_rate || 0);
        // Win rate might come as 0-100 or 0-1
        const normalizedWinRate = winRate > 1 ? winRate / 100 : winRate;
        const tradeCount = Number(e.numTrades || e.num_trades || e.tradeCount || 0);

        // Basic composite score for initial ranking (scorer will refine this)
        const compositeScore = normalizedWinRate * 40 + Math.min(profit / 1000, 30) + Math.min(tradeCount / 10, 15) + 15;

        const leader: Leader = {
          walletAddress: e.address.toLowerCase(),
          displayName: e.name || e.pseudonym,
          compositeScore: Math.min(100, Math.max(0, compositeScore)),
          winRate30d: normalizedWinRate,
          profitFactor14d: profit > 0 ? 2.0 : 1.0, // Placeholder until we have 14d data
          tradeCount30d: tradeCount,
          totalPnl30d: profit,
          lastTradeTime: e.lastTrade || now,
          isCurrentLeader: false,
          trackedSince: now,
          updatedAt: now,
        };

        return leader;
      })
      .sort((a, b) => b.compositeScore - a.compositeScore);
  }

  private async fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; PATS-Copy/1.0)',
          'Accept': 'application/json',
        },
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  getStats() {
    return {
      pollCount: this.pollCount,
      lastPollTime: this.lastPollTime,
      lastEntryCount: this.lastRawData.length,
    };
  }
}
