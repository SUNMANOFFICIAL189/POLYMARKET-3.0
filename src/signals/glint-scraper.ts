import { EventEmitter } from 'events';
import { logger } from '../utils/logger.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'fs';
import { join } from 'path';

/**
 * GlintScraper — intercepts Glint.trade's real-time WebSocket feed
 * via wss://api.glint.trade/ws
 *
 * TASK-031 Reconnect Strategy:
 *   1. CDP Network.webSocketClosed → page refresh (not full browser restart)
 *   2. Liveness watchdog: if no WS frames for 120s, force page refresh
 *   3. Unlimited reconnect attempts with capped backoff (max 60s)
 *   4. Full browser restart only after 5 consecutive page-refresh failures
 */

export interface GlintSignalEvent {
  headline: string;
  impact: 'critical' | 'high' | 'medium' | 'low';
  category: string;
  matchedMarkets: Array<{
    slug: string;
    question: string;
    relevance: number;
    direction?: string;
  }>;
  source: string;
  sourceTier: number;
  timestamp: number;
}

export interface GlintWhaleEvent {
  marketSlug: string;
  marketQuestion: string;
  side: 'buy' | 'sell';
  size: number;
  walletAge: string;
  isNew: boolean;
  walletAddress?: string;
  timestamp: number;
}

interface GlintScraperOptions {
  headless?: boolean;
  cookiePath?: string;
  userDataDir?: string;
  debugFrames?: boolean;
}

export class GlintScraper extends EventEmitter {
  private browser: any = null;
  private page: any = null;
  private cdpSession: any = null;
  private running = false;
  private connected = false;
  private reconnecting = false; // guard against cascading reconnects during page refresh
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private livenessTimer: ReturnType<typeof setInterval> | null = null;
  private pageRefreshFailures = 0;
  private connectedAt = 0; // timestamp of last successful connect (for stable-connection check)
  private signalCount = 0;
  private whaleCount = 0;
  private lastFrameTime = 0;
  private rawFrameCount = 0;
  private reconnectCount = 0;
  private opts: Required<GlintScraperOptions>;

  private readonly LIVENESS_TIMEOUT_MS = 120_000;
  private readonly LIVENESS_CHECK_INTERVAL_MS = 30_000;
  private readonly MAX_PAGE_REFRESH_FAILURES = 5;
  private readonly RECONNECT_DELAY_MS = 15_000;
  private readonly MAX_RECONNECT_DELAY_MS = 60_000;

  constructor(options: GlintScraperOptions = {}) {
    super();
    this.opts = {
      headless: options.headless ?? true,
      cookiePath: options.cookiePath ?? join(process.cwd(), '.glint', 'cookies.json'),
      userDataDir: options.userDataDir ?? join(process.cwd(), '.glint', 'browser-data'),
      debugFrames: options.debugFrames ?? (process.env.GLINT_DEBUG === 'true'),
    };
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    logger.info('GlintScraper starting...');

    try {
      const puppeteer = await import('puppeteer');
      const cookieDir = join(this.opts.cookiePath, '..');
      if (!existsSync(cookieDir)) mkdirSync(cookieDir, { recursive: true });

      const hasCookies = existsSync(this.opts.cookiePath);
      const launchHeadless = hasCookies ? this.opts.headless : false;

      this.browser = await puppeteer.default.launch({
        headless: launchHeadless,
        userDataDir: this.opts.userDataDir,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled', '--window-size=1440,900'],
        defaultViewport: { width: 1440, height: 900 },
      });

      this.page = await this.browser.newPage();
      await this.page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
      });

      if (hasCookies) {
        try {
          const cookies = JSON.parse(readFileSync(this.opts.cookiePath, 'utf-8'));
          await this.page.setCookie(...cookies);
          logger.info('GlintScraper: Loaded saved cookies');
        } catch (err) { logger.warn(`GlintScraper: Failed to load cookies: ${err}`); }
      }

      await this.setupCDPAndNavigate();
      this.startLivenessWatchdog();
      setInterval(async () => { if (this.running && this.page) await this.saveCookies(); }, 5 * 60 * 1000);

    } catch (err) {
      logger.error(`GlintScraper: Start failed: ${err}`);
      this.scheduleReconnect('start_failed');
    }
  }

  private async setupCDPAndNavigate(): Promise<void> {
    if (this.cdpSession) {
      try { this.cdpSession.removeAllListeners(); } catch {}
    }

    this.cdpSession = await this.page.createCDPSession();
    await this.cdpSession.send('Network.enable');

    if (this.opts.debugFrames) {
      const debugPath = join(process.cwd(), '.glint', 'ws-frames-debug.log');
      logger.info(`GlintScraper: DEBUG MODE — logging to ${debugPath}`);
      try { writeFileSync(debugPath, `# Glint WS Debug Log — ${new Date().toISOString()}\n\n`); } catch {}
    }

    this.cdpSession.on('Network.webSocketFrameReceived', (params: any) => this.handleWebSocketFrame(params));
    this.cdpSession.on('Network.webSocketCreated', (params: any) => {
      logger.info(`GlintScraper: WebSocket created -> ${params.url?.slice(0, 100)}`);
    });
    this.cdpSession.on('Network.webSocketClosed', (_params: any) => {
      logger.warn('GlintScraper: WebSocket closed — will page-refresh to reconnect');
      this.connected = false;
      this.emit('disconnected', { reason: 'websocket_closed' });
      this.scheduleReconnect('ws_closed');
    });

    logger.info('GlintScraper: Navigating to glint.trade...');
    await this.page.goto('https://glint.trade/events', { waitUntil: 'networkidle2', timeout: 60_000 });

    const isLoggedIn = await this.checkLoginStatus();
    if (!isLoggedIn) {
      const hasCookies = existsSync(this.opts.cookiePath);
      if (hasCookies) logger.warn('GlintScraper: Saved cookies expired.');
      logger.info('GlintScraper: ========================================');
      logger.info('GlintScraper: MANUAL LOGIN REQUIRED — sign in with Google');
      logger.info('GlintScraper: Waiting up to 120 seconds...');
      logger.info('GlintScraper: ========================================');

      const loginStart = Date.now();
      let loggedIn = false;
      while (Date.now() - loginStart < 120_000) {
        await this.delay(5000);
        loggedIn = await this.checkLoginStatus();
        if (loggedIn) break;
        logger.info('GlintScraper: Still waiting for login...');
      }
      if (!loggedIn) { logger.error('GlintScraper: Login timeout.'); await this.stop(); return; }
    }

    await this.saveCookies();
    this.connected = true;
    this.lastFrameTime = Date.now();
    this.connectedAt = Date.now(); // record stable-connection start (don't reset failures here)
    logger.info('GlintScraper: Connected and monitoring feed + whale_trades rooms');
    this.emit('connected', {});
  }

  private isBrowserDeadError(err: unknown): boolean {
    const msg = String(err).toLowerCase();
    return msg.includes('connectionclosed') || msg.includes('connection closed') ||
           msg.includes('target closed') || msg.includes('session closed') ||
           msg.includes('protocol error') || msg.includes('browser has disconnected');
  }

  private async pageRefreshReconnect(reason: string): Promise<void> {
    if (!this.running || !this.page) return;

    this.reconnecting = true;
    this.reconnectCount++;
    this.pageRefreshFailures++;
    logger.info(`GlintScraper: Page-refresh reconnect #${this.reconnectCount} (reason: ${reason}, consecutive failures: ${this.pageRefreshFailures})`);

    if (this.pageRefreshFailures > this.MAX_PAGE_REFRESH_FAILURES) {
      logger.warn(`GlintScraper: ${this.pageRefreshFailures} consecutive page-refresh failures — full browser restart`);
      this.reconnecting = false;
      await this.fullRestart();
      return;
    }

    try {
      this.connected = false;
      await this.setupCDPAndNavigate();
    } catch (err) {
      // If the browser itself is dead, escalate immediately — page refresh is futile
      if (this.isBrowserDeadError(err)) {
        logger.warn(`GlintScraper: Browser dead (${err}) — escalating to full restart immediately`);
        this.reconnecting = false;
        await this.fullRestart();
        return;
      }
      logger.error(`GlintScraper: Page-refresh failed: ${err}`);
      this.reconnecting = false;
      this.scheduleReconnect('page_refresh_failed');
      return;
    }
    this.reconnecting = false;
  }

  private async fullRestart(): Promise<void> {
    logger.info('GlintScraper: Full browser restart...');
    try {
      if (this.browser) { try { await this.browser.close(); } catch {} }
      this.browser = null;
      this.page = null;
      this.cdpSession = null;
      this.connected = false;
      this.pageRefreshFailures = 0;
      this.running = false;
      await this.start();
    } catch (err) {
      logger.error(`GlintScraper: Full restart failed: ${err}`);
      this.scheduleReconnect('full_restart_failed');
    }
  }

  private scheduleReconnect(reason: string): void {
    if (!this.running) return;
    // Don't stack another reconnect while pageRefreshReconnect is already executing
    if (this.reconnecting) { logger.debug(`GlintScraper: Ignoring scheduleReconnect(${reason}) — reconnect already in progress`); return; }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }

    // Only reset failure counter on a clean disconnect (ws_closed / liveness_timeout),
    // NOT on page_refresh_failed — that would prevent fullRestart from ever triggering.
    const connectionAge = this.connectedAt > 0 ? Date.now() - this.connectedAt : 0;
    if (connectionAge > 60_000 && reason !== 'page_refresh_failed') {
      this.pageRefreshFailures = 0;
      logger.debug(`GlintScraper: Connection was stable ${(connectionAge / 1000).toFixed(0)}s — reset failure count`);
    }

    const delay = Math.min(
      this.RECONNECT_DELAY_MS * Math.pow(1.5, Math.min(this.pageRefreshFailures, 5)),
      this.MAX_RECONNECT_DELAY_MS
    );
    logger.info(`GlintScraper: Scheduling reconnect in ${(delay / 1000).toFixed(0)}s (reason: ${reason}, failures: ${this.pageRefreshFailures})`);

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      // WS may have reconnected on its own during the delay — skip page refresh if already connected.
      if (this.connected) {
        logger.debug(`GlintScraper: Skipping page-refresh — already reconnected (reason: ${reason})`);
        return;
      }
      await this.pageRefreshReconnect(reason);
    }, delay);
  }

  private startLivenessWatchdog(): void {
    if (this.livenessTimer) clearInterval(this.livenessTimer);

    this.livenessTimer = setInterval(() => {
      if (!this.running || !this.connected) return;

      const timeSinceLastFrame = Date.now() - this.lastFrameTime;
      if (this.lastFrameTime > 0 && timeSinceLastFrame > this.LIVENESS_TIMEOUT_MS) {
        logger.warn(`GlintScraper: No WS frames for ${(timeSinceLastFrame / 1000).toFixed(0)}s — forcing reconnect`);
        this.connected = false;
        this.emit('disconnected', { reason: 'liveness_timeout' });
        this.scheduleReconnect('liveness_timeout');
      }
    }, this.LIVENESS_CHECK_INTERVAL_MS);
  }

  async stop(): Promise<void> {
    this.running = false;
    this.connected = false;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.livenessTimer) { clearInterval(this.livenessTimer); this.livenessTimer = null; }
    if (this.page) { try { await this.saveCookies(); } catch {} }
    if (this.browser) { try { await this.browser.close(); } catch {} this.browser = null; this.page = null; this.cdpSession = null; }
    logger.info(`GlintScraper stopped. Signals: ${this.signalCount}, Whales: ${this.whaleCount}, Frames: ${this.rawFrameCount}, Reconnects: ${this.reconnectCount}`);
  }

  private async checkLoginStatus(): Promise<boolean> {
    try {
      return await this.page.evaluate(() => {
        const text = document.body?.innerText || '';
        if (text.includes('Sign in to unlock') || text.includes('Get Started')) return false;
        if (text.includes('Feed') && (text.includes('CRITICAL') || text.includes('HIGH') || text.includes('MEDIUM'))) return true;
        const nav = document.querySelector('nav');
        if (nav?.textContent?.includes('Portfolio')) return true;
        return false;
      });
    } catch { return false; }
  }

  private handleWebSocketFrame(params: any): void {
    try {
      const payload = params.response?.payloadData;
      if (!payload) return;
      this.rawFrameCount++;
      this.lastFrameTime = Date.now();

      if (this.opts.debugFrames && (this.rawFrameCount <= 50 || this.rawFrameCount % 100 === 0)) {
        const preview = payload.length > 500 ? payload.slice(0, 500) + '...[truncated]' : payload;
        logger.info(`GlintScraper: RAW WS #${this.rawFrameCount} (${payload.length}b): ${preview}`);
        try {
          appendFileSync(join(process.cwd(), '.glint', 'ws-frames-debug.log'),
            `\n--- FRAME #${this.rawFrameCount} [${new Date().toISOString()}] (${payload.length}b) ---\n${payload}\n`);
        } catch {}
      }

      let frame: any;
      try { frame = JSON.parse(payload); } catch { return; }

      const room = frame.room;
      const data = frame.data;

      if (room === 'health_check') return;
      if (frame.action === 'authenticate' || frame.action === 'room_joined') return;
      if (!data) return;
      if (Array.isArray(data)) return;
      if (typeof data !== 'object') return;

      if (room === 'feed') {
        this.parseFeedSignal(data);
      } else if (room === 'whale_trades') {
        this.parseWhaleTrade(data);
      } else if (room === 'red_alerts') {
        this.parseFeedSignal(data, 'critical');
      }
    } catch {}
  }

  private parseFeedSignal(data: any, forceImpact?: string): void {
    try {
      let headline = '';
      let source = 'glint';
      let sourceTier = 3;
      let category = 'unknown';

      if (data.news && data.news.headline) {
        headline = data.news.headline;
        source = data.news.source || 'news';
        sourceTier = this.getSourceTier(source);
        category = 'news';
      } else if (data.tweet && (data.tweet.body || data.tweet.text)) {
        headline = data.tweet.body || data.tweet.text;
        const user = data.tweet.user;
        source = user ? `@${user.handle || user.display_name}` : 'twitter';
        sourceTier = 2;
        category = data.tweet.tags?.[0] || 'social';
      } else if (data.telegram && data.telegram.text) {
        headline = data.telegram.text;
        source = data.telegram.channel || 'telegram';
        sourceTier = 3;
        category = 'telegram';
      } else if (data.reddit) {
        headline = data.reddit.title || data.reddit.text || data.reddit.body || '';
        source = data.reddit.subreddit || 'reddit';
        sourceTier = 3;
        category = 'reddit';
      } else {
        headline = data.headline || data.title || data.text || data.body || '';
        source = data.source || 'glint';
      }

      if (!headline || headline.length < 10) return;

      const impact = forceImpact ||
        data.signal_level ||
        data.news?.signal_level ||
        data.tweet?.signal_level ||
        data.telegram?.signal_level ||
        'medium';

      const matchedMarkets = this.extractGlintMarketMatches(data);
      if (data.topics?.length) category = data.topics[0];
      if (data.categories?.length) category = data.categories[0];

      const event: GlintSignalEvent = {
        headline: String(headline).slice(0, 500),
        impact: this.normalizeImpact(impact),
        category,
        matchedMarkets,
        source,
        sourceTier,
        timestamp: data.timestamp || data.news?.timestamp || data.tweet?.created_at || data.telegram?.timestamp || Date.now(),
      };

      this.signalCount++;
      this.lastFrameTime = Date.now();
      this.emit('signal', event);
    } catch (err) {
      logger.warn(`GlintScraper: Feed parse error: ${err}`);
    }
  }

  private parseWhaleTrade(data: any): void {
    try {
      const amount = Number(data.amount || data.size || 0);
      if (amount < 10_000) return;

      const side = (data.side || '').toLowerCase();
      if (side !== 'buy' && side !== 'sell') return;

      const market = data.market || {};

      const event: GlintWhaleEvent = {
        marketSlug: market.slug || market.id || '',
        marketQuestion: market.question || market.title || '',
        side: side as 'buy' | 'sell',
        size: amount,
        walletAge: data.wallet_age || data.account_age || 'unknown',
        isNew: data.is_new || data.new_account || false,
        walletAddress: data.wallet || '',
        timestamp: data.timestamp || Date.now(),
      };

      this.whaleCount++;
      logger.info(`GlintScraper: Whale [${side.toUpperCase()} $${amount.toLocaleString()}] ${event.marketQuestion.slice(0, 60)}`, {
        wallet: data.wallet?.slice(0, 10) + '...',
      });

      this.emit('whale', event);
    } catch (err) {
      logger.warn(`GlintScraper: Whale parse error: ${err}`);
    }
  }

  private getSourceTier(source: string): number {
    const s = source.toLowerCase();
    const tier1 = ['reuters', 'ap', 'bloomberg', 'wsj', 'nytimes', 'ft', 'bbc', 'cnbc', 'associated press', 'financial times'];
    if (tier1.some(t => s.includes(t))) return 1;
    const tier2 = ['coindesk', 'theblock', 'politico', 'axios', 'guardian', 'cnn', 'fox', 'decrypt', 'cointelegraph'];
    if (tier2.some(t => s.includes(t))) return 2;
    return 3;
  }

  private normalizeImpact(impact: string | number): 'critical' | 'high' | 'medium' | 'low' {
    if (typeof impact === 'number') {
      if (impact >= 80) return 'critical';
      if (impact >= 60) return 'high';
      if (impact >= 40) return 'medium';
      return 'low';
    }
    const s = String(impact).toLowerCase();
    if (s.includes('critical') || s === '4') return 'critical';
    if (s.includes('high') || s === '3') return 'high';
    if (s.includes('medium') || s.includes('med') || s === '2') return 'medium';
    return 'low';
  }

  private extractGlintMarketMatches(data: any): GlintSignalEvent['matchedMarkets'] {
    const markets = data.related_markets || data.matched_markets || data.markets || [];
    if (Array.isArray(markets)) {
      return markets.map((m: any) => {
        if (typeof m === 'string') return { slug: m, question: m, relevance: 0.7 };
        return {
          slug: m.slug || m.id || m.condition_id || '',
          question: m.question || m.title || '',
          relevance: m.relevance || m.score || m.match_score || 0.7,
          direction: m.direction || m.causation || undefined,
        };
      }).filter((m: any) => m.slug || m.question);
    }
    return [];
  }

  private async saveCookies(): Promise<void> {
    try {
      if (!this.page) return;
      const cookies = await this.page.cookies();
      const cookieDir = join(this.opts.cookiePath, '..');
      if (!existsSync(cookieDir)) mkdirSync(cookieDir, { recursive: true });
      writeFileSync(this.opts.cookiePath, JSON.stringify(cookies, null, 2));
    } catch (err) { logger.warn(`GlintScraper: Cookie save failed: ${err}`); }
  }

  private delay(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }

  isConnected(): boolean { return this.connected; }

  getStats() {
    return { signalCount: this.signalCount, whaleCount: this.whaleCount, connected: this.connected, lastSignalTime: this.lastFrameTime, rawFrameCount: this.rawFrameCount, reconnectCount: this.reconnectCount };
  }
}
