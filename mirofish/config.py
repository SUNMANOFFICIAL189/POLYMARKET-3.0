"""
MiroFish Polymarket Scanner - Configuration
Lightweight config for running swarm simulations on Polymarket markets.
Uses Cerebras (free) as LLM backend via OpenAI-compatible API.
"""
import os
from dotenv import load_dotenv

load_dotenv()


class Config:
    # LLM Configuration (Cerebras - free tier)
    LLM_API_KEY = os.getenv("CEREBRAS_API_KEY", "")
    LLM_BASE_URL = os.getenv("CEREBRAS_BASE_URL", "https://api.cerebras.ai/v1")
    LLM_MODEL_NAME = os.getenv("CEREBRAS_MODEL", "qwen-3-235b-a22b-instruct-2507")

    # Simulation Parameters
    AGENT_COUNT = int(os.getenv("MIROFISH_AGENT_COUNT", "60"))
    MAX_ROUNDS = int(os.getenv("MIROFISH_MAX_ROUNDS", "10"))
    SCAN_INTERVAL_MINUTES = int(os.getenv("MIROFISH_SCAN_INTERVAL", "90"))
    MAX_MARKETS_PER_SCAN = int(os.getenv("MIROFISH_MAX_MARKETS", "5"))

    # Concurrency (respect Cerebras 30 RPM limit)
    SEMAPHORE_LIMIT = int(os.getenv("MIROFISH_SEMAPHORE", "10"))

    # Supabase (for storing scan results)
    SUPABASE_URL = os.getenv("SUPABASE_URL", "")
    SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_KEY", "")

    # Paths
    BASE_DIR = os.path.dirname(os.path.abspath(__file__))
    PROFILES_DIR = os.path.join(BASE_DIR, "profiles")
    OUTPUT_DIR = os.path.join(BASE_DIR, "output")

    # Polymarket API
    POLYMARKET_API_BASE = "https://clob.polymarket.com"
    POLYMARKET_GAMMA_API = "https://gamma-api.polymarket.com"

    @classmethod
    def validate(cls):
        errors = []
        if not cls.LLM_API_KEY:
            errors.append("CEREBRAS_API_KEY is required")
        if errors:
            raise ValueError(f"Config validation failed: {', '.join(errors)}")
        return True
