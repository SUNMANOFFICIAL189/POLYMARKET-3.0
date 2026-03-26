"""
MiroFish-Bot Bridge
Exposes scan results via a simple HTTP endpoint that the Node.js bot can query.
The bot calls GET /api/swarm-score?market=<question> to get MiroFish's opinion.
"""
import json
import os
import sys
from datetime import datetime, timezone
from flask import Flask, jsonify, request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from config import Config

app = Flask(__name__)

# Cache of latest scan results (loaded from file or Supabase)
_scan_cache: dict = {}
_cache_loaded_at: str = ""


def load_scan_cache():
    """Load latest scan results from file."""
    global _scan_cache, _cache_loaded_at
    scan_file = os.path.join(Config.OUTPUT_DIR, "latest_scan.json")

    if not os.path.exists(scan_file):
        return

    try:
        with open(scan_file) as f:
            results = json.load(f)

        _scan_cache = {}
        for r in results:
            # Index by condition_id and normalized question
            _scan_cache[r.get("condition_id", "")] = r
            # Also index by lowercase question for fuzzy matching
            q = r.get("question", "").lower().strip()
            _scan_cache[q] = r

        _cache_loaded_at = datetime.now(timezone.utc).isoformat()

    except Exception as e:
        print(f"Error loading scan cache: {e}")


@app.before_request
def refresh_cache():
    """Reload cache if file has changed."""
    load_scan_cache()


@app.route("/api/swarm-score", methods=["GET"])
def get_swarm_score():
    """
    Get MiroFish swarm score for a market.
    Query params:
      - market: market question text (fuzzy matched)
      - condition_id: exact Polymarket condition ID
    Returns:
      {
        "found": true/false,
        "swarm_probability": 65.5,
        "market_price": 50.0,
        "edge_pct": 15.5,
        "signal": "YES",
        "signal_strength": "strong",
        "confidence": "high",
        "scanned_at": "2026-03-26T...",
        "stale": false
      }
    """
    condition_id = request.args.get("condition_id", "")
    market_query = request.args.get("market", "").lower().strip()

    result = None

    # Try exact condition_id match first
    if condition_id and condition_id in _scan_cache:
        result = _scan_cache[condition_id]

    # Try question match
    if not result and market_query:
        # Exact match
        if market_query in _scan_cache:
            result = _scan_cache[market_query]
        else:
            # Fuzzy match - find best overlap
            best_match = None
            best_score = 0
            for key, val in _scan_cache.items():
                if isinstance(key, str) and len(key) > 10:
                    # Simple word overlap score
                    query_words = set(market_query.split())
                    key_words = set(key.split())
                    overlap = len(query_words & key_words)
                    if overlap > best_score:
                        best_score = overlap
                        best_match = val

            if best_match and best_score >= 3:
                result = best_match

    if not result:
        return jsonify({
            "found": False,
            "message": "No scan data available for this market",
            "cache_size": len(_scan_cache) // 2,  # divide by 2 (dual-indexed)
        })

    # Check staleness (>3 hours old = stale)
    scanned_at = result.get("scanned_at", "")
    stale = False
    if scanned_at:
        try:
            scan_time = datetime.fromisoformat(scanned_at.replace("Z", "+00:00"))
            age_hours = (datetime.now(timezone.utc) - scan_time).total_seconds() / 3600
            stale = age_hours > 3
        except Exception:
            stale = True

    return jsonify({
        "found": True,
        "swarm_probability": result.get("swarm_probability"),
        "market_price": result.get("market_price"),
        "edge_pct": result.get("edge_pct"),
        "signal": result.get("signal"),
        "signal_strength": result.get("signal_strength"),
        "confidence": result.get("confidence"),
        "sample_size": result.get("sample_size"),
        "sentiment": result.get("sentiment"),
        "scanned_at": scanned_at,
        "stale": stale,
        "question": result.get("question"),
    })


@app.route("/api/swarm-scores", methods=["GET"])
def get_all_scores():
    """Return all current scan results."""
    results = []
    seen = set()
    for key, val in _scan_cache.items():
        cid = val.get("condition_id", "")
        if cid and cid not in seen:
            seen.add(cid)
            results.append(val)
    return jsonify({"results": results, "count": len(results)})


@app.route("/health", methods=["GET"])
def health():
    return jsonify({
        "status": "ok",
        "service": "mirofish-bridge",
        "cache_size": len(_scan_cache) // 2,
        "cache_loaded_at": _cache_loaded_at,
    })


if __name__ == "__main__":
    load_scan_cache()
    app.run(host="0.0.0.0", port=5050, debug=False)
