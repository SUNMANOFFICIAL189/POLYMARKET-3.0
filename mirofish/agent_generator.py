"""
MiroFish Polymarket Scanner - Agent Profile Generator
Generates diverse agent personas for Polymarket market simulations.
No Zep dependency - creates agents directly with LLM assistance.
"""
import json
import os
import random
import logging
from typing import List, Dict
from openai import OpenAI
from config import Config

logger = logging.getLogger("mirofish.agent_generator")

# Predefined agent archetypes for prediction market debates
AGENT_ARCHETYPES = [
    # Political/Geopolitical analysts
    {"role": "political_analyst", "bias": "data-driven", "desc": "Political science PhD who relies on polling data and historical precedent"},
    {"role": "geopolitical_strategist", "bias": "hawkish", "desc": "Former defense analyst who focuses on military and strategic implications"},
    {"role": "diplomat", "bias": "dovish", "desc": "Former State Department official who emphasizes negotiation outcomes"},

    # Financial/Market experts
    {"role": "quant_trader", "bias": "contrarian", "desc": "Quantitative trader who looks for market inefficiencies and mean reversion"},
    {"role": "macro_economist", "bias": "data-driven", "desc": "Macroeconomist who focuses on GDP, inflation, and policy impacts"},
    {"role": "crypto_degen", "bias": "bullish", "desc": "Crypto native who trades on momentum and narrative shifts"},
    {"role": "risk_manager", "bias": "cautious", "desc": "Risk management professional who calculates worst-case scenarios"},

    # Sports analysts
    {"role": "sports_statistician", "bias": "data-driven", "desc": "Sports analytics expert who uses advanced metrics and models"},
    {"role": "sports_bettor", "bias": "contrarian", "desc": "Professional sports bettor who looks for value in underdogs"},
    {"role": "sports_journalist", "bias": "neutral", "desc": "Sports journalist with insider knowledge of team dynamics"},

    # General public personas
    {"role": "reddit_power_user", "bias": "contrarian", "desc": "Active Reddit user who challenges consensus and digs into primary sources"},
    {"role": "twitter_influencer", "bias": "narrative-driven", "desc": "Twitter personality who amplifies trending narratives"},
    {"role": "skeptic", "bias": "contrarian", "desc": "Professional skeptic who questions everything and demands evidence"},
    {"role": "insider", "bias": "informed", "desc": "Claims to have inside information or industry connections"},
    {"role": "academic_researcher", "bias": "data-driven", "desc": "University researcher who cites peer-reviewed studies"},

    # Specialized
    {"role": "news_junkie", "bias": "reactive", "desc": "Monitors 50+ news sources and reacts quickly to breaking stories"},
    {"role": "conspiracy_theorist", "bias": "contrarian", "desc": "Questions official narratives and looks for hidden patterns"},
    {"role": "normie", "bias": "consensus", "desc": "Average person with common-sense intuitions about how things work"},
    {"role": "ai_model", "bias": "calibrated", "desc": "Thinks like a calibrated forecasting model, considering base rates"},
    {"role": "polymarket_whale", "bias": "informed", "desc": "Large Polymarket trader who has skin in the game on this market"},
]


def generate_agent_profiles(
    market_context: str,
    agent_count: int = 60,
    category: str = "general"
) -> List[Dict]:
    """
    Generate diverse agent profiles for a Polymarket simulation.
    Uses a mix of predefined archetypes and LLM-generated variations.
    """
    profiles = []

    # Select archetypes based on market category
    if category in ["sports", "nba", "nfl", "soccer", "mma"]:
        weight_sports = 0.4
        weight_political = 0.1
        weight_financial = 0.2
        weight_general = 0.3
    elif category in ["politics", "elections", "geopolitics"]:
        weight_sports = 0.05
        weight_political = 0.4
        weight_financial = 0.2
        weight_general = 0.35
    elif category in ["crypto", "finance", "economics"]:
        weight_sports = 0.05
        weight_political = 0.1
        weight_financial = 0.4
        weight_general = 0.45
    else:
        weight_sports = 0.1
        weight_political = 0.2
        weight_financial = 0.2
        weight_general = 0.5

    # Categorize archetypes
    sports_archetypes = [a for a in AGENT_ARCHETYPES if "sport" in a["role"]]
    political_archetypes = [a for a in AGENT_ARCHETYPES if a["role"] in ["political_analyst", "geopolitical_strategist", "diplomat"]]
    financial_archetypes = [a for a in AGENT_ARCHETYPES if a["role"] in ["quant_trader", "macro_economist", "crypto_degen", "risk_manager"]]
    general_archetypes = [a for a in AGENT_ARCHETYPES if a not in sports_archetypes + political_archetypes + financial_archetypes]

    # Build agent pool
    for i in range(agent_count):
        roll = random.random()
        if roll < weight_sports:
            archetype = random.choice(sports_archetypes)
        elif roll < weight_sports + weight_political:
            archetype = random.choice(political_archetypes)
        elif roll < weight_sports + weight_political + weight_financial:
            archetype = random.choice(financial_archetypes)
        else:
            archetype = random.choice(general_archetypes)

        # Add variation
        confidence = random.choice(["very confident", "somewhat confident", "uncertain", "skeptical"])
        verbosity = random.choice(["concise", "detailed", "moderate"])

        profile = {
            "user_id": i,
            "username": f"agent_{archetype['role']}_{i}",
            "name": f"Agent {i} ({archetype['role'].replace('_', ' ').title()})",
            "bio": archetype["desc"],
            "persona": (
                f"You are a {archetype['desc']}. "
                f"Your analytical bias tends to be {archetype['bias']}. "
                f"You are {confidence} about your predictions. "
                f"You express yourself in a {verbosity} manner. "
                f"You are participating in a prediction market debate. "
                f"Give your honest probability estimate and reasoning. "
                f"You may agree or disagree with others based on their arguments."
            ),
            "karma": random.randint(100, 50000),
            "archetype": archetype["role"],
            "bias": archetype["bias"],
        }
        profiles.append(profile)

    logger.info(f"Generated {len(profiles)} agent profiles for category '{category}'")
    return profiles


def save_profiles(profiles: List[Dict], filename: str = "agents.json") -> str:
    """Save profiles in OASIS Reddit format."""
    filepath = os.path.join(Config.PROFILES_DIR, filename)
    os.makedirs(Config.PROFILES_DIR, exist_ok=True)

    # Convert to OASIS Reddit format
    oasis_profiles = []
    for p in profiles:
        oasis_profiles.append({
            "user_id": p["user_id"],
            "username": p["username"],
            "name": p["name"],
            "bio": p["bio"],
            "persona": p["persona"],
            "karma": p["karma"],
        })

    with open(filepath, "w") as f:
        json.dump(oasis_profiles, f, indent=2)

    logger.info(f"Saved {len(profiles)} profiles to {filepath}")
    return filepath
