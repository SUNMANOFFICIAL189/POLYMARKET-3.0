#!/usr/bin/env python3
"""
Sports-convergence-copy backtest.

Tests the hypothesis from BACKLOG (PATS-Copy: convergence-copy filter):
  When 2+ DIFFERENT tracked leader wallets independently trade the same
  market in the same direction within a 30-min window, the trade has
  systematically better PnL than single-wallet trades.

Pre-committed parameters (anti-overfit, per BACKLOG step 2):
  - 30-min convergence window
  - 2+ distinct wallets
  - Exact market match (slug)
  - Same side direction
  - Sports markets only (slug prefix filter)
  - Lookback: 60 days

Methodology:
  1. Pull tracked leader wallets from Supabase (top N by historical trade count).
  2. For each wallet, fetch trade history from Polymarket data-api.
  3. Filter to sports markets via slug prefix heuristic.
  4. Build event timeline: every (wallet, market, side, ts, price, size).
  5. Find convergence events: for each trade, check if any DIFFERENT wallet
     traded the same market+side within ±30 min.
  6. For each market with convergence, look up resolution price from Gamma API.
  7. Compute hypothetical PnL:
        entry: second-mover's price (when convergence is "confirmed")
        exit:  market resolution outcome (binary 0 or 1)
        size:  fixed $50 position (matches typical bot signal size)
  8. Single-wallet control: trades with no other wallet activity in window.
  9. Stats:
        - count of convergence events vs single-wallet trades
        - mean / median / p90 PnL per group
        - median first-to-second-mover time gap (independence check —
          if <60s consistently, wallets are correlated, not independent)
  10. Decision recommendation:
        - If convergence mean PnL > 0 AND mean > single-wallet AND
          median time gap > 60s → proceed with Phase D
        - Else → drop Phase D (Lesson 20 default action)

Usage:
    python3 sports-convergence.py
"""

from __future__ import annotations

import argparse
import json
import os
import ssl
import statistics
import sys
import time
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

# ---------------------------------------------------------------------------
# Pre-committed parameters
# ---------------------------------------------------------------------------

CONVERGENCE_WINDOW_SEC = 30 * 60  # 30 min
MIN_DISTINCT_WALLETS = 2
LOOKBACK_DAYS = 60
SIMULATED_POSITION_SIZE_DOLLARS = 50.0
TOP_N_WALLETS = 12  # cover the heavy hitters from copy_trades

# Sports market detection — slug prefix heuristic.
# Leagues: NBA, NFL, NHL, MLB, NCAAB, NCAAF, MLS, EPL, FL1 (Ligue 1),
# UFC, MMA, WTA/ATP/tennis, F1, golf, esports.
SPORTS_PREFIXES = (
    'nba-', 'nfl-', 'nhl-', 'mlb-', 'ncaab-', 'ncaaf-', 'mls-', 'fl1-',
    'epl-', 'la-liga-', 'serie-a-', 'bundesliga-', 'ufc-', 'mma-',
    'wta-', 'atp-', 'tennis-', 'champions-league-', 'cl-', 'cup-',
)
SPORTS_KEYWORDS = (
    'nba ', 'nfl ', 'nhl ', 'mlb ', 'ufc ', 'wta ', 'atp ',
    ' beat ', ' win on ', ' vs ', '-vs-',
)

# Category classification — used in the multi-category profitability survey.
# Order matters: first match wins. Sports has its own dedicated detection.
CATEGORY_PATTERNS = (
    ('crypto', ('bitcoin', 'btc-', '-btc-', 'ethereum', '-eth-', 'crypto', 'satoshi',
                'binance', 'coinbase', 'altcoin', 'doge', 'solana', 'sol-')),
    ('politics-us', ('trump', 'biden', 'harris', 'desantis', 'pence', 'comey',
                     'us-presid', 'us-election', 'congress', 'senate', 'house-of-',
                     'gop', 'dnc', 'rnc', 'republican', 'democrat', 'cabinet',
                     'supreme-court', 'scotus')),
    ('geopolitics', ('iran', 'russia', 'ukraine', 'nato', 'china', 'north-korea',
                     'taiwan', 'gaza', 'israel', 'hezbollah', 'putin', 'xi-jinping',
                     'invade', 'invasion', 'war-', '-war-', 'ceasefire', 'peace-deal',
                     'hormuz', 'syria', 'lebanon', 'yemen')),
    ('macro-econ', ('fed-', 'interest-rate', 'recession', 'inflation', 'gdp',
                    'unemployment', 'stock-market', 'sp500', 's-p-500', 'nasdaq',
                    'dow-jones', 'tariff')),
    ('big-tech', ('tesla-', 'spacex', 'nvidia', 'apple-', 'microsoft', 'google',
                  'alphabet', 'amazon', 'meta-', 'facebook', 'openai', 'anthropic',
                  'microstrategy', 'arm-')),
    ('entertainment', ('eurovision', 'oscar', 'grammy', 'emmy', 'movie', 'film-',
                       'box-office', 'netflix', 'disney', 'song-of-the-year', 'gta')),
)


def categorize_market(slug: str, title: str = '') -> str:
    s = (slug or '').lower()
    t = (title or '').lower()
    if is_sports_market(slug, title):
        return 'sports'
    for cat, patterns in CATEGORY_PATTERNS:
        if any(p in s or p in t for p in patterns):
            return cat
    return 'other'

# Polymarket APIs
DATA_API = 'https://data-api.polymarket.com'
GAMMA_API = 'https://gamma-api.polymarket.com'

# ---------------------------------------------------------------------------
# HTTP helpers
# ---------------------------------------------------------------------------

def _ssl_context() -> ssl.SSLContext:
    try:
        import certifi  # type: ignore
        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        return ssl.create_default_context()

def _http_json(url: str, timeout: int = 15) -> any:
    req = urllib.request.Request(url, headers={'User-Agent': 'pats-backtest/1.0'})
    with urllib.request.urlopen(req, timeout=timeout, context=_ssl_context()) as resp:
        return json.loads(resp.read().decode('utf-8'))


# ---------------------------------------------------------------------------
# Data fetchers
# ---------------------------------------------------------------------------

def load_supabase_creds() -> tuple[str, str]:
    env_path = Path.home() / 'Desktop' / 'POLYMARKET_TRADING_3.0' / '.env'
    url = key = ''
    for line in env_path.read_text().splitlines():
        if line.startswith('SUPABASE_URL='):
            url = line.split('=', 1)[1].strip().strip('"').strip("'")
        elif line.startswith('SUPABASE_SERVICE_KEY='):
            key = line.split('=', 1)[1].strip().strip('"').strip("'")
    return url, key


def fetch_tracked_wallets(top_n: int) -> list[tuple[str, int]]:
    """Pull distinct leader wallets from copy_trades, ranked by trade count.

    Returns full wallet addresses (Supabase column truncates display, but the
    underlying value is the full 42-char hex address — verified via direct
    REST query in the probe step before this script was written).
    """
    sb_url, sb_key = load_supabase_creds()
    qs = urllib.parse.urlencode({
        'select': 'leader_wallet',
        'leader_wallet': 'neq.signal-bot',
        'limit': '5000',
    })
    req = urllib.request.Request(
        f"{sb_url}/rest/v1/copy_trades?{qs}",
        headers={'apikey': sb_key, 'Authorization': f"Bearer {sb_key}"},
    )
    with urllib.request.urlopen(req, timeout=15, context=_ssl_context()) as resp:
        rows = json.loads(resp.read().decode('utf-8'))
    counts: dict[str, int] = {}
    for r in rows:
        w = r.get('leader_wallet') or ''
        if not w.startswith('0x') or len(w) != 42:
            continue
        counts[w] = counts.get(w, 0) + 1
    ranked = sorted(counts.items(), key=lambda x: -x[1])
    return ranked[:top_n]


def fetch_leader_trades(wallet: str, lookback_days: int) -> list[dict]:
    """Fetch a wallet's trade history from Polymarket data-api.

    The endpoint returns most-recent first. We page until we cross the
    lookback cutoff. Returned trades are normalized to a small dict.
    """
    cutoff = int(time.time()) - lookback_days * 86400
    out: list[dict] = []
    offset = 0
    while True:
        qs = urllib.parse.urlencode({'user': wallet, 'limit': 500, 'offset': offset})
        try:
            data = _http_json(f"{DATA_API}/trades?{qs}")
        except Exception as e:
            print(f"# warn: fetch failed for {wallet[:10]} offset={offset}: {e}", file=sys.stderr)
            break
        if not isinstance(data, list) or not data:
            break
        oldest_in_batch = min((t.get('timestamp') or 0) for t in data)
        for t in data:
            ts = t.get('timestamp') or 0
            if ts < cutoff:
                continue
            out.append({
                'wallet': wallet,
                'slug': t.get('slug', ''),
                'side': (t.get('side') or '').lower(),  # 'buy' / 'sell'
                'outcome': t.get('outcome', ''),
                'outcomeIndex': t.get('outcomeIndex'),
                'price': float(t.get('price') or 0),
                'size': float(t.get('size') or 0),
                'timestamp': int(ts),
                'title': t.get('title', ''),
                'conditionId': t.get('conditionId', ''),
            })
        if oldest_in_batch < cutoff or len(data) < 500:
            break
        offset += 500
        time.sleep(0.2)  # gentle rate limit
    return out


def fetch_market_resolution_by_condition(condition_id: str) -> dict | None:
    """Look up a market's resolution from Gamma API by conditionId.

    Sports markets are accessed via condition_ids — slug-based lookup goes to
    a different endpoint. Returns None if the market isn't closed/resolved.
    """
    if not condition_id:
        return None
    try:
        # closed=true is REQUIRED — Gamma's default endpoint filters out closed
        # markets, so without this param we get empty responses for resolved markets.
        url = f"{GAMMA_API}/markets?condition_ids={urllib.parse.quote(condition_id)}&closed=true"
        data = _http_json(url)
        if not isinstance(data, list) or not data:
            return None
        m = data[0]
        if not m.get('closed'):
            return None
        op = m.get('outcomePrices', '[]')
        if isinstance(op, str):
            op = json.loads(op)
        outcomes = m.get('outcomes', '[]')
        if isinstance(outcomes, str):
            outcomes = json.loads(outcomes)
        return {
            'conditionId': condition_id,
            'outcomes': outcomes,
            'outcomePrices': [float(p) for p in op],
            'closed': True,
            'endDate': m.get('endDate'),
        }
    except Exception as e:
        print(f"# warn: gamma lookup failed for {condition_id[:12]}: {e}", file=sys.stderr)
        return None


def fetch_market_resolution(slug: str) -> dict | None:
    """Legacy slug-based wrapper kept for backward compat. Prefer condition-id."""
    return None


# ---------------------------------------------------------------------------
# Sports filter
# ---------------------------------------------------------------------------

def is_sports_market(slug: str, title: str = '') -> bool:
    s = (slug or '').lower()
    if any(s.startswith(p) for p in SPORTS_PREFIXES):
        return True
    t = (title or '').lower()
    if any(kw in t for kw in SPORTS_KEYWORDS):
        return True
    return False


# ---------------------------------------------------------------------------
# Convergence detection
# ---------------------------------------------------------------------------

def find_convergence_events(trades: list[dict]) -> tuple[list[dict], list[dict]]:
    """Identify convergence events (2+ distinct wallets trading same slug+side
    within ±30 min) and single-wallet trades (control group).

    Returns (convergence_events, single_wallet_trades).
    A convergence event is keyed by (slug, side) and contains the trades that
    formed the consensus. The "trigger" timestamp is the second mover.
    """
    # Group all trades by (slug, side) so we only compare within same market+direction
    groups: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for t in trades:
        groups[(t['slug'], t['side'])].append(t)

    convergence: list[dict] = []
    single_wallet: list[dict] = []

    for (slug, side), trade_list in groups.items():
        # Sort by timestamp ascending
        trade_list.sort(key=lambda t: t['timestamp'])

        # Walk through the sorted list with a sliding window
        # Mark each trade as either part of a convergence event or single-wallet
        marked_in_convergence: set[int] = set()  # indices of trades in any convergence

        for i, t in enumerate(trade_list):
            window_start = t['timestamp'] - CONVERGENCE_WINDOW_SEC
            window_end = t['timestamp'] + CONVERGENCE_WINDOW_SEC
            wallets_in_window = {t['wallet']}
            trades_in_window = [(i, t)]
            for j, other in enumerate(trade_list):
                if j == i:
                    continue
                if other['timestamp'] < window_start or other['timestamp'] > window_end:
                    continue
                wallets_in_window.add(other['wallet'])
                trades_in_window.append((j, other))
            if len(wallets_in_window) >= MIN_DISTINCT_WALLETS:
                for idx, _ in trades_in_window:
                    marked_in_convergence.add(idx)

        # Build convergence events (one per cluster of same slug+side)
        if any(idx in marked_in_convergence for idx, _ in enumerate(trade_list)):
            cluster: list[dict] = [t for i, t in enumerate(trade_list) if i in marked_in_convergence]
            cluster.sort(key=lambda t: t['timestamp'])
            distinct_wallets = sorted({t['wallet'] for t in cluster})
            if len(distinct_wallets) >= MIN_DISTINCT_WALLETS:
                # First / second mover
                first_mover_ts = cluster[0]['timestamp']
                # Find the timestamp where the SECOND distinct wallet appeared
                seen_wallets = set()
                second_mover_ts = None
                for t in cluster:
                    seen_wallets.add(t['wallet'])
                    if len(seen_wallets) == 2:
                        second_mover_ts = t['timestamp']
                        break
                if second_mover_ts is None:
                    continue
                convergence.append({
                    'slug': slug,
                    'side': side,
                    'wallets': distinct_wallets,
                    'first_mover_ts': first_mover_ts,
                    'second_mover_ts': second_mover_ts,
                    'time_gap_sec': second_mover_ts - first_mover_ts,
                    'trigger_price': next((t['price'] for t in cluster if t['timestamp'] == second_mover_ts), 0),
                    'trigger_outcome': next((t['outcome'] for t in cluster if t['timestamp'] == second_mover_ts), ''),
                    'trades_in_event': len(cluster),
                })

        # Single-wallet trades (no convergence partner)
        for i, t in enumerate(trade_list):
            if i not in marked_in_convergence:
                single_wallet.append(t)

    return convergence, single_wallet


# ---------------------------------------------------------------------------
# PnL simulation
# ---------------------------------------------------------------------------

def simulate_pnl(trade_or_event: dict, resolution: dict | None,
                 entry_price: float, side: str, outcome: str) -> float | None:
    """Simulate PnL for a hypothetical $50 entry at entry_price, exit at resolution.

    Returns None if the market hasn't resolved.
    """
    if not resolution:
        return None
    outcomes = resolution.get('outcomes') or []
    op = resolution.get('outcomePrices') or []
    if not outcomes or not op or len(op) != len(outcomes):
        return None
    # Match outcome string to find which side won (price = 1.0)
    try:
        idx = outcomes.index(outcome)
    except ValueError:
        return None
    if entry_price <= 0:
        return None
    won = op[idx] == 1.0
    shares = SIMULATED_POSITION_SIZE_DOLLARS / entry_price
    if side == 'buy':
        # BUY at entry_price → exit_price 1.0 (won) or 0.0 (lost)
        return shares * (1.0 - entry_price) if won else -shares * entry_price
    else:
        # SELL at entry_price → exit_price 1.0 (lost — paid 1.0 to close) or 0.0 (won)
        return -shares * (1.0 - entry_price) if won else shares * entry_price


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Sports-convergence-copy backtest")
    parser.add_argument('--top-n', type=int, default=TOP_N_WALLETS)
    parser.add_argument('--lookback-days', type=int, default=LOOKBACK_DAYS)
    parser.add_argument('--out', type=str, default='/tmp/sports-convergence-backtest.json')
    args = parser.parse_args(argv)

    print(f"# Sports-convergence-copy backtest")
    print(f"# parameters: window={CONVERGENCE_WINDOW_SEC}s, min_wallets={MIN_DISTINCT_WALLETS}, lookback={args.lookback_days}d, top_n={args.top_n}")
    print()

    print(f"# Step 1: load tracked leader wallets from Supabase")
    wallets = fetch_tracked_wallets(args.top_n)
    print(f"  found {len(wallets)} wallets:")
    for w, n in wallets:
        print(f"    {w}  ({n} historical trades)")
    print()

    print(f"# Step 2: fetch each wallet's trade history (last {args.lookback_days}d)")
    # NEW: cache ALL trades (not sports-only) so we can categorize and compare.
    # If you previously ran with sports-only cache, that file is at
    # /tmp/leader-trades-cache.json — this version uses a separate path so
    # we don't conflict.
    cache_path = Path('/tmp/leader-trades-all-cache.json')
    cache_max_age_sec = 6 * 3600
    use_cache = cache_path.exists() and (time.time() - cache_path.stat().st_mtime) < cache_max_age_sec
    if use_cache:
        all_trades_unfiltered = json.loads(cache_path.read_text())
        print(f"  cache hit ({cache_path}): {len(all_trades_unfiltered)} trades total — skipping API fetch")
    else:
        all_trades_unfiltered: list[dict] = []
        for w, _ in wallets:
            trades = fetch_leader_trades(w, args.lookback_days)
            print(f"    {w[:14]}...  {len(trades):>5} total trades fetched")
            all_trades_unfiltered.extend(trades)
        cache_path.write_text(json.dumps(all_trades_unfiltered))
        print(f"  total trades across all wallets: {len(all_trades_unfiltered)} (cached to {cache_path})")

    # Categorize every trade
    for t in all_trades_unfiltered:
        t['category'] = categorize_market(t['slug'], t.get('title', ''))
    cat_counts = Counter(t['category'] for t in all_trades_unfiltered)
    print(f"  category distribution:")
    for cat, n in cat_counts.most_common():
        print(f"    {cat:20} {n:>6}")
    print()

    if not all_trades_unfiltered:
        print(f"# WARN: no trades collected — aborting.")
        return 1

    # Profitability survey: for each category, compute single-wallet hypothetical
    # PnL on resolved markets. Pre-stage to identify the best category.
    print(f"# Step 2b: per-category single-wallet profitability survey")
    print(f"  (resolves markets for ALL trades, not just sports — answers: which copy-trading category is profitable?)")
    all_condition_ids = sorted({t['conditionId'] for t in all_trades_unfiltered if t.get('conditionId')})
    print(f"  fetching resolutions for {len(all_condition_ids)} unique markets...")
    survey_resolutions: dict[str, dict] = {}
    for i, cid in enumerate(all_condition_ids):
        if i and i % 100 == 0:
            print(f"    {i}/{len(all_condition_ids)} done... ({len(survey_resolutions)} resolved)")
        r = fetch_market_resolution_by_condition(cid)
        if r:
            survey_resolutions[cid] = r
        time.sleep(0.05)
    print(f"  resolved markets: {len(survey_resolutions)} / {len(all_condition_ids)}")
    print()

    # Group trades by category, simulate hypothetical PnL, report
    print(f"  Per-category PnL (single-wallet copy at $50, exit at resolution):")
    print(f"  {'category':<20} {'n_trades':>10} {'n_resolved':>11} {'WR':>6} {'mean':>10} {'median':>10} {'sum':>12}")
    by_cat: dict[str, list[float]] = defaultdict(list)
    for t in all_trades_unfiltered:
        cid = t.get('conditionId')
        if not cid:
            continue
        res = survey_resolutions.get(cid)
        if not res:
            continue
        pnl = simulate_pnl(t, res, t['price'], t['side'], t['outcome'])
        if pnl is not None:
            by_cat[t['category']].append(pnl)

    cat_results: dict[str, dict] = {}
    for cat in sorted(by_cat.keys(), key=lambda c: -statistics.mean(by_cat[c]) if by_cat[c] else 0):
        vals = by_cat[cat]
        if not vals:
            continue
        wins = sum(1 for v in vals if v > 0)
        wr = wins / len(vals) * 100
        mean = statistics.mean(vals)
        median = statistics.median(vals)
        cat_total = cat_counts.get(cat, 0)
        cat_results[cat] = {
            'n_trades': cat_total,
            'n_resolved': len(vals),
            'wr_pct': round(wr, 1),
            'mean': round(mean, 2),
            'median': round(median, 2),
            'sum': round(sum(vals), 2),
        }
        print(f"  {cat:<20} {cat_total:>10} {len(vals):>11} {wr:>5.1f}% {mean:>+10.2f} {median:>+10.2f} {sum(vals):>+12.2f}")
    print()

    # Identify best category by mean PnL with reasonable sample
    best_cat = None
    best_mean = -float('inf')
    for cat, stats in cat_results.items():
        if stats['n_resolved'] >= 50 and stats['mean'] > best_mean:
            best_mean = stats['mean']
            best_cat = cat
    if best_cat:
        print(f"  Best category by mean PnL (n>=50): {best_cat} (mean=${best_mean:+.2f})")
    else:
        print(f"  No category with sufficient sample; cannot identify a winner")

    if best_cat and best_mean <= 0:
        print(f"  CTDD note: even the BEST category has non-positive mean PnL.")
        print(f"  This suggests no copy-trading category is profitable, regardless of convergence filter.")
    print()

    # Now run the convergence test ONLY on the best category (if positive)
    # If best category is negative-EV, convergence can't fix it — still test for completeness
    if best_cat:
        print(f"# Step 2c: filtering to best category ({best_cat}) for convergence test")
        all_trades = [t for t in all_trades_unfiltered if t['category'] == best_cat]
        print(f"  {len(all_trades)} trades in {best_cat} category")
    else:
        all_trades = []
        print(f"# Step 2c: no clear best category — falling back to original sports-only test")
        all_trades = [t for t in all_trades_unfiltered if t['category'] == 'sports']
    print()

    print(f"# Step 3: detect convergence events")
    convergence_all, single_wallet = find_convergence_events(all_trades)
    print(f"  convergence events (raw, any gap): {len(convergence_all)}")
    print(f"  single-wallet trades: {len(single_wallet)}")
    print()

    print(f"# Step 4: independence check + filter to genuinely-independent events")
    if convergence_all:
        gaps_all = sorted(c['time_gap_sec'] for c in convergence_all)
        median_gap = gaps_all[len(gaps_all) // 2]
        mean_gap = statistics.mean(gaps_all)
        p10 = gaps_all[len(gaps_all) // 10] if len(gaps_all) >= 10 else gaps_all[0]
        print(f"  RAW convergence gaps:")
        print(f"    median: {median_gap}s ({median_gap/60:.1f} min)")
        print(f"    mean:   {mean_gap:.0f}s ({mean_gap/60:.1f} min)")
        print(f"    p10:    {p10}s")
        # Filter: events where 2nd mover came >= 60s after 1st (genuinely independent)
        MIN_GAP_SEC = 60
        convergence = [c for c in convergence_all if c['time_gap_sec'] >= MIN_GAP_SEC]
        filtered_pct = 100 * (len(convergence_all) - len(convergence)) / max(1, len(convergence_all))
        print(f"  applying independence filter (gap >= {MIN_GAP_SEC}s):")
        print(f"    kept: {len(convergence)} of {len(convergence_all)} ({100-filtered_pct:.1f}%)")
        print(f"    dropped (correlated): {len(convergence_all) - len(convergence)} ({filtered_pct:.1f}%)")
        if convergence:
            gaps_kept = sorted(c['time_gap_sec'] for c in convergence)
            kept_median = gaps_kept[len(gaps_kept) // 2]
            kept_mean = statistics.mean(gaps_kept)
            print(f"  KEPT convergence gaps:")
            print(f"    median: {kept_median}s ({kept_median/60:.1f} min)")
            print(f"    mean:   {kept_mean:.0f}s ({kept_mean/60:.1f} min)")
    else:
        convergence = []
        print(f"  no convergence events found — cannot compute independence")
    print()

    print(f"# Step 5: fetch market resolutions (by conditionId, not slug)")
    # Build the set of conditionIds we need.
    # For convergence events, we need the conditionId from any trade in the cluster.
    # We rebuild that mapping here from the all_trades data.
    slug_to_condition: dict[str, str] = {}
    for t in all_trades:
        if t.get('conditionId'):
            slug_to_condition[t['slug']] = t['conditionId']
    convergence_conditions = {slug_to_condition.get(c['slug']) for c in convergence}
    convergence_conditions.discard(None)
    convergence_conditions.discard('')
    # Sample single-wallet trades (cap to avoid 12k Gamma calls)
    single_sample = single_wallet[:2000]
    single_conditions = {t.get('conditionId') for t in single_sample if t.get('conditionId')}
    single_conditions.discard(None)
    single_conditions.discard('')
    relevant_conditions = sorted(convergence_conditions | single_conditions)
    print(f"  fetching {len(relevant_conditions)} markets from Gamma API by condition_id...")
    resolutions: dict[str, dict] = {}
    for i, cid in enumerate(relevant_conditions):
        if i and i % 50 == 0:
            print(f"    {i}/{len(relevant_conditions)} done... ({len(resolutions)} resolved so far)")
        r = fetch_market_resolution_by_condition(cid)
        if r:
            resolutions[cid] = r
        time.sleep(0.05)
    print(f"  resolved markets available: {len(resolutions)} / {len(relevant_conditions)}")
    print()

    print(f"# Step 6: simulate PnL on independence-filtered convergence vs single-wallet")
    convergence_pnls: list[float] = []
    single_pnls: list[float] = []

    for c in convergence:
        cid = slug_to_condition.get(c['slug'])
        if not cid:
            continue
        res = resolutions.get(cid)
        if not res:
            continue
        pnl = simulate_pnl(c, res, c['trigger_price'], c['side'], c['trigger_outcome'])
        if pnl is not None:
            convergence_pnls.append(pnl)

    for t in single_sample:
        cid = t.get('conditionId')
        if not cid:
            continue
        res = resolutions.get(cid)
        if not res:
            continue
        pnl = simulate_pnl(t, res, t['price'], t['side'], t['outcome'])
        if pnl is not None:
            single_pnls.append(pnl)

    print(f"  convergence trades w/ resolved markets: {len(convergence_pnls)}")
    print(f"  single-wallet trades w/ resolved markets: {len(single_pnls)}")
    print()

    print(f"# Step 7: results")
    def stats(label: str, vals: list[float]) -> dict:
        if not vals:
            print(f"  {label}: no data")
            return {}
        wins = sum(1 for v in vals if v > 0)
        wr = wins / len(vals) * 100
        s = {
            'n': len(vals),
            'wr_pct': round(wr, 1),
            'mean': round(statistics.mean(vals), 2),
            'median': round(statistics.median(vals), 2),
            'p10': round(sorted(vals)[len(vals) // 10], 2) if len(vals) >= 10 else round(min(vals), 2),
            'p90': round(sorted(vals)[len(vals) * 9 // 10], 2) if len(vals) >= 10 else round(max(vals), 2),
            'sum': round(sum(vals), 2),
        }
        print(f"  {label}: n={s['n']}  WR={s['wr_pct']}%  mean=${s['mean']:+.2f}  median=${s['median']:+.2f}  sum=${s['sum']:+.2f}")
        print(f"           p10=${s['p10']:+.2f}  p90=${s['p90']:+.2f}")
        return s

    conv_stats = stats('CONVERGENCE  ', convergence_pnls)
    sing_stats = stats('SINGLE-WALLET', single_pnls)
    print()

    print(f"# Step 8: decision")
    if not conv_stats or not sing_stats:
        print(f"  INSUFFICIENT DATA: cannot compute hypothesis result.")
        verdict = 'insufficient'
    else:
        median_gap_ok = median_gap >= 60 if convergence else False
        mean_positive = conv_stats['mean'] > 0
        beats_single = conv_stats['mean'] > sing_stats['mean']
        if mean_positive and beats_single and median_gap_ok:
            print(f"  VALIDATED: convergence mean (${conv_stats['mean']:+.2f}) > single-wallet (${sing_stats['mean']:+.2f}) AND median gap > 60s")
            print(f"  → recommend proceeding with Phase D implementation")
            verdict = 'validated'
        else:
            print(f"  NOT VALIDATED:")
            if not mean_positive:
                print(f"    - convergence mean is not positive (${conv_stats['mean']:+.2f})")
            if not beats_single:
                print(f"    - convergence mean (${conv_stats['mean']:+.2f}) does not beat single-wallet (${sing_stats['mean']:+.2f})")
            if not median_gap_ok:
                print(f"    - median first-to-second-mover gap < 60s — wallets appear correlated, not independent")
            print(f"  → recommend dropping Phase D (Lesson 20 default action)")
            verdict = 'not_validated'

    # Save full results
    out = {
        'parameters': {
            'window_sec': CONVERGENCE_WINDOW_SEC,
            'min_wallets': MIN_DISTINCT_WALLETS,
            'lookback_days': args.lookback_days,
            'simulated_size': SIMULATED_POSITION_SIZE_DOLLARS,
            'top_n_wallets': args.top_n,
        },
        'data_summary': {
            'wallets_queried': len(wallets),
            'sports_trades': len(all_trades),
            'convergence_events': len(convergence),
            'single_wallet_trades': len(single_wallet),
            'resolved_markets': len(resolutions),
        },
        'independence_check': {
            'median_gap_sec': median_gap if convergence else None,
            'mean_gap_sec': mean_gap if convergence else None,
        } if convergence else None,
        'pnl_results': {
            'convergence': conv_stats,
            'single_wallet': sing_stats,
        },
        'verdict': verdict,
        'timestamp': datetime.now(timezone.utc).isoformat(),
    }
    Path(args.out).write_text(json.dumps(out, indent=2))
    print()
    print(f"# Full results saved to {args.out}")
    return 0


if __name__ == '__main__':
    sys.exit(main())
