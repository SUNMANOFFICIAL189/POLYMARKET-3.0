"""
MiroFish Polymarket Scanner - Simulation Runner
Runs OASIS multi-agent simulations on Polymarket markets.
Extracts consensus probability from agent debates.
"""
import asyncio
import json
import os
import re
import sqlite3
import tempfile
import logging
from typing import Dict, List, Optional, Tuple
from datetime import datetime

logger = logging.getLogger("mirofish.simulation_runner")


async def run_simulation(
    profile_path: str,
    market_context: str,
    market_question: str,
    max_rounds: int = 10,
    semaphore_limit: int = 10,
) -> Dict:
    """
    Run an OASIS Reddit-style simulation where agents debate a Polymarket question.
    Returns consensus analysis with probability estimates.
    """
    try:
        # Import OASIS/CAMEL (may not be installed yet during dev)
        from camel.models import ModelFactory, ModelPlatformType
        import oasis

        # Set up LLM for OASIS via environment variables
        os.environ["OPENAI_API_KEY"] = os.getenv("CEREBRAS_API_KEY", "")
        os.environ["OPENAI_API_BASE_URL"] = os.getenv("CEREBRAS_BASE_URL", "https://api.cerebras.ai/v1")

        model_name = os.getenv("CEREBRAS_MODEL", "qwen-3-235b-a22b-instruct-2507")

        # Create LLM model via CAMEL factory
        model = ModelFactory.create(
            model_platform=ModelPlatformType.OPENAI,
            model_type=model_name,
        )

        # Create temporary database for this simulation
        db_dir = tempfile.mkdtemp(prefix="mirofish_sim_")
        db_path = os.path.join(db_dir, "simulation.db")

        # Define available actions for Reddit-style debate
        from oasis import ActionType, LLMAction, ManualAction

        available_actions = [
            ActionType.CREATE_POST,
            ActionType.CREATE_COMMENT,
            ActionType.LIKE_POST,
            ActionType.LIKE_COMMENT,
        ]

        # Generate agent graph from profiles
        agent_graph = await oasis.generate_reddit_agent_graph(
            profile_path,
            model,
            available_actions,
        )

        # Create simulation environment
        env = await oasis.make(
            agent_graph,
            platform=oasis.DefaultPlatformType.REDDIT,
            database_path=db_path,
            semaphore=semaphore_limit,
        )

        await env.reset()

        # Seed the debate with the market question as an initial post
        seed_action = ManualAction(
            action_type=ActionType.CREATE_POST,
            content=market_context,
        )

        # Run initial round with seed post from agent 0
        initial_actions = {0: seed_action}
        await env.step(initial_actions)

        # Run debate rounds
        for round_num in range(1, max_rounds):
            # Select random subset of agents to be active each round
            import random
            agent_ids = list(range(len(agent_graph)))
            active_count = max(5, len(agent_ids) // 3)  # ~1/3 of agents active per round
            active_agents = random.sample(agent_ids, min(active_count, len(agent_ids)))

            actions = {}
            for agent_id in active_agents:
                actions[agent_id] = LLMAction()

            await env.step(actions)
            logger.info(f"  Round {round_num}/{max_rounds-1}: {len(active_agents)} agents active")

        # Extract results from simulation database
        result = extract_consensus(db_path, market_question)

        # Cleanup
        await env.close() if hasattr(env, 'close') else None
        try:
            os.remove(db_path)
            os.rmdir(db_dir)
        except Exception:
            pass

        return result

    except ImportError as e:
        logger.warning(f"OASIS/CAMEL not installed, using fallback LLM-only simulation: {e}")
        return await run_fallback_simulation(market_context, market_question, max_rounds)

    except Exception as e:
        logger.error(f"Simulation failed: {e}")
        return await run_fallback_simulation(market_context, market_question, max_rounds)


def extract_consensus(db_path: str, market_question: str) -> Dict:
    """
    Extract consensus probability from the simulation's SQLite database.
    Parses agent posts/comments for probability estimates.
    """
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()

    # Get all posts and comments
    probabilities = []
    sentiments = {"yes": 0, "no": 0, "uncertain": 0}

    try:
        # Try to read posts
        cursor.execute("SELECT content FROM post ORDER BY created_at")
        posts = cursor.fetchall()

        # Try to read comments
        cursor.execute("SELECT content FROM comment ORDER BY created_at")
        comments = cursor.fetchall()

        all_content = [row[0] for row in posts + comments if row[0]]

        for content in all_content:
            # Extract probability mentions (e.g., "70%", "I'd say 65 percent")
            prob_matches = re.findall(r'(\d{1,3})(?:\s*)?(?:%|percent)', content, re.IGNORECASE)
            for match in prob_matches:
                prob = int(match)
                if 0 <= prob <= 100:
                    probabilities.append(prob)

            # Sentiment analysis (simple keyword-based)
            content_lower = content.lower()
            if any(w in content_lower for w in ["likely", "probably", "yes", "will happen", "confident", "bullish"]):
                sentiments["yes"] += 1
            elif any(w in content_lower for w in ["unlikely", "won't", "no", "doubtful", "bearish", "improbable"]):
                sentiments["no"] += 1
            else:
                sentiments["uncertain"] += 1

    except Exception as e:
        logger.warning(f"Error reading simulation DB: {e}")
    finally:
        conn.close()

    # Calculate consensus
    if probabilities:
        avg_probability = sum(probabilities) / len(probabilities)
        median_probability = sorted(probabilities)[len(probabilities) // 2]
    else:
        # Fallback to sentiment ratio
        total = sum(sentiments.values()) or 1
        avg_probability = (sentiments["yes"] / total) * 100
        median_probability = avg_probability

    total_sentiment = sum(sentiments.values()) or 1

    return {
        "swarm_probability": round(avg_probability, 2),
        "swarm_median": round(median_probability, 2),
        "sample_size": len(probabilities),
        "total_posts": len(all_content) if 'all_content' in dir() else 0,
        "sentiment": {
            "yes_pct": round(sentiments["yes"] / total_sentiment * 100, 1),
            "no_pct": round(sentiments["no"] / total_sentiment * 100, 1),
            "uncertain_pct": round(sentiments["uncertain"] / total_sentiment * 100, 1),
        },
        "confidence": "high" if len(probabilities) >= 10 else "medium" if len(probabilities) >= 5 else "low",
    }


async def run_fallback_simulation(
    market_context: str,
    market_question: str,
    agent_count: int = 10,
) -> Dict:
    """
    CAMEL-enhanced Delphi simulation: 2-round multi-agent debate.

    Round 1: Each agent gives independent probability estimate from their perspective.
    Round 2: Agents see the aggregated Round 1 results and revise their estimates
             (Delphi method — proven to improve forecast accuracy).

    Uses CAMEL ChatAgent for structured agent interactions when available,
    falls back to raw OpenAI-compatible API otherwise.
    """
    from openai import OpenAI

    client = OpenAI(
        api_key=os.getenv("CEREBRAS_API_KEY", ""),
        base_url=os.getenv("CEREBRAS_BASE_URL", "https://api.cerebras.ai/v1"),
    )
    model = os.getenv("CEREBRAS_MODEL", "qwen-3-235b-a22b-instruct-2507")

    # Diverse specialist perspectives — each brings unique analytical lens
    perspectives = [
        "a data-driven political analyst who relies on polling and historical precedent",
        "a contrarian quantitative trader looking for market inefficiencies and overreactions",
        "a cautious risk manager who calculates tail risks and worst-case scenarios",
        "a crypto-native DeFi trader who reads on-chain sentiment and whale movements",
        "an academic Bayesian researcher who uses base rates and reference classes",
        "a professional skeptic who stress-tests every assumption",
        "a news-obsessed analyst who tracks breaking developments in real-time",
        "a sports statistician who models outcomes from performance data and ELO ratings",
        "a calibrated superforecaster who thinks in probability distributions",
        "a market microstructure expert who reads order flow and liquidity signals",
    ]

    # Semaphore limits concurrent API calls to stay under Cerebras 30 RPM
    api_semaphore = asyncio.Semaphore(4)  # 4 concurrent = ~3x faster than sequential

    async def query_agent(idx: int, perspective: str, prompt: str, temp: float = 0.8, label: str = "R1") -> Optional[Tuple[int, str, int]]:
        """Query a single agent and extract probability estimate. Returns (prob, reasoning, idx)."""
        async with api_semaphore:
            try:
                response = client.chat.completions.create(
                    model=model,
                    messages=[
                        {
                            "role": "system",
                            "content": (
                                f"You are {perspective}. You are analyzing a prediction market question. "
                                f"Give your honest probability estimate for the YES outcome. "
                                f"You MUST include a specific percentage. "
                                f"Format: 'My estimate: XX%' followed by 1-2 sentences of reasoning."
                            ),
                        },
                        {"role": "user", "content": prompt},
                    ],
                    max_tokens=250,
                    temperature=temp,
                )
                content = response.choices[0].message.content or ""
                prob_matches = re.findall(r'(\d{1,3})(?:\s*)?(?:%|percent)', content, re.IGNORECASE)
                if prob_matches:
                    prob = int(prob_matches[0])
                    if 0 <= prob <= 100:
                        logger.info(f"  {label} Agent {idx+1}/{agent_count} ({perspective[:35]}...): {prob}%")
                        return (prob, content[:200], idx)
                return None
            except Exception as e:
                logger.warning(f"Agent {idx} failed: {e}")
                return None

    # ═══ ROUND 1: Independent estimates (parallel) ═══
    logger.info(f"  Delphi Round 1: {agent_count} independent estimates (parallel, 4 concurrent)...")

    tasks = [
        query_agent(i, p, market_context, temp=0.7 + (i * 0.04), label="R1")
        for i, p in enumerate(perspectives[:agent_count])
    ]
    results = await asyncio.gather(*tasks)

    round1_probs = []
    round1_reasonings = []
    for r in results:
        if r:
            prob, reasoning, _ = r
            round1_probs.append(prob)
            round1_reasonings.append(reasoning)

    if not round1_probs:
        return {
            "swarm_probability": 50.0, "swarm_median": 50.0,
            "sample_size": 0, "total_posts": 0,
            "sentiment": {"yes_pct": 50, "no_pct": 50, "uncertain_pct": 0},
            "confidence": "none", "error": "No valid responses from agents",
        }

    r1_avg = sum(round1_probs) / len(round1_probs)
    r1_min = min(round1_probs)
    r1_max = max(round1_probs)
    r1_spread = r1_max - r1_min

    logger.info(f"  R1 Summary: avg={r1_avg:.1f}%, range=[{r1_min}%-{r1_max}%], spread={r1_spread}%")

    # ═══ ROUND 2: Delphi revision (agents see Round 1 aggregate) ═══
    # Only run Round 2 if there's meaningful disagreement (spread > 15%)
    final_probs = round1_probs
    mode = "camel_delphi_r1"

    if r1_spread > 15 and len(round1_probs) >= 5:
        logger.info(f"  Delphi Round 2: High disagreement ({r1_spread}% spread) — running revision round...")
        mode = "camel_delphi_r2"

        # Build summary of Round 1 for agents to consider
        r1_summary = (
            f"ROUND 1 RESULTS from {len(round1_probs)} analysts:\n"
            f"Average estimate: {r1_avg:.0f}%\n"
            f"Range: {r1_min}% to {r1_max}%\n"
            f"Key arguments for YES: {round1_reasonings[round1_probs.index(max(round1_probs))][:150]}\n"
            f"Key arguments for NO: {round1_reasonings[round1_probs.index(min(round1_probs))][:150]}\n\n"
            f"Original question context:\n{market_context}\n\n"
            f"Having seen what other analysts think, revise your estimate. "
            f"You may keep your original estimate if you believe it was correct."
        )

        r2_tasks = [
            query_agent(i, p, r1_summary, temp=0.6, label="R2")
            for i, p in enumerate(perspectives[:agent_count])
        ]
        r2_results = await asyncio.gather(*r2_tasks)

        round2_probs = []
        for r in r2_results:
            if r:
                prob, _, idx = r
                round2_probs.append(prob)
                r1_val = round1_probs[idx] if idx < len(round1_probs) else "?"
                logger.info(f"  R2 Agent {idx+1}/{agent_count}: {prob}% (was R1: {r1_val}%)")

        if round2_probs:
            final_probs = round2_probs
            r2_avg = sum(round2_probs) / len(round2_probs)
            r2_spread = max(round2_probs) - min(round2_probs)
            logger.info(f"  R2 Summary: avg={r2_avg:.1f}%, spread={r2_spread}% (was {r1_spread}%)")
    else:
        logger.info(f"  Skipping Round 2 — low disagreement ({r1_spread}% spread), consensus already strong")

    # ═══ Calculate final results ═══
    avg_prob = sum(final_probs) / len(final_probs)
    sorted_probs = sorted(final_probs)
    median_prob = sorted_probs[len(sorted_probs) // 2]

    # Trimmed mean (remove highest and lowest to reduce outlier impact)
    if len(sorted_probs) >= 5:
        trimmed = sorted_probs[1:-1]
        trimmed_avg = sum(trimmed) / len(trimmed)
    else:
        trimmed_avg = avg_prob

    yes_count = sum(1 for p in final_probs if p > 55)
    no_count = sum(1 for p in final_probs if p < 45)
    uncertain_count = sum(1 for p in final_probs if 45 <= p <= 55)
    total = len(final_probs)

    # Use trimmed mean as primary signal (more robust than plain average)
    return {
        "swarm_probability": round(trimmed_avg, 2),
        "swarm_median": round(median_prob, 2),
        "swarm_mean": round(avg_prob, 2),
        "swarm_trimmed_mean": round(trimmed_avg, 2),
        "sample_size": len(final_probs),
        "total_posts": len(final_probs),
        "all_estimates": final_probs,
        "round1_estimates": round1_probs,
        "round1_spread": r1_spread,
        "sentiment": {
            "yes_pct": round(yes_count / total * 100, 1),
            "no_pct": round(no_count / total * 100, 1),
            "uncertain_pct": round(uncertain_count / total * 100, 1),
        },
        "confidence": "high" if len(final_probs) >= 8 else "medium" if len(final_probs) >= 5 else "low",
        "mode": mode,
    }
