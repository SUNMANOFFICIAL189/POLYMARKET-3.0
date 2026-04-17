/**
 * News Scanner — polls RSS feeds for prediction-market-relevant news.
 * Deduplicates by URL hash. Emits news events.
 */

import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { logger } from '../utils/logger.js';

export interface NewsItem {
  title: string;
  description: string;
  url: string;
  source: string;
  publishedAt: string;
}

interface RSSFeed {
  name: string;
  url: string;
  priority: 'high' | 'medium' | 'low';
}

const DEFAULT_FEEDS: RSSFeed[] = [
  // --- Tier 1: High-priority mainstream ---
  { name: 'NPR News', url: 'https://feeds.npr.org/1001/rss.xml', priority: 'high' },
  { name: 'Politico', url: 'https://rss.politico.com/politics-news.xml', priority: 'high' },
  { name: 'AP News', url: 'https://rsshub.app/apnews/topics/apf-topnews', priority: 'high' },
  { name: 'Reuters World', url: 'https://www.reutersagency.com/feed/?taxonomy=best-sectors&post_type=best', priority: 'high' },
  // --- Tier 1: High-priority crypto-native ---
  { name: 'The Block', url: 'https://www.theblock.co/rss/all', priority: 'high' },
  { name: 'Decrypt', url: 'https://decrypt.co/feed', priority: 'high' },
  // --- Tier 2: Medium-priority ---
  { name: 'BBC World', url: 'https://feeds.bbci.co.uk/news/world/rss.xml', priority: 'medium' },
  { name: 'CoinDesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/', priority: 'medium' },
  { name: 'CoinTelegraph', url: 'https://cointelegraph.com/rss', priority: 'medium' },
  { name: 'Al Jazeera', url: 'https://www.aljazeera.com/xml/rss/all.xml', priority: 'medium' },
  { name: 'The Hill', url: 'https://thehill.com/feed/', priority: 'medium' },
  { name: 'Axios', url: 'https://api.axios.com/feed/', priority: 'medium' },
];

const RELEVANCE_KEYWORDS = [
  // Politics & governance
  'election', 'president', 'vote', 'poll', 'congress', 'senate', 'supreme court',
  'indictment', 'impeach', 'resign', 'trial', 'verdict',
  // Macro & monetary
  'fed', 'federal reserve', 'interest rate', 'inflation', 'gdp', 'recession',
  'rate cut', 'rate hike', 'fomc', 'tariff',
  // Crypto & web3
  'bitcoin', 'crypto', 'ethereum', 'sec', 'regulation',
  'stablecoin', 'defi', 'nft', 'solana', 'xrp',
  // Geopolitics & conflict
  'war', 'conflict', 'sanctions', 'nato', 'china', 'russia', 'ukraine', 'iran',
  'ceasefire', 'blockade', 'strait', 'hormuz', 'nuclear', 'iran deal',
  // Religion & world events
  'pope', 'vatican',
  // Tech & companies
  'ai', 'openai', 'google', 'apple', 'tesla', 'spacex', 'nvidia',
  'trump', 'biden', 'harris',
  // Markets & corporate
  'merger', 'acquisition', 'ipo', 'earnings',
  // Prediction markets
  'polymarket', 'prediction market',
];

export class NewsScanner extends EventEmitter {
  private seenHashes = new Set<string>();
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private feeds: RSSFeed[];
  private pollingMs: number;

  constructor(opts: { feeds?: RSSFeed[]; pollingMs?: number } = {}) {
    super();
    this.feeds = opts.feeds ?? DEFAULT_FEEDS;
    this.pollingMs = opts.pollingMs ?? 15_000;
  }

  start(): void {
    logger.info(`NewsScanner starting — ${this.feeds.length} feeds, ${this.pollingMs}ms interval`);
    this.poll();
    this.intervalId = setInterval(() => this.poll(), this.pollingMs);
  }

  stop(): void {
    if (this.intervalId) { clearInterval(this.intervalId); this.intervalId = null; }
    logger.info('NewsScanner stopped');
  }

  private async poll(): Promise<void> {
    try {
      const items: NewsItem[] = [];
      for (const feed of this.feeds) {
        try {
          const feedItems = await this.fetchRSS(feed);
          items.push(...feedItems);
        } catch (err) { logger.warn(`RSS fetch failed for ${feed.name}: ${err}`); }
      }
      let newCount = 0;
      for (const item of items) {
        const hash = crypto.createHash('md5').update(item.url || item.title).digest('hex').slice(0, 12);
        if (this.seenHashes.has(hash)) continue;
        this.seenHashes.add(hash);
        if (this.seenHashes.size > 10_000) {
          const arr = Array.from(this.seenHashes);
          this.seenHashes = new Set(arr.slice(-8000));
        }
        if (this.isRelevant(item)) {
          newCount++;
          this.emit('news', {
            id: hash,
            source: 'news' as const,
            headline: item.title,
            body: item.description,
            url: item.url,
            timestamp: item.publishedAt || new Date().toISOString(),
            metadata: { feedSource: item.source },
          });
        }
      }
      if (newCount > 0) logger.info(`NewsScanner: ${newCount} new relevant items from ${items.length} total`);
    } catch (err) { logger.error(`NewsScanner poll error: ${err}`); }
  }

  private async fetchRSS(feed: RSSFeed): Promise<NewsItem[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await fetch(feed.url, { signal: controller.signal });
      const xml = await res.text();
      return this.parseRSSXml(xml, feed.name);
    } finally { clearTimeout(timeout); }
  }

  private parseRSSXml(xml: string, source: string): NewsItem[] {
    const items: NewsItem[] = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
    let match: RegExpExecArray | null;
    while ((match = itemRegex.exec(xml)) !== null) {
      const block = match[1];
      const title = this.extractTag(block, 'title');
      const link = this.extractTag(block, 'link');
      const description = this.extractTag(block, 'description');
      const pubDate = this.extractTag(block, 'pubDate');
      if (title && link) {
        items.push({
          title: this.stripHtml(title),
          description: this.stripHtml(description || ''),
          url: link,
          source,
          publishedAt: pubDate ? new Date(pubDate).toISOString() : new Date().toISOString(),
        });
      }
    }
    return items;
  }

  private extractTag(xml: string, tag: string): string | null {
    const cdataRegex = new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>`, 'i');
    const cdataMatch = cdataRegex.exec(xml);
    if (cdataMatch) return cdataMatch[1].trim();
    const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i');
    const match = regex.exec(xml);
    return match ? match[1].trim() : null;
  }

  private stripHtml(html: string): string {
    return html.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
  }

  private isRelevant(item: NewsItem): boolean {
    const text = `${item.title} ${item.description}`.toLowerCase();
    return RELEVANCE_KEYWORDS.some(kw => text.includes(kw));
  }
}
