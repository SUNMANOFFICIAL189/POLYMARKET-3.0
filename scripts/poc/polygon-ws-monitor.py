#!/usr/bin/env python3
"""
Polygon WebSocket POC — validate replacing 30-90s REST polling with ~2-3s
block-time WebSocket monitoring for Polymarket trade detection.

Pre-committed success criteria (per 2026-05-08 CTDD review):
  1. Median detection latency < 5 seconds (target: 2-3s)
  2. Coverage: WS catches >= 95% of trades that REST polling catches in same window
  3. No critical decode errors (false positives)
  4. Stable connection for full duration (auto-reconnects acceptable, no crash)

Pass → proceed to Branch 2 (full WS monitor build, 1-2 days).
Fail → debug before committing build effort.

Usage:
    python3 scripts/poc/polygon-ws-monitor.py [--duration 3600]

Outputs:
    /tmp/ws-poc-results.json — structured results + verdict
    stdout — live progress

Exit codes:
    0 = POC passed all criteria
    1 = POC failed at least one criterion
    2 = POC crashed (infrastructure issue, not strategy issue)
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
import urllib.parse
import urllib.request
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

try:
    import websockets
except ImportError:
    print("ERROR: pip install websockets", file=sys.stderr)
    sys.exit(2)

import ssl


def _ssl_context() -> ssl.SSLContext:
    """SSL context that works on stock macOS Python (default cert path is broken).
    Same pattern used in the HQ watchdog (~/claude-hq/watchdog/telegram.py)."""
    try:
        import certifi  # type: ignore[import-not-found]
        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        return ssl.create_default_context()


_SSL = _ssl_context()

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

# Free public Polygon WSS endpoints (rotate on failure).
# All support eth_subscribe.
POLYGON_WSS_ENDPOINTS = [
    "wss://polygon-bor-rpc.publicnode.com",
    "wss://polygon.gateway.tenderly.co",
    "wss://polygon.drpc.org",
]

# PATH B (2026-05-08 pivot): instead of decoding Polymarket-specific exchange events
# (which turned out to involve 5+ contracts and an article-confirmed-wrong topic hash),
# watch standard ERC20 USDC Transfer events filtered by `from` = watched wallets.
# Every Polymarket trade involves a USDC outflow from the trader. Catches all trades
# without per-contract decoding complexity.
#
# Coverage caveat: also catches non-Polymarket USDC sends (e.g., wallet-to-wallet
# transfers, withdrawals). We can filter by destination address (Polymarket-related
# addresses) in a post-step, or accept the noise and reconcile against REST.

# Polygon USDC.e (bridged) — Polymarket's primary collateral token historically.
USDC_E_POLYGON = "0x2791bca1f2de4661ed88a30c99a7a9449aa84174"
# Native Polygon USDC (newer, used by some flows).
USDC_NATIVE_POLYGON = "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359"

# ERC20 Transfer(address indexed from, address indexed to, uint256 value)
# keccak256("Transfer(address,address,uint256)")
TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"

# 12 leader wallets from the convergence backtest (lowercase, normalised).
# These are the wallets we tracked in copy_trades, used by the convergence backtest
# that produced the +$168/trade geopolitics finding.
WATCHED_WALLETS = {
    "0x204f72f35326db932158cba6adff0b9a1da95e14",
    "0x2005d16a84ceefa912d4e380cd32e7ff827875ea",
    "0xee613b3fc183ee44f9da9c05f53e2da107e3debf",
    "0x2a2c53bd278c04da9962fcf96490e17f3dfb9bc1",
    "0x5d05b1f588780423488a09d9aefeb64df54d6320",
    "0x6ac5bb06a9eb05641fd5e82640268b92f3ab4b6e",
    "0x507e52ef684ca2dd91f90a9d26d149dd3288beae",
    "0x37c1874a60d348903594a96703e0507c518fc53a",
    "0x492442eab586f242b53bda933fd5de859c8a3782",
    "0xfe787d2da716d60e8acff57fb87eb13cd4d10319",
    "0x0c154c190e293b7e5f8d453b5f690c4dc9599a45",
}

DEFAULT_DURATION_SEC = 3600  # 1 hour
REST_POLL_INTERVAL_SEC = 30  # match the bot's current cadence for fair comparison
DATA_API_BASE = "https://data-api.polymarket.com"

# Latency criterion (seconds)
LATENCY_THRESHOLD_SEC = 5.0
COVERAGE_THRESHOLD_PCT = 95.0

# ---------------------------------------------------------------------------
# Shared state
# ---------------------------------------------------------------------------

# Trades caught via WebSocket. Each: {tx_hash, block, timestamp_seen, taker, maker, ...}
ws_trades: list[dict] = []
# Trades caught via REST polling. Each: {tx_hash, timestamp_leader, timestamp_seen, wallet, ...}
rest_trades: list[dict] = []
# Connection lifecycle events
connection_events: list[dict] = []
# Decode error count
decode_errors = 0


# ---------------------------------------------------------------------------
# Decoder (manual — avoids web3.py dependency)
# ---------------------------------------------------------------------------

def decode_address_from_topic(topic_hex: str) -> str:
    """Topic is 32-byte hex; address is the last 20 bytes (40 hex chars)."""
    h = topic_hex.lower().lstrip("0x").rjust(64, "0")
    return "0x" + h[-40:]


def decode_uint256(data_hex: str, offset_words: int) -> int:
    """Read a 32-byte uint256 starting at the given 32-byte word offset."""
    h = data_hex.lower().lstrip("0x")
    start = offset_words * 64
    return int(h[start:start + 64], 16)


def decode_transfer(log: dict) -> dict | None:
    """Decode an ERC20 Transfer event log."""
    global decode_errors
    try:
        topics = log.get("topics") or []
        if len(topics) < 3:
            decode_errors += 1
            return None
        data = log.get("data") or "0x"
        # topics[0] = Transfer signature
        # topics[1] = from (indexed address)
        # topics[2] = to (indexed address)
        # data = value (uint256)
        from_addr = decode_address_from_topic(topics[1])
        to_addr = decode_address_from_topic(topics[2])
        value = decode_uint256(data, 0)
        return {
            "from": from_addr,
            "to": to_addr,
            "value": value,
            "value_usdc": value / 1_000_000,  # USDC has 6 decimals
            "token": log.get("address", "").lower(),
            "block_number": int(log.get("blockNumber", "0x0"), 16),
            "tx_hash": log.get("transactionHash", "").lower(),
            "log_index": int(log.get("logIndex", "0x0"), 16),
        }
    except Exception as e:
        decode_errors += 1
        print(f"# decode error: {e}", file=sys.stderr)
        return None


def pad_address_to_topic(addr: str) -> str:
    """Convert 20-byte address to 32-byte topic format (left-padded)."""
    h = addr.lower().lstrip("0x")
    return "0x" + h.rjust(64, "0")


# ---------------------------------------------------------------------------
# WebSocket monitor
# ---------------------------------------------------------------------------

async def ws_monitor(endpoint: str, stop_at: float) -> None:
    """Subscribe to OrderFilled logs from both Polymarket exchanges and record
    any matching our watched wallets."""
    sub_id = None
    while time.time() < stop_at:
        try:
            print(f"# WS connecting to {endpoint}")
            connection_events.append({
                "ts": time.time(),
                "event": "connecting",
                "endpoint": endpoint,
            })
            async with websockets.connect(endpoint, ping_interval=20, ping_timeout=15, ssl=_SSL) as ws:
                # Subscribe to USDC Transfer events filtered by `from` = our watched wallets.
                # topic[0] = Transfer event sig
                # topic[1] = from (padded). Pass an array → OR filter (any of our wallets).
                # We watch BOTH USDC.e and native USDC for full coverage.
                wallet_topics = [pad_address_to_topic(w) for w in WATCHED_WALLETS]
                subscribe_msg = {
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "eth_subscribe",
                    "params": [
                        "logs",
                        {
                            "address": [USDC_E_POLYGON, USDC_NATIVE_POLYGON],
                            "topics": [TRANSFER_TOPIC, wallet_topics],
                        },
                    ],
                }
                await ws.send(json.dumps(subscribe_msg))
                # Wait for sub confirmation
                first = await ws.recv()
                first_resp = json.loads(first)
                if "result" not in first_resp:
                    raise RuntimeError(f"subscribe failed: {first_resp}")
                sub_id = first_resp["result"]
                print(f"# WS subscribed (id={sub_id})")
                connection_events.append({
                    "ts": time.time(),
                    "event": "subscribed",
                    "sub_id": sub_id,
                })

                while time.time() < stop_at:
                    try:
                        raw = await asyncio.wait_for(ws.recv(), timeout=30)
                    except asyncio.TimeoutError:
                        # No message in 30s → send ping ourselves, continue
                        continue
                    msg = json.loads(raw)
                    params = msg.get("params") or {}
                    log = params.get("result")
                    if not log:
                        continue
                    decoded = decode_transfer(log)
                    if not decoded:
                        continue
                    # The `topics` filter on the subscription already restricts to
                    # `from` ∈ WATCHED_WALLETS, but double-check defensively.
                    if decoded["from"] in WATCHED_WALLETS:
                        decoded["timestamp_seen"] = time.time()
                        ws_trades.append(decoded)
                        print(f"# WS HIT: {decoded['from'][:10]} → {decoded['to'][:10]} ${decoded['value_usdc']:.2f} block {decoded['block_number']} tx {decoded['tx_hash'][:10]}")
        except Exception as e:
            print(f"# WS error: {e}", file=sys.stderr)
            connection_events.append({
                "ts": time.time(),
                "event": "error",
                "error": str(e),
            })
            await asyncio.sleep(5)  # back off before reconnect


# ---------------------------------------------------------------------------
# REST polling (concurrent, for comparison baseline)
# ---------------------------------------------------------------------------

async def rest_monitor(stop_at: float) -> None:
    """Poll Polymarket data-api every 30s for each watched wallet, record
    new trades. This mimics what the bot currently does."""
    last_seen_tx: dict[str, set[str]] = defaultdict(set)
    while time.time() < stop_at:
        for wallet in WATCHED_WALLETS:
            try:
                qs = urllib.parse.urlencode({"user": wallet, "limit": 20})
                url = f"{DATA_API_BASE}/trades?{qs}"
                req = urllib.request.Request(url, headers={"User-Agent": "ws-poc/1.0"})
                with urllib.request.urlopen(req, timeout=10, context=_SSL) as resp:
                    trades = json.loads(resp.read().decode("utf-8"))
                if not isinstance(trades, list):
                    continue
                for t in trades:
                    tx = (t.get("transactionHash") or "").lower()
                    if not tx or tx in last_seen_tx[wallet]:
                        continue
                    last_seen_tx[wallet].add(tx)
                    ts_leader = int(t.get("timestamp") or 0)
                    rest_trades.append({
                        "wallet": wallet,
                        "tx_hash": tx,
                        "timestamp_leader": ts_leader,
                        "timestamp_seen": time.time(),
                        "side": (t.get("side") or "").lower(),
                        "slug": t.get("slug", ""),
                        "size": float(t.get("size") or 0),
                        "price": float(t.get("price") or 0),
                    })
                    print(f"# REST HIT: {wallet[:10]} {t.get('side')} {t.get('slug','')[:30]} tx {tx[:10]}")
            except Exception as e:
                print(f"# REST error for {wallet[:10]}: {e}", file=sys.stderr)
            await asyncio.sleep(0.2)  # gentle pacing
        await asyncio.sleep(REST_POLL_INTERVAL_SEC)


# ---------------------------------------------------------------------------
# Reconcile + verdict
# ---------------------------------------------------------------------------

def reconcile() -> dict:
    """Compare WS vs REST detection. Compute success criteria."""
    ws_tx = {t["tx_hash"] for t in ws_trades}
    rest_tx = {t["tx_hash"] for t in rest_trades}

    # Trades caught by both (the comparable set)
    in_both = ws_tx & rest_tx
    # Caught by REST but missed by WS (potential coverage gap)
    rest_only = rest_tx - ws_tx
    # Caught by WS but not REST (could be: WS faster, OR taker-not-watched-by-REST)
    ws_only = ws_tx - rest_tx

    # Latency: for trades in both, compare WS timestamp_seen to REST's leader timestamp.
    # We use leader's actual blockchain timestamp (when the leader's tx was mined)
    # as the "true entry time" — the WS detection time minus that = our latency.
    latencies: list[float] = []
    rest_by_tx = {t["tx_hash"]: t for t in rest_trades}
    ws_by_tx = {t["tx_hash"]: t for t in ws_trades}
    for tx in in_both:
        rt = rest_by_tx[tx]
        wt = ws_by_tx[tx]
        if rt["timestamp_leader"] > 0:
            latency = wt["timestamp_seen"] - rt["timestamp_leader"]
            if latency >= 0:
                latencies.append(latency)

    median_latency = sorted(latencies)[len(latencies) // 2] if latencies else None
    mean_latency = sum(latencies) / len(latencies) if latencies else None

    # Coverage: of trades REST caught, how many did WS also catch?
    if rest_tx:
        coverage_pct = 100.0 * len(in_both) / len(rest_tx)
    else:
        coverage_pct = 0.0

    return {
        "ws_trades_count": len(ws_trades),
        "rest_trades_count": len(rest_trades),
        "in_both": len(in_both),
        "rest_only": len(rest_only),
        "ws_only": len(ws_only),
        "median_latency_sec": median_latency,
        "mean_latency_sec": mean_latency,
        "coverage_pct": round(coverage_pct, 1),
        "decode_errors": decode_errors,
        "connection_events": len(connection_events),
    }


def verdict(stats: dict) -> tuple[str, list[str]]:
    """Apply pre-committed criteria. Return (pass|fail|inconclusive, [reasons])."""
    issues: list[str] = []
    if stats["ws_trades_count"] == 0 and stats["rest_trades_count"] == 0:
        return "inconclusive", ["No trades observed during run window — increase duration or pick a more active period"]
    if stats["median_latency_sec"] is None:
        issues.append("No latency samples (no overlap between WS and REST)")
    elif stats["median_latency_sec"] > LATENCY_THRESHOLD_SEC:
        issues.append(f"Median latency {stats['median_latency_sec']:.1f}s exceeds {LATENCY_THRESHOLD_SEC}s threshold")
    if stats["coverage_pct"] < COVERAGE_THRESHOLD_PCT:
        issues.append(f"Coverage {stats['coverage_pct']}% below {COVERAGE_THRESHOLD_PCT}% threshold")
    if stats["decode_errors"] > 5:
        issues.append(f"{stats['decode_errors']} decode errors — investigate event signature/decoding")
    return ("pass" if not issues else "fail", issues)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

async def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--duration", type=int, default=DEFAULT_DURATION_SEC)
    parser.add_argument("--out", type=str, default="/tmp/ws-poc-results.json")
    args = parser.parse_args(argv)

    print(f"# POC: Polygon WS monitor validation")
    print(f"# duration: {args.duration}s ({args.duration / 60:.0f} min)")
    print(f"# watched wallets: {len(WATCHED_WALLETS)}")
    print(f"# WS endpoint: {POLYGON_WSS_ENDPOINTS[0]}")
    print(f"# pre-committed criteria: median latency < {LATENCY_THRESHOLD_SEC}s, coverage >= {COVERAGE_THRESHOLD_PCT}%")
    print()

    stop_at = time.time() + args.duration
    await asyncio.gather(
        ws_monitor(POLYGON_WSS_ENDPOINTS[0], stop_at),
        rest_monitor(stop_at),
    )

    print()
    print(f"# Run complete. Reconciling…")
    stats = reconcile()
    v, issues = verdict(stats)
    out = {
        "verdict": v,
        "issues": issues,
        "stats": stats,
        "duration_sec": args.duration,
        "wallets_count": len(WATCHED_WALLETS),
        "started_at": datetime.fromtimestamp(stop_at - args.duration, tz=timezone.utc).isoformat(),
        "ended_at": datetime.now(timezone.utc).isoformat(),
        "thresholds": {
            "latency_sec": LATENCY_THRESHOLD_SEC,
            "coverage_pct": COVERAGE_THRESHOLD_PCT,
        },
    }
    Path(args.out).write_text(json.dumps(out, indent=2))

    print()
    print("=" * 60)
    print(f"VERDICT: {v.upper()}")
    if issues:
        print("Issues:")
        for i in issues:
            print(f"  - {i}")
    print()
    print(f"Stats:")
    for k, val in stats.items():
        print(f"  {k}: {val}")
    print()
    print(f"Full results: {args.out}")

    return {"pass": 0, "fail": 1, "inconclusive": 2}[v]


if __name__ == "__main__":
    try:
        sys.exit(asyncio.run(main()))
    except KeyboardInterrupt:
        print("\n# interrupted")
        sys.exit(2)
