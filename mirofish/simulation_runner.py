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
    Fallback: If OASIS isn't available, run a simpler multi-prompt simulation.
    Asks the LLM to role-play multiple agent perspectives sequentially.
    Less realistic but still provides swarm consensus signal.
    """
    from openai import OpenAI

    client = OpenAI(
        api_key=os.getenv("CEREBRAS_API_KEY", ""),
        base_url=os.getenv("CEREBRAS_BASE_URL", "https://api.cerebras.ai/v1"),
    )
    model = os.getenv("CEREBRAS_MODEL", "qwen-3-235b-a22b-instruct-2507")

    # Define diverse perspectives
    perspectives = [
        "a data-driven political analyst who relies on polling and historical precedent",
        "a contrarian quantitative trader looking for market inefficiencies",
        "a cautious risk manager who calculates worst-case scenarios",
        "a crypto-native trader who reads momentum and narratives",
        "an academic researcher who cites studies and base rates",
        "a professional skeptic who questions everything",
        "a news-obsessed analyst who tracks breaking developments",
        "an informed insider with industry connections",
        "a calibrated AI forecasting model thinking about base rates",
        "an average person using common sense and intuition",
    ]

    probabilities = []
    reasonings = []

    for i, perspective in enumerate(perspectives[:agent_count]):
        try:
            response = client.chat.completions.create(
                model=model,
                messages=[
                    {
                        "role": "system",
                        "content": (
                            f"You are {perspective}. You are analyzing a prediction market. "
                            f"Give your honest probability estimate for the YES outcome. "
                            f"You MUST include a specific percentage in your response. "
                            f"Format: 'My estimate: XX%' followed by brief reasoning."
                        ),
                    },
                    {
                        "role": "user",
                        "content": market_context,
                    },
                ],
                max_tokens=300,
                temperature=0.8 + (i * 0.05),  # Vary temperature for diversity
            )

            content = response.choices[0].message.content or ""
            # Extract probability
            prob_matches = re.findall(r'(\d{1,3})(?:\s*)?(?:%|percent)', content, re.IGNORECASE)
            if prob_matches:
                prob = int(prob_matches[0])
                if 0 <= prob <= 100:
                    probabilities.append(prob)
                    reasonings.append(content[:200])

            logger.info(f"  Agent {i+1}/{agent_count} ({perspective[:30]}...): {prob_matches[0] if prob_matches else '?'}%")

            # Small delay to respect rate limits
            await asyncio.sleep(2.5)  # ~24 req/min, under Cerebras 30 RPM limit

        except Exception as e:
            logger.warning(f"Agent {i} failed: {e}")
            continue

    if not probabilities:
        return {
            "swarm_probability": 50.0,
            "swarm_median": 50.0,
            "sample_size": 0,
            "total_posts": 0,
            "sentiment": {"yes_pct": 50, "no_pct": 50, "uncertain_pct": 0},
            "confidence": "none",
            "error": "No valid responses from agents",
        }

    avg_prob = sum(probabilities) / len(probabilities)
    sorted_probs = sorted(probabilities)
    median_prob = sorted_probs[len(sorted_probs) // 2]

    yes_count = sum(1 for p in probabilities if p > 55)
    no_count = sum(1 for p in probabilities if p < 45)
    uncertain_count = sum(1 for p in probabilities if 45 <= p <= 55)
    total = len(probabilities)

    return {
        "swarm_probability": round(avg_prob, 2),
        "swarm_median": round(median_prob, 2),
        "sample_size": len(probabilities),
        "total_posts": len(probabilities),
        "all_estimates": probabilities,
        "sentiment": {
            "yes_pct": round(yes_count / total * 100, 1),
            "no_pct": round(no_count / total * 100, 1),
            "uncertain_pct": round(uncertain_count / total * 100, 1),
        },
        "confidence": "high" if len(probabilities) >= 8 else "medium" if len(probabilities) >= 5 else "low",
        "mode": "fallback_llm",
    }
