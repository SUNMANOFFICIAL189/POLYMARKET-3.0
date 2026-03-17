import { logger } from '../utils/logger.js';
import type { Leader } from '../types/index.js';

/**
 * LeaderboardScraper — fetches trader performance data from Polymarket.
 *
 * Strategy (in order):
 *  1. Polymarket Data API — /activity endpoint (proven public)
 *  2. Gamma API — /activity endpoint with various params
 *  3. Polymarket Next.js API routes (/api/*)
 *  4. Puppeteer + CDP: intercept XHR responses BEFORE navigation, wait for dynamic load
 *  5. Puppeteer + __NEXT_DATA__ extraction
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
    this.pollIntervalMs = opts.pollIntervalMs ?? 300_000;
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

      // 1. Data API
      raw = await this.fetchFromDataAPI();
      if (raw.length > 0) {
        logger.info(`LeaderboardScraper: ${raw.length} entries from Data API`);
      }

      // 2. Gamma API
      if (raw.length === 0) {
        raw = await this.fetchFromGammaAPI();
        if (raw.length > 0) logger.info(`LeaderboardScraper: ${raw.length} entries from Gamma API`);
      }

      // 3. Next.js API routes
      if (raw.length === 0) {
        raw = await this.fetchFromNextAPI();
        if (raw.length > 0) logger.info(`LeaderboardScraper: ${raw.length} entries from Next.js API`);
      }

      // 4. Direct HTML fetch + __NEXT_DATA__ parse (no browser)
      if (raw.length === 0) {
        raw = await this.fetchViaHTMLParse();
        if (raw.length > 0) logger.info(`LeaderboardScraper: ${raw.length} entries from HTML parse`);
      }

      // 5. Puppeteer — intercept XHR + DOM extraction
      if (raw.length === 0) {
        logger.info('LeaderboardScraper: Falling back to Puppeteer...');
        raw = await this.fetchWithPuppeteer();
        if (raw.length > 0) logger.info(`LeaderboardScraper: ${raw.length} entries via Puppeteer`);
      }

      if (raw.length === 0) {
        logger.warn('LeaderboardScraper: No data from any source — will retry next poll');
        return;
      }

      this.lastRawData = raw;
      this.lastPollTime = Date.now();

      const leaders = this.normalizeEntries(raw).slice(0, this.topN);
      logger.info(`LeaderboardScraper: Top leader → ${leaders[0]?.walletAddress?.slice(0, 10) ?? '?'}... score=${leaders[0]?.compositeScore?.toFixed(1) ?? '?'}`);
      onLeaders(leaders);
    } catch (err) {
      logger.error(`LeaderboardScraper poll error: ${err}`);
    }
  }

  // ─── Strategy 1: Data API ──────────────────────────────────────

  private async fetchFromDataAPI(): Promise<RawLeaderboardEntry[]> {
    // Polymarket Data API — /activity is confirmed public, used by wallet monitor
    const endpoints = [
      `${DATA_API_BASE}/activity?window=all&sortBy=profitAndLoss&limit=100`,
      `${DATA_API_BASE}/activity?window=all&limit=100`,
      `${DATA_API_BASE}/leaderboard?window=all&limit=100`,
      `${DATA_API_BASE}/leaderboard?limit=100`,
    ];

    for (const url of endpoints) {
      try {
        const res = await this.fetchWithTimeout(url, 10_000);
        if (!res.ok) continue;
        const data = await res.json();
        const entries = this.extractEntries(data);
        if (entries.length > 0) {
          logger.info(`LeaderboardScraper: Data API hit: ${url.split('?')[0]}`);
          return entries;
        }
      } catch {}
    }
    return [];
  }

  // ─── Strategy 2: Gamma API ─────────────────────────────────────

  private async fetchFromGammaAPI(): Promise<RawLeaderboardEntry[]> {
    const endpoints = [
      `${GAMMA_API_BASE}/activity?window=all&limit=100&sortBy=profitAndLoss&sortDirection=desc`,
      `${GAMMA_API_BASE}/activity?limit=100`,
      `${GAMMA_API_BASE}/leaderboard?limit=100`,
      `${GAMMA_API_BASE}/users?sortBy=profit&limit=100`,
    ];

    for (const url of endpoints) {
      try {
        const res = await this.fetchWithTimeout(url, 10_000);
        if (!res.ok) continue;
        const data = await res.json();
        const entries = this.extractEntries(data);
        if (entries.length > 0) {
          logger.info(`LeaderboardScraper: Gamma API hit: ${url.split('?')[0]}`);
          return entries;
        }
      } catch {}
    }
    return [];
  }

  // ─── Strategy 3: Next.js internal API routes ───────────────────

  private async fetchFromNextAPI(): Promise<RawLeaderboardEntry[]> {
    // Polymarket's frontend (Next.js) may expose these internal routes
    const endpoints = [
      'https://polymarket.com/api/activity?timeframe=all&limit=100&sortBy=profitAndLoss',
      'https://polymarket.com/api/activity?limit=100',
      'https://polymarket.com/api/leaderboard?limit=100',
      'https://polymarket.com/_next/data/latest/leaderboard.json',
    ];

    for (const url of endpoints) {
      try {
        const res = await this.fetchWithTimeout(url, 10_000);
        if (!res.ok) continue;
        const data = await res.json();
        const entries = this.extractEntries(data);
        if (entries.length > 0) {
          logger.info(`LeaderboardScraper: Next.js API hit: ${url.split('?')[0]}`);
          return entries;
        }
      } catch {}
    }
    return [];
  }

  // ─── Strategy 4: Direct HTML fetch + __NEXT_DATA__ parse ──────
  // No browser needed — Next.js SSR apps embed initial state in the HTML.

  private async fetchViaHTMLParse(): Promise<RawLeaderboardEntry[]> {
    try {
      const res = await this.fetchWithTimeout(LEADERBOARD_URL, 15_000);
      if (!res.ok) return [];
      const html = await res.text();

      // Extract __NEXT_DATA__ JSON from the page HTML
      const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
      if (!match) return [];

      const nextData = JSON.parse(match[1]);
      const entries = this.extractEntries(nextData);
      if (entries.length > 0) {
        logger.info(`LeaderboardScraper: HTML parse found ${entries.length} entries in __NEXT_DATA__`);
        return entries;
      }
    } catch (err) {
      logger.debug(`LeaderboardScraper: HTML parse failed: ${err}`);
    }
    return [];
  }

  // ─── Strategy 5: Puppeteer with page.on('response') ───────────
  // More reliable than CDP getResponseBody — captures all XHR/fetch responses.

  private async fetchWithPuppeteer(): Promise<RawLeaderboardEntry[]> {
    try {
      const puppeteer = await import('puppeteer');

      if (!this.puppeteerBrowser || !this.puppeteerBrowser.connected) {
        this.puppeteerBrowser = await puppeteer.default.launch({
          headless: true,
          args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
        });
      }

      const page = await this.puppeteerBrowser.newPage();
      page.on('console', () => {});

      const capturedEntries: RawLeaderboardEntry[] = [];
      const seenUrls: string[] = [];

      // Use page.on('response') — more reliable than CDP Network.getResponseBody
      page.on('response', async (response: any) => {
        const url: string = response.url();
        const ct: string = response.headers()['content-type'] || '';
        if (!ct.includes('json')) return;

        seenUrls.push(url.split('?')[0].slice(-80));

        try {
          const data = await response.json();
          const entries = this.extractEntries(data);
          if (entries.length > 0) {
            logger.info(`LeaderboardScraper: Captured ${entries.length} entries from ${url.split('?')[0].slice(-80)}`);
            capturedEntries.push(...entries);
          }
        } catch {}
      });

      try {
        await page.goto(LEADERBOARD_URL, { waitUntil: 'networkidle2', timeout: 30_000 });
        // Extra wait for lazy-loaded leaderboard data
        await new Promise(resolve => setTimeout(resolve, 3_000));
      } catch (err) {
        logger.warn(`LeaderboardScraper: Puppeteer goto error: ${err}`);
      }

      // Log all JSON URLs we saw (helps diagnose the right endpoint)
      if (seenUrls.length > 0) {
        logger.info(`LeaderboardScraper: JSON URLs seen: ${[...new Set(seenUrls)].join(' | ')}`);
      }

      if (capturedEntries.length === 0) {
        // Try __NEXT_DATA__ from the loaded page
        const nextDataEntries = await this.extractNextData(page);
        capturedEntries.push(...nextDataEntries);
      }

      if (capturedEntries.length === 0) {
        const domEntries = await this.extractFromDOM(page);
        capturedEntries.push(...domEntries);
      }

      await page.close();
      return capturedEntries;

    } catch (err) {
      logger.warn(`LeaderboardScraper: Puppeteer failed: ${err}`);
      return [];
    }
  }

  private async extractNextData(page: any): Promise<RawLeaderboardEntry[]> {
    try {
      const nextData = await page.evaluate(() => {
        const el = document.getElementById('__NEXT_DATA__');
        if (!el) return null;
        try { return JSON.parse(el.textContent || ''); } catch { return null; }
      });

      if (!nextData) return [];

      // Walk the Next.js page props looking for trader arrays
      const entries = this.extractEntries(nextData);
      if (entries.length > 0) {
        logger.info(`LeaderboardScraper: Extracted ${entries.length} entries from __NEXT_DATA__`);
        return entries;
      }

      // Also try pageProps.data, pageProps.leaderboard, etc.
      const pageProps = nextData?.props?.pageProps ?? {};
      for (const key of Object.keys(pageProps)) {
        const val = pageProps[key];
        if (Array.isArray(val)) {
          const entries2 = this.extractEntries(val);
          if (entries2.length > 0) return entries2;
        } else if (val && typeof val === 'object') {
          const entries2 = this.extractEntries(val);
          if (entries2.length > 0) return entries2;
        }
      }
    } catch {}
    return [];
  }

  private async extractFromDOM(page: any): Promise<RawLeaderboardEntry[]> {
    try {
      return await page.evaluate(() => {
        const results: any[] = [];
        // Find all text that looks like Ethereum addresses
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        const seen = new Set<string>();
        let node;
        while ((node = walker.nextNode())) {
          const text = node.textContent || '';
          const match = text.match(/0x[a-fA-F0-9]{40}/g);
          if (!match) continue;
          for (const addr of match) {
            if (seen.has(addr)) continue;
            seen.add(addr);
            // Look at parent element for context
            const parent = node.parentElement?.closest('tr, [class*="row"], [class*="Row"], li') || node.parentElement;
            const rowText = parent?.textContent || text;
            const dollarMatch = rowText.match(/\$([0-9,]+(?:\.[0-9]+)?)/g);
            const pctMatch = rowText.match(/([0-9]+(?:\.[0-9]+)?)%/g);
            results.push({
              address: addr,
              profit: dollarMatch ? parseFloat(dollarMatch[0].replace(/[$,]/g, '')) : 0,
              winRate: pctMatch ? parseFloat(pctMatch[0]) / 100 : 0,
            });
          }
        }
        return results.slice(0, 100);
      });
    } catch {
      return [];
    }
  }

  // ─── Helpers ───────────────────────────────────────────────────

  private extractEntries(data: any): RawLeaderboardEntry[] {
    if (!data) return [];

    // Recursively search for arrays of trader objects
    const candidates = this.findTraderArrays(data);
    if (candidates.length === 0) return [];

    // Pick the largest array that has valid addresses
    candidates.sort((a, b) => b.length - a.length);
    return candidates[0];
  }

  private findTraderArrays(data: any, depth = 0): RawLeaderboardEntry[][] {
    if (depth > 5) return [];
    const results: RawLeaderboardEntry[][] = [];

    if (Array.isArray(data)) {
      const entries = this.tryParseTraderArray(data);
      if (entries.length > 0) results.push(entries);
    } else if (data && typeof data === 'object') {
      for (const val of Object.values(data)) {
        const sub = this.findTraderArrays(val, depth + 1);
        results.push(...sub);
      }
    }

    return results;
  }

  private tryParseTraderArray(arr: any[]): RawLeaderboardEntry[] {
    if (arr.length === 0) return [];

    const entries = arr
      .filter(item => item && typeof item === 'object')
      .map(item => {
        const addr = item.address || item.wallet || item.user || item.proxy_wallet_address ||
          item.proxyWalletAddress || item.pseudonym_wallet || item.walletAddress;
        if (!addr || typeof addr !== 'string') return null;
        // Must look like an Ethereum address
        if (!addr.match(/^0x[a-fA-F0-9]{40}$/i)) return null;

        return {
          address: addr.toLowerCase(),
          name: item.name || item.pseudonym || item.username || item.displayName || item.display_name,
          profit: Number(item.profit || item.pnl || item.profitAndLoss || item.total_profit || item.allPnl || 0),
          winRate: Number(item.winRate || item.win_rate || item.pct_positive || item.positiveRate || 0),
          numTrades: Number(item.numTrades || item.num_trades || item.tradeCount || item.trade_count || 0),
          volume: Number(item.volume || item.total_volume || 0),
          lastTrade: item.lastTrade || item.last_trade || item.lastActive || item.last_active,
        } as RawLeaderboardEntry;
      })
      .filter((e): e is RawLeaderboardEntry => e !== null);

    return entries.length >= 3 ? entries : [];
  }

  private normalizeEntries(raw: RawLeaderboardEntry[]): Leader[] {
    const now = new Date().toISOString();

    return raw
      .filter(e => e.address && e.address.startsWith('0x'))
      .map(e => {
        const profit = Number(e.profit || e.pnl || 0);
        const winRate = Number(e.winRate || e.win_rate || 0);
        const normalizedWinRate = winRate > 1 ? winRate / 100 : winRate;
        const tradeCount = Number(e.numTrades || e.num_trades || e.tradeCount || 0);

        // Initial composite (scorer will refine)
        const compositeScore =
          normalizedWinRate * 40 +
          Math.min(profit / 1000, 30) +
          Math.min(tradeCount / 10, 15) + 15;

        return {
          walletAddress: e.address,
          displayName: e.name || e.pseudonym,
          compositeScore: Math.min(100, Math.max(0, compositeScore)),
          winRate30d: normalizedWinRate,
          profitFactor14d: profit > 0 ? 2.0 : 0.5,
          tradeCount30d: tradeCount,
          totalPnl30d: profit,
          lastTradeTime: e.lastTrade || now,
          isCurrentLeader: false,
          trackedSince: now,
          updatedAt: now,
        } as Leader;
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
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'Accept': 'application/json',
        },
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  getStats() {
    return { pollCount: this.pollCount, lastPollTime: this.lastPollTime, lastEntryCount: this.lastRawData.length };
  }
}
