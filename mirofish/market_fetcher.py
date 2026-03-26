"""
MiroFish Polymarket Scanner - Market Fetcher
Fetches active Polymarket markets for simulation.
Uses Polymarket's public CLOB and Gamma APIs.
"""
import aiohttp
import logging
from typing import List, Dict, Optional

logger = logging.getLogger("mirofish.market_fetcher")


async def fetch_active_markets(max_markets: int = 5) -> List[Dict]:
    """
    Fetch the most active/liquid Polymarket markets for simulation.
    Prioritizes markets with high volume and reasonable odds (not settled).
    """
    markets = []

    try:
        async with aiohttp.ClientSession() as session:
            # Use Gamma API for enriched market data
            url = "https://gamma-api.polymarket.com/events"
            params = {
                "active": "true",
                "closed": "false",
                "order": "volume24hr",
                "ascending": "false",
                "limit": max_markets * 3,  # fetch extra, filter down
            }

            async with session.get(url, params=params, timeout=aiohttp.ClientTimeout(total=15)) as resp:
                if resp.status != 200:
                    logger.error(f"Gamma API returned {resp.status}")
                    return []

                events = await resp.json()

                for event in events:
                    if not event.get("markets"):
                        continue

                    for market in event["markets"]:
                        # Skip resolved or very low-liquidity markets
                        if market.get("closed") or market.get("resolved"):
                            continue

                        volume = float(market.get("volume", 0) or 0)
                        if volume < 10000:  # skip illiquid markets
                            continue

                        best_bid = float(market.get("bestBid", 0) or 0)
                        best_ask = float(market.get("bestAsk", 0) or 0)

                        # Skip markets at extreme odds (>95% or <5%) - no edge to find
                        if best_bid > 0.95 or best_ask < 0.05:
                            continue

                        markets.append({
                            "condition_id": market.get("conditionId", ""),
                            "question": market.get("question", event.get("title", "")),
                            "description": market.get("description", event.get("description", "")),
                            "category": event.get("category", "unknown"),
                            "current_price": round((best_bid + best_ask) / 2, 4) if best_bid and best_ask else None,
                            "best_bid": best_bid,
                            "best_ask": best_ask,
                            "volume_24h": volume,
                            "volume_total": float(market.get("volumeNum", 0) or 0),
                            "end_date": market.get("endDate", ""),
                            "outcome_yes": market.get("outcomePrices", ""),
                            "slug": event.get("slug", ""),
                        })

                # Sort by 24h volume and take top N
                markets.sort(key=lambda m: m["volume_24h"], reverse=True)
                markets = markets[:max_markets]

                logger.info(f"Fetched {len(markets)} active markets for simulation")
                for m in markets:
                    logger.info(f"  - {m['question'][:60]}... price={m['current_price']} vol24h=${m['volume_24h']:,.0f}")

    except Exception as e:
        logger.error(f"Failed to fetch markets: {e}")

    return markets


async def fetch_market_context(market: Dict) -> str:
    """
    Build a rich context string for a market, suitable for agent simulation.
    Includes the question, description, current odds, and volume.
    """
    lines = [
        f"PREDICTION MARKET QUESTION: {market['question']}",
        f"",
        f"DESCRIPTION: {market.get('description', 'No additional description available.')}",
        f"",
        f"CURRENT MARKET DATA:",
        f"  - Current implied probability: {market['current_price']*100:.1f}% YES / {(1-market['current_price'])*100:.1f}% NO" if market['current_price'] else "  - Price data unavailable",
        f"  - Best bid: {market['best_bid']*100:.1f}¢ | Best ask: {market['best_ask']*100:.1f}¢",
        f"  - 24h trading volume: ${market['volume_24h']:,.0f}",
        f"  - Total volume: ${market['volume_total']:,.0f}",
        f"  - Category: {market['category']}",
        f"  - Resolution date: {market.get('end_date', 'Unknown')}",
        f"",
        f"Your task: Analyze this prediction market. Consider all available information,",
        f"news, expert opinions, historical patterns, and your own reasoning.",
        f"Provide your honest probability estimate for YES outcome (0-100%).",
        f"Explain your reasoning briefly.",
    ]
    return "\n".join(lines)
