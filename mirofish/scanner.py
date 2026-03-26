#!/usr/bin/env python3
"""
MiroFish Polymarket Scanner - Main Service
Runs periodic swarm simulations on active Polymarket markets.
Stores results in Supabase for the bot's confirmation layer to consume.

Usage:
    python scanner.py                    # Run once
    python scanner.py --daemon           # Run continuously every 90 minutes
    python scanner.py --market "Will X?" # Scan a specific market question
"""
import asyncio
import argparse
import json
import logging
import os
import sys
from datetime import datetime, timezone
from typing import Dict, List, Optional

# Add parent dir to path for imports
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from config import Config
from market_fetcher import fetch_active_markets, fetch_market_context
from agent_generator import generate_agent_profiles, save_profiles
from simulation_runner import run_simulation, run_fallback_simulation

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
    handlers=[
        logging.StreamHandler(),
        logging.FileHandler(os.path.join(Config.BASE_DIR, "scanner.log")),
    ],
)
logger = logging.getLogger("mirofish.scanner")


async def scan_market(market: Dict) -> Optional[Dict]:
    """
    Run a full swarm simulation on a single Polymarket market.
    Returns the scan result with swarm consensus vs market price.
    """
    logger.info(f"{'='*60}")
    logger.info(f"SCANNING: {market['question'][:80]}")
    logger.info(f"  Current price: {market['current_price']*100:.1f}% YES")
    logger.info(f"  Category: {market['category']}")
    logger.info(f"{'='*60}")

    try:
        # 1. Generate market context
        context = await fetch_market_context(market)

        # 2. Generate agent profiles
        profiles = generate_agent_profiles(
            market_context=context,
            agent_count=Config.AGENT_COUNT,
            category=market.get("category", "general"),
        )
        profile_path = save_profiles(profiles, f"scan_{market['condition_id'][:8]}.json")

        # 3. Run simulation
        result = await run_simulation(
            profile_path=profile_path,
            market_context=context,
            market_question=market["question"],
            max_rounds=Config.MAX_ROUNDS,
            semaphore_limit=Config.SEMAPHORE_LIMIT,
        )

        # 4. Calculate edge (swarm vs market)
        swarm_prob = result["swarm_probability"] / 100  # normalize to 0-1
        market_prob = market["current_price"] or 0.5
        edge = swarm_prob - market_prob
        edge_pct = edge * 100

        # Determine signal
        if abs(edge_pct) < 3:
            signal = "NEUTRAL"
            signal_strength = "weak"
        elif abs(edge_pct) < 8:
            signal = "YES" if edge > 0 else "NO"
            signal_strength = "moderate"
        elif abs(edge_pct) < 15:
            signal = "YES" if edge > 0 else "NO"
            signal_strength = "strong"
        else:
            signal = "YES" if edge > 0 else "NO"
            signal_strength = "very_strong"

        scan_result = {
            "condition_id": market["condition_id"],
            "question": market["question"],
            "category": market["category"],
            "market_price": round(market_prob * 100, 2),
            "swarm_probability": result["swarm_probability"],
            "swarm_median": result["swarm_median"],
            "edge_pct": round(edge_pct, 2),
            "signal": signal,
            "signal_strength": signal_strength,
            "confidence": result["confidence"],
            "sample_size": result["sample_size"],
            "sentiment": result["sentiment"],
            "scanned_at": datetime.now(timezone.utc).isoformat(),
            "volume_24h": market.get("volume_24h", 0),
            "mode": result.get("mode", "oasis"),
        }

        logger.info(f"  RESULT: Swarm={result['swarm_probability']:.1f}% vs Market={market_prob*100:.1f}%")
        logger.info(f"  EDGE: {edge_pct:+.1f}% → Signal: {signal} ({signal_strength})")
        logger.info(f"  Confidence: {result['confidence']} (n={result['sample_size']})")

        return scan_result

    except Exception as e:
        logger.error(f"  FAILED: {e}")
        return None


async def store_results(results: List[Dict]):
    """Store scan results in Supabase for the bot to consume."""
    if not Config.SUPABASE_URL or not Config.SUPABASE_KEY:
        # Save locally if no Supabase
        output_path = os.path.join(Config.OUTPUT_DIR, "latest_scan.json")
        os.makedirs(Config.OUTPUT_DIR, exist_ok=True)
        with open(output_path, "w") as f:
            json.dump(results, f, indent=2)
        logger.info(f"Saved {len(results)} results to {output_path}")
        return

    try:
        import aiohttp

        headers = {
            "apikey": Config.SUPABASE_KEY,
            "Authorization": f"Bearer {Config.SUPABASE_KEY}",
            "Content-Type": "application/json",
            "Prefer": "resolution=merge-duplicates",
        }

        async with aiohttp.ClientSession() as session:
            url = f"{Config.SUPABASE_URL}/rest/v1/mirofish_scans"

            async with session.post(url, headers=headers, json=results) as resp:
                if resp.status in (200, 201):
                    logger.info(f"Stored {len(results)} scan results in Supabase")
                else:
                    body = await resp.text()
                    logger.warning(f"Supabase store failed ({resp.status}): {body}")
                    # Fallback to local storage
                    output_path = os.path.join(Config.OUTPUT_DIR, "latest_scan.json")
                    os.makedirs(Config.OUTPUT_DIR, exist_ok=True)
                    with open(output_path, "w") as f:
                        json.dump(results, f, indent=2)

    except Exception as e:
        logger.error(f"Failed to store results: {e}")


async def run_scan_cycle():
    """Run a complete scan cycle across top active markets."""
    logger.info("=" * 70)
    logger.info("MIROFISH POLYMARKET SCANNER - Starting scan cycle")
    logger.info(f"  Agents: {Config.AGENT_COUNT} | Rounds: {Config.MAX_ROUNDS} | Markets: {Config.MAX_MARKETS_PER_SCAN}")
    logger.info("=" * 70)

    start_time = datetime.now()

    # Fetch active markets
    markets = await fetch_active_markets(Config.MAX_MARKETS_PER_SCAN)

    if not markets:
        logger.warning("No active markets found. Skipping cycle.")
        return

    # Scan each market
    results = []
    for i, market in enumerate(markets):
        logger.info(f"\n--- Market {i+1}/{len(markets)} ---")
        result = await scan_market(market)
        if result:
            results.append(result)

    # Store results
    if results:
        await store_results(results)

        # Print summary
        logger.info("\n" + "=" * 70)
        logger.info("SCAN SUMMARY")
        logger.info("=" * 70)
        for r in results:
            emoji = "🟢" if r["signal"] == "YES" else "🔴" if r["signal"] == "NO" else "⚪"
            logger.info(
                f"  {emoji} {r['question'][:50]}... | "
                f"Market: {r['market_price']:.0f}% | Swarm: {r['swarm_probability']:.0f}% | "
                f"Edge: {r['edge_pct']:+.1f}% | {r['signal']} ({r['signal_strength']})"
            )

    elapsed = (datetime.now() - start_time).total_seconds()
    logger.info(f"\nCycle completed in {elapsed:.0f}s ({elapsed/60:.1f} min)")
    logger.info(f"Next scan in {Config.SCAN_INTERVAL_MINUTES} minutes")


async def daemon_loop():
    """Run scanner continuously at configured interval."""
    logger.info("Starting MiroFish scanner in daemon mode")
    logger.info(f"Scan interval: {Config.SCAN_INTERVAL_MINUTES} minutes")

    while True:
        try:
            await run_scan_cycle()
        except Exception as e:
            logger.error(f"Scan cycle failed: {e}")

        # Wait for next cycle
        await asyncio.sleep(Config.SCAN_INTERVAL_MINUTES * 60)


def main():
    parser = argparse.ArgumentParser(description="MiroFish Polymarket Scanner")
    parser.add_argument("--daemon", action="store_true", help="Run continuously")
    parser.add_argument("--market", type=str, help="Scan a specific market question")
    parser.add_argument("--agents", type=int, default=None, help="Override agent count")
    parser.add_argument("--rounds", type=int, default=None, help="Override max rounds")
    args = parser.parse_args()

    # Override config if specified
    if args.agents:
        Config.AGENT_COUNT = args.agents
    if args.rounds:
        Config.MAX_ROUNDS = args.rounds

    # Validate config
    try:
        Config.validate()
    except ValueError as e:
        logger.error(f"Configuration error: {e}")
        sys.exit(1)

    if args.daemon:
        asyncio.run(daemon_loop())
    else:
        asyncio.run(run_scan_cycle())


if __name__ == "__main__":
    main()
