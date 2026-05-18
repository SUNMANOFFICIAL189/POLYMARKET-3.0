/**
 * MarketCategoriser — keyword-based prediction market category classifier.
 *
 * Research basis (PANews 112K wallet study):
 *   - Traders specialising in 1-2 categories: avg +$4,200 profit
 *   - Traders active in 5+ categories: avg -$2,100 loss
 *
 * When a watcher is detected as a specialist and trades outside their primary
 * category, the corroboration threshold is raised (AI confidence ≥0.85 instead
 * of 0.75) to reduce low-edge out-of-specialty copies.
 */

export type MarketCategory = 'sports' | 'politics' | 'crypto' | 'finance' | 'other';

const KEYWORDS: Record<Exclude<MarketCategory, 'other'>, string[]> = {
  sports: [
    'nfl', 'nba', 'mlb', 'nhl', 'mls', 'epl', 'premier league', 'la liga',
    'bundesliga', 'serie a', 'champions league', 'world cup', 'super bowl',
    'superbowl', 'basketball', 'football', 'soccer', 'baseball', 'hockey',
    'tennis', 'golf', 'cricket', 'ufc', 'boxing', 'mma', 'olympics',
    'wimbledon', 'playoffs', 'championship', 'match', 'tournament',
    'manchester', 'liverpool', 'chelsea', 'arsenal', 'tottenham',
    'barcelona', 'real madrid', 'juventus', 'psg', 'bayern', 'atletico',
    'sporting', 'deportivo', 'inter milan', 'ac milan', 'espanyol',
    'lakers', 'celtics', 'warriors', 'bulls', 'heat', 'nets', 'knicks',
    'yankees', 'dodgers', 'cubs', 'red sox', 'ncaa', 'march madness',
    'murray state', 'wyoming', 'kentucky', 'duke',
    // Tennis: ATP/WTA tournament cities & keywords
    'zadar', 'murcia', 'santiago', 'acapulco', 'doha', 'miami open',
    'indian wells', 'roland garros', 'us open tennis', 'atp', 'wta',
    'challenger', 'grandslam', 'grand slam',
    'fc ', 'afc ', 'nfc ', ' fc', ' sc', 'rcd ',
    'goals scored', 'exact score', 'spread:', 'over/under',
    'qualify', 'relegated',
    'senators', 'hurricanes', 'penguins', 'bruins', 'canadiens',
    'maple leafs', 'oilers', 'flames', 'canucks', 'avalanche',
    'predators', 'blue jackets', 'wild', 'kraken', 'lightning',
    'red wings', 'capitals', 'islanders', 'devils', 'sabres',
    'blackhawks', 'ducks', 'timberwolves', 'nuggets', 'raptors',
    'cavaliers', 'pacers', 'bucks', 'suns', 'clippers', 'spurs',
    'pelicans', 'hornets', 'magic', 'pistons', 'grizzlies',
    'rockets', 'thunder', 'trail blazers', 'jazz', 'hawks',
    'mavericks', '76ers', 'sixers', 'patriots', 'steelers',
    'cowboys', 'eagles', 'packers', 'seahawks', 'ravens',
    'chiefs', 'broncos', 'raiders', 'chargers', 'dolphins',
    'bengals', 'titans', 'texans', 'jaguars', 'colts',
    'commanders', 'saints', 'falcons', 'buccaneers', 'vikings',
    'bears', 'lions', 'rams', '49ers',
    'dota', 'csgo', 'cs2', 'counter-strike', 'valorant',
    'league of legends', 'overwatch', 'starcraft',
    'iem ', 'esl ', 'blast ', 'pgl ', 'dreamhack',
    'faze', 'navi', 'fnatic', 'cloud9', 'furia', 'mouz',
    'heroic', 'oddik', 'shifters',
    'game winner', 'map winner', 'set winner',
    'total goals', 'total points', 'handicap:',
    // Phase 1.3 (2026-05-18): modern esports markets use "LoL:" / format
    // prefix that the older "league of legends" keyword misses. Bilibili
    // Gaming (LoL LPL) and Karmine Corp (LoL LEC) trades cost -$326 across
    // 6 trades in the 2026-05-17 → 18 window because of this gap.
    'lol:', 'lpl', 'lcs', 'lec', 'lck', 'msi', 'worlds 2026',
    'bo3', 'bo5', ' bo3 ', ' bo5 ',
    'karmine corp', 'flyquest', 'bilibili', 'movistar koi',
    'anyone\'s legend', 'lyon ', 't1 ', 'gen.g', 'hanwha',
    'esports world cup', 'lol ', 'lan finals',
    'pickem', 'pick em',
  ],
  politics: [
    'election', 'president', 'congress', 'senate', 'house of representatives',
    'vote', 'ballot', 'democrat', 'republican', 'gop', 'biden', 'trump',
    'harris', 'obama', 'prime minister', 'parliament', 'referendum',
    'legislation', 'bill passed', 'governor', 'mayor', 'nominee',
    'primary', 'caucus', 'swing state', 'white house', 'supreme court',
    'impeach', 'filibuster', 'macron', 'scholz', 'sunak', 'modi',
    'xi jinping', 'putin', 'nato', 'ukraine', 'sanctions', 'tariff',
    'trade war', 'g7', 'g20', 'un security council', 'peace deal',
    'ceasefire', 'cabinet', 'minister', 'chancellor', 'parliament',
    // Geopolitics flashpoints — added 2026-05-11 from sprint findings.
    // Sports keywords run first in iteration order, so any country/region
    // name colliding with a sports event ("China Open") wins sports.
    'iran', 'israel', 'gaza', 'palestine', 'hamas', 'hezbollah', 'lebanon',
    'syria', 'taiwan', 'north korea', 'jerusalem', 'west bank',
    'middle east', 'venezuela',
    // International leaders missing from original list
    'netanyahu', 'zelensky', 'erdogan', 'kim jong', 'starmer',
    // US cabinet (current admin) — drove a chunk of Polymarket 2026 politics
    'lutnick', 'noem', 'rubio', 'hegseth',
    // Diplomacy / treaty / scandal topics
    'epstein', 'treaty', 'embassy', 'ambassador', 'diplomatic',
  ],
  crypto: [
    'bitcoin', 'btc', 'ethereum', 'eth', 'solana', 'sol', 'bnb', 'xrp',
    'crypto', 'blockchain', 'defi', 'nft', 'dao', 'web3', 'coinbase',
    'binance', 'kraken', 'dex', 'cex', 'stablecoin', 'usdt', 'usdc',
    'dai', 'halving', 'mining', 'altcoin', 'airdrop', 'yield farming',
    'liquidity pool', 'protocol', '$100k', '$200k', 'all-time high',
    'bear market', 'bull run', 'sec crypto', 'bitcoin etf', 'spot etf',
    'cardano', 'polkadot', 'avalanche', 'chainlink', 'uniswap',
  ],
  finance: [
    'federal reserve', 'fed rate', 'interest rate', 'inflation', 'gdp',
    'recession', 's&p 500', 'nasdaq', 'dow jones', 'stock market', 'ipo',
    'earnings', 'apple stock', 'google', 'microsoft', 'amazon', 'tesla',
    'nvidia', 'meta stock', 'oil price', 'gold price', 'dollar index',
    'euro dollar', 'yen', 'forex', 'treasury yield', 'fomc', 'rate hike',
    'rate cut', 'debt ceiling', 'fiscal', 'bank run', 'mortgage rate',
  ],
};

/**
 * Classify a market question into a category using keyword matching.
 * Returns 'other' if no keywords match.
 */
export function categoriseMarket(question: string): MarketCategory {
  const q = question.toLowerCase();
  for (const [cat, keywords] of Object.entries(KEYWORDS) as [Exclude<MarketCategory, 'other'>, string[]][]) {
    if (keywords.some(kw => q.includes(kw))) return cat;
  }
  return 'other';
}

/**
 * Given a wallet's trade category history, determine if they are a specialist.
 * Returns the dominant category if ≥70% of trades are in one category
 * AND there are at least `minSamples` trades to judge from; otherwise null.
 */
export function detectSpecialistCategory(
  categories: MarketCategory[],
  minSamples = 5,
  threshold = 0.70,
): MarketCategory | null {
  if (categories.length < minSamples) return null;

  const counts: Partial<Record<MarketCategory, number>> = {};
  for (const c of categories) counts[c] = (counts[c] ?? 0) + 1;

  for (const [cat, count] of Object.entries(counts) as [MarketCategory, number][]) {
    if ((count / categories.length) >= threshold) return cat;
  }
  return null;
}
