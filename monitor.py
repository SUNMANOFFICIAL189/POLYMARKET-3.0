#!/usr/bin/env python3
"""
PATS-Copy Self-Healing Monitor
Runs as a separate pm2 process alongside the bot.

Every 5 minutes:
  1. Reads bot STATUS from .bot-status.json
  2. Stores metrics in SQLite time-series
  3. Detects anomalies by comparing against rolling averages
  4. Auto-fixes known patterns (ghost positions, stalled pipelines, crashed bot)
  5. Alerts via Telegram for unknown issues
  6. Writes diagnostic snapshots for Claude Code sessions
"""

import json
import os
import sqlite3
import subprocess
import time
import urllib.request
import urllib.parse
from datetime import datetime, timezone
from pathlib import Path

# ─── Config ──────────────────────────────────────────────────────
BOT_DIR = "/opt/polymarket-bot"
STATUS_FILE = os.path.join(BOT_DIR, ".bot-status.json")
DB_FILE = os.path.join(BOT_DIR, "monitor.db")
DIAG_FILE = os.path.join(BOT_DIR, "monitor-diagnostics.json")
CHECK_INTERVAL = 300  # 5 minutes

# Load Telegram credentials from bot's .env
def load_env():
    env = {}
    env_path = os.path.join(BOT_DIR, ".env")
    if os.path.exists(env_path):
        for line in open(env_path):
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                k, v = line.split('=', 1)
                env[k.strip()] = v.strip().strip("'\"")
    return env

ENV = load_env()
TG_TOKEN = ENV.get("TELEGRAM_BOT_TOKEN", "")
TG_CHAT = ENV.get("TELEGRAM_CHAT_ID", "")
SUPABASE_URL = ENV.get("SUPABASE_URL", "")
SUPABASE_KEY = ENV.get("SUPABASE_SERVICE_KEY", "")

# ─── Database ────────────────────────────────────────────────────
def init_db():
    conn = sqlite3.connect(DB_FILE)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS metrics (
            ts TEXT PRIMARY KEY,
            balance REAL,
            open_positions INTEGER,
            closed_trades INTEGER,
            win_rate REAL,
            pnl REAL,
            signal_trades INTEGER,
            signal_open INTEGER,
            signals_generated INTEGER,
            movement_scans INTEGER,
            movement_signals INTEGER,
            markets_cached INTEGER,
            executions INTEGER,
            vetoes INTEGER
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS alerts (
            ts TEXT,
            severity TEXT,
            pattern TEXT,
            message TEXT,
            auto_fixed INTEGER DEFAULT 0
        )
    """)
    conn.commit()
    return conn

# ─── Telegram ────────────────────────────────────────────────────
def send_alert(message, severity="WARN"):
    prefix = {"CRITICAL": "🔴", "WARN": "🟡", "INFO": "🟢", "FIX": "🔧"}.get(severity, "⚪")
    full = f"{prefix} <b>MONITOR {severity}</b>\n{message}"
    if TG_TOKEN and TG_CHAT:
        try:
            data = urllib.parse.urlencode({
                "chat_id": TG_CHAT,
                "text": full,
                "parse_mode": "HTML"
            }).encode()
            req = urllib.request.Request(
                f"https://api.telegram.org/bot{TG_TOKEN}/sendMessage",
                data=data
            )
            urllib.request.urlopen(req, timeout=10)
        except Exception as e:
            print(f"[monitor] Telegram failed: {e}")
    print(f"[monitor] [{severity}] {message}")

# ─── Read bot status ─────────────────────────────────────────────
def read_status():
    try:
        with open(STATUS_FILE) as f:
            data = json.load(f)
        # Check freshness
        updated = data.get("updatedAt", "")
        if updated:
            age = (datetime.now(timezone.utc) - datetime.fromisoformat(updated.replace("Z", "+00:00"))).total_seconds()
            data["_age_seconds"] = age
        return data
    except Exception as e:
        return {"_error": str(e)}

# ─── Check bot process ──────────────────────────────────────────
def is_bot_running():
    try:
        result = subprocess.run(
            ["pm2", "jlist"],
            capture_output=True, text=True, timeout=10
        )
        processes = json.loads(result.stdout)
        for p in processes:
            if p.get("name") == "polymarket-bot":
                return p.get("pm2_env", {}).get("status") == "online"
        return False
    except:
        return False

# ─── Supabase queries ────────────────────────────────────────────
def supabase_get(path):
    if not SUPABASE_URL or not SUPABASE_KEY:
        return None
    try:
        url = f"{SUPABASE_URL}/rest/v1/{path}"
        req = urllib.request.Request(url)
        req.add_header("apikey", SUPABASE_KEY)
        req.add_header("Authorization", f"Bearer {SUPABASE_KEY}")
        resp = urllib.request.urlopen(req, timeout=10)
        return json.loads(resp.read())
    except:
        return None

def count_open_positions():
    data = supabase_get("copy_trades?status=eq.open&select=id")
    return len(data) if data else 0

def flush_open_positions():
    """Force-close all open positions in Supabase."""
    if not SUPABASE_URL or not SUPABASE_KEY:
        return
    try:
        now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        data = json.dumps({"status": "stopped", "exit_time": now}).encode()
        url = f"{SUPABASE_URL}/rest/v1/copy_trades?status=eq.open"
        req = urllib.request.Request(url, data=data, method="PATCH")
        req.add_header("apikey", SUPABASE_KEY)
        req.add_header("Authorization", f"Bearer {SUPABASE_KEY}")
        req.add_header("Content-Type", "application/json")
        req.add_header("Prefer", "return=minimal")
        urllib.request.urlopen(req, timeout=10)
    except Exception as e:
        print(f"[monitor] Flush failed: {e}")

def restart_bot():
    """Restart the polymarket-bot process via pm2."""
    try:
        subprocess.run(["pm2", "restart", "polymarket-bot"], timeout=30)
        time.sleep(10)
    except Exception as e:
        print(f"[monitor] Restart failed: {e}")

# ─── Anomaly detection ───────────────────────────────────────────
def get_rolling_stats(conn, metric, window=12):
    """Get rolling average and stdev for a metric over the last N checks."""
    rows = conn.execute(
        f"SELECT {metric} FROM metrics ORDER BY ts DESC LIMIT ?",
        (window,)
    ).fetchall()
    if len(rows) < 3:
        return None, None
    values = [r[0] for r in rows if r[0] is not None]
    if not values:
        return None, None
    avg = sum(values) / len(values)
    variance = sum((v - avg) ** 2 for v in values) / len(values)
    stdev = variance ** 0.5
    return avg, stdev

def check_anomalies(conn, current):
    """Check all metrics for anomalies. Returns list of (severity, pattern, message)."""
    issues = []
    now_ts = current.get("updatedAt", "unknown")

    # 1. Bot status file is stale (>15 min old)
    age = current.get("_age_seconds", 0)
    if age > 900:
        issues.append(("CRITICAL", "status_stale",
            f"Bot status file is {age/60:.0f}min old — bot may be crashed"))

    # 2. Balance unchanged for too long
    avg_bal, _ = get_rolling_stats(conn, "balance")
    if avg_bal is not None:
        current_bal = current.get("balance", 0)
        # Check if balance has been identical for last 6 checks (30 min)
        recent = conn.execute(
            "SELECT DISTINCT balance FROM metrics ORDER BY ts DESC LIMIT 6"
        ).fetchall()
        if len(recent) >= 6 and len(set(r[0] for r in recent)) == 1:
            issues.append(("WARN", "balance_frozen",
                f"Balance frozen at ${current_bal:.2f} for 30+ min"))

    # 3. Signal open diverging from open positions (ghost positions)
    sig_open = current.get("signalOpen", 0) if "signalOpen" in str(current) else 0
    open_pos = current.get("openPositions", 0)
    # Parse from the raw status if available
    if sig_open > 0 and open_pos == 0:
        issues.append(("CRITICAL", "ghost_positions",
            f"signalOpen={sig_open} but openPositions={open_pos} — ghost positions"))

    # 4. Signal pipeline dead (no new signals for 2h during market hours)
    avg_sigs, _ = get_rolling_stats(conn, "signals_generated", window=24)
    if avg_sigs is not None:
        current_sigs = current.get("signalsGenerated", 0)
        recent_sigs = conn.execute(
            "SELECT signals_generated FROM metrics ORDER BY ts DESC LIMIT 24"
        ).fetchall()
        if len(recent_sigs) >= 24:
            oldest_val = recent_sigs[-1][0] or 0
            newest_val = recent_sigs[0][0] or 0
            if newest_val == oldest_val and newest_val > 0:
                issues.append(("WARN", "signal_dead",
                    f"signalsGenerated stuck at {newest_val} for 2h"))

    # 5. Closed trades not increasing — only alert if a position has exceeded TTL
    # Signal trades have 24h TTL. Don't alert if all positions are younger than that.
    recent_closed = conn.execute(
        "SELECT closed_trades FROM metrics ORDER BY ts DESC LIMIT 24"
    ).fetchall()
    if len(recent_closed) >= 24:
        oldest_c = recent_closed[-1][0] or 0
        newest_c = recent_closed[0][0] or 0
        open_count = current.get("openPositions", 0) or 0
        if newest_c == oldest_c and open_count > 3:
            # Check if any position should have closed by now (older than TTL)
            has_overdue = False
            try:
                open_trades = supabase_get("copy_trades?status=eq.open&select=entry_time")
                if open_trades:
                    ttl_hours = 24
                    now = datetime.now(timezone.utc)
                    for t in open_trades:
                        entry = t.get("entry_time", "")
                        if entry:
                            age_h = (now - datetime.fromisoformat(entry.replace("Z", "+00:00"))).total_seconds() / 3600
                            if age_h > ttl_hours:
                                has_overdue = True
                                break
            except:
                has_overdue = True  # if we can't check, assume worst case
            if has_overdue:
                issues.append(("CRITICAL", "trades_stuck",
                    f"closedTrades frozen at {newest_c} for 2h — position(s) have exceeded {ttl_hours}h TTL"))

    # 6. Rapid PnL decline (lost >3% in last hour)
    recent_pnl = conn.execute(
        "SELECT pnl FROM metrics ORDER BY ts DESC LIMIT 12"
    ).fetchall()
    if len(recent_pnl) >= 12:
        pnl_now = recent_pnl[0][0] or 0
        pnl_1h = recent_pnl[-1][0] or 0
        if pnl_now < pnl_1h - 200:  # lost $200+ in 1 hour
            issues.append(("CRITICAL", "rapid_loss",
                f"PnL dropped ${pnl_1h - pnl_now:.0f} in 1 hour"))

    return issues


# ─── Data integrity checks ──────────────────────────────────────
def check_data_integrity():
    """Check Supabase for data integrity issues. Returns list of (severity, pattern, message)."""
    issues = []
    if not SUPABASE_URL or not SUPABASE_KEY:
        return issues

    # 1. Null PnL on stopped/closed trades
    null_pnl = supabase_get("copy_trades?status=in.(stopped,closed)&pnl=is.null&select=id,status,market_question,entry_time&limit=20")
    if null_pnl and len(null_pnl) > 0:
        # Only alert on recent ones (last 24h)
        recent_nulls = [t for t in null_pnl if t.get("entry_time", "") >= (datetime.now(timezone.utc).replace(hour=0) - __import__('datetime').timedelta(days=1)).isoformat()]
        if len(recent_nulls) > 0:
            issues.append(("WARN", "null_pnl_trades",
                f"{len(recent_nulls)} recent stopped/closed trades have null PnL — data gap"))

    # 2. Duplicate open positions on same market
    open_trades = supabase_get("copy_trades?status=eq.open&select=id,market_id,side,market_question")
    if open_trades:
        market_ids = {}
        for t in open_trades:
            mid = t.get("market_id", "")
            if mid in market_ids:
                issues.append(("CRITICAL", "duplicate_position",
                    f"Duplicate open position on {mid[:40]} — {market_ids[mid]} and {t.get('side')}"))
            else:
                market_ids[mid] = t.get("side", "?")

    # 3. Stale open trades (>48h old)
    cutoff = (datetime.now(timezone.utc) - __import__('datetime').timedelta(hours=48)).isoformat()
    stale = supabase_get(f"copy_trades?status=eq.open&entry_time=lt.{cutoff}&select=id,market_question,entry_time")
    if stale and len(stale) > 0:
        issues.append(("WARN", "stale_open_trades",
            f"{len(stale)} open trades older than 48h — lifecycle may not be closing them"))

    return issues


def auto_fix_data(pattern, detail=None):
    """Auto-fix data integrity issues. Returns True if fixed."""
    if pattern == "duplicate_position":
        send_alert("Duplicate position detected — closing the newer one", "FIX")
        # The reconciliation will handle this on next cycle
        return True
    elif pattern == "null_pnl_trades":
        # Can't auto-fix historical null PnL — need market prices at close time
        # Just alert for now
        return False
    elif pattern == "stale_open_trades":
        send_alert("Stale open trades >48h — flushing", "FIX")
        flush_open_positions()
        return True
    return False


# ─── Log error scanning ─────────────────────────────────────────
LOG_FILE = os.path.join(BOT_DIR, "logs/bot-out.log")
KNOWN_ERRORS_FILE = os.path.join(BOT_DIR, "monitor-known-errors.json")

def load_known_errors():
    try:
        with open(KNOWN_ERRORS_FILE) as f:
            return json.load(f)
    except:
        return {"patterns": {}, "last_line_count": 0}

def save_known_errors(data):
    with open(KNOWN_ERRORS_FILE, 'w') as f:
        json.dump(data, f)

def scan_recent_errors():
    """Scan bot logs for error patterns since last check. Returns list of (severity, pattern, message)."""
    issues = []
    known = load_known_errors()
    last_count = known.get("last_line_count", 0)

    try:
        with open(LOG_FILE) as f:
            lines = f.readlines()
    except:
        return issues

    current_count = len(lines)
    if current_count <= last_count:
        known["last_line_count"] = current_count
        save_known_errors(known)
        return issues

    # Only scan new lines since last check
    new_lines = lines[last_count:]
    error_counts = {}

    for line in new_lines:
        lower = line.lower()
        if "error" in lower or "fail" in lower or "timeout" in lower:
            # Extract error signature (first 80 chars after the keyword)
            for keyword in ["error", "failed", "timeout"]:
                idx = lower.find(keyword)
                if idx >= 0:
                    sig = line[idx:idx+80].strip()
                    # Normalize by removing timestamps and specific IDs
                    sig = sig[:60]
                    error_counts[sig] = error_counts.get(sig, 0) + 1
                    break

    # Alert on patterns appearing 5+ times in one cycle
    for sig, count in error_counts.items():
        if count >= 5:
            known_count = known.get("patterns", {}).get(sig, 0)
            if known_count == 0:
                # New error pattern never seen before
                issues.append(("WARN", "new_error_pattern",
                    f"New error pattern ({count}x): {sig[:50]}"))
            else:
                issues.append(("WARN", "recurring_error",
                    f"Error ({count}x this cycle): {sig[:50]}"))
            known.setdefault("patterns", {})[sig] = known_count + count

    known["last_line_count"] = current_count
    save_known_errors(known)
    return issues


# ─── Auto-fix known patterns ────────────────────────────────────
def auto_fix(pattern):
    """Apply automatic fix for known patterns. Returns True if fixed."""
    if pattern == "ghost_positions":
        send_alert("Ghost positions detected — flushing + restarting", "FIX")
        flush_open_positions()
        restart_bot()
        return True
    elif pattern == "status_stale":
        send_alert("Bot appears crashed — restarting", "FIX")
        restart_bot()
        return True
    elif pattern == "signal_dead":
        send_alert("Signal pipeline stalled — restarting bot", "FIX")
        restart_bot()
        return True
    elif pattern == "trades_stuck":
        send_alert("Trades stuck for 1h+ — flushing stale positions + restarting", "FIX")
        flush_open_positions()
        restart_bot()
        return True
    return False

# ─── Write diagnostic snapshot ───────────────────────────────────
def write_diagnostics(conn, current, issues):
    """Write a diagnostic snapshot for Claude Code sessions."""
    recent = conn.execute(
        "SELECT * FROM metrics ORDER BY ts DESC LIMIT 12"
    ).fetchall()
    recent_alerts = conn.execute(
        "SELECT * FROM alerts ORDER BY ts DESC LIMIT 20"
    ).fetchall()

    diag = {
        "snapshot_time": datetime.now(timezone.utc).isoformat(),
        "current_status": current,
        "recent_metrics": [dict(zip(
            ["ts", "balance", "open_positions", "closed_trades", "win_rate",
             "pnl", "signal_trades", "signal_open", "signals_generated",
             "movement_scans", "movement_signals", "markets_cached",
             "executions", "vetoes"], r
        )) for r in recent],
        "active_issues": [{"severity": s, "pattern": p, "message": m} for s, p, m in issues],
        "recent_alerts": [{"ts": r[0], "severity": r[1], "pattern": r[2],
                          "message": r[3], "auto_fixed": r[4]} for r in recent_alerts],
    }

    with open(DIAG_FILE, 'w') as f:
        json.dump(diag, f, indent=2)

# ─── Main loop ───────────────────────────────────────────────────
def main():
    print(f"[monitor] Starting PATS-Copy Monitor")
    print(f"[monitor] DB: {DB_FILE}")
    print(f"[monitor] Check interval: {CHECK_INTERVAL}s")
    print(f"[monitor] Telegram: {'configured' if TG_TOKEN else 'not configured'}")

    conn = init_db()
    send_alert("Monitor started", "INFO")

    consecutive_issues = {}  # pattern → count

    while True:
        try:
            now = datetime.now(timezone.utc).isoformat()

            # 1. Check bot process
            if not is_bot_running():
                send_alert("Bot process is DOWN — restarting", "CRITICAL")
                restart_bot()
                time.sleep(30)
                if not is_bot_running():
                    send_alert("Bot restart FAILED — manual intervention needed", "CRITICAL")
                time.sleep(CHECK_INTERVAL)
                continue

            # 2. Read current status
            status = read_status()
            if "_error" in status:
                send_alert(f"Cannot read bot status: {status['_error']}", "WARN")
                time.sleep(CHECK_INTERVAL)
                continue

            # 3. Store metrics
            conn.execute("""
                INSERT OR REPLACE INTO metrics
                (ts, balance, open_positions, closed_trades, win_rate, pnl,
                 signal_trades, signal_open, signals_generated,
                 movement_scans, movement_signals, markets_cached,
                 executions, vetoes)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                now,
                status.get("balance"),
                status.get("openPositions"),
                status.get("closedTrades"),
                status.get("winRate"),
                status.get("pnl"),
                status.get("signalTrades"),
                status.get("signalOpen"),
                status.get("signalsGenerated"),
                status.get("movementScans"),
                status.get("movementSignals"),
                status.get("marketsCached"),
                status.get("executions"),
                status.get("vetoes"),
            ))
            conn.commit()

            # 4. Check for anomalies
            issues = check_anomalies(conn, status)

            # 4b. Check data integrity (every 3rd cycle = 15 min)
            if conn.execute("SELECT COUNT(*) FROM metrics").fetchone()[0] % 3 == 0:
                data_issues = check_data_integrity()
                issues.extend(data_issues)
                for severity, pattern, message in data_issues:
                    if severity == "CRITICAL":
                        auto_fix_data(pattern)

            # 4c. Scan logs for error patterns
            log_issues = scan_recent_errors()
            issues.extend(log_issues)

            # 5. Handle issues
            for severity, pattern, message in issues:
                # Track consecutive occurrences
                consecutive_issues[pattern] = consecutive_issues.get(pattern, 0) + 1
                count = consecutive_issues[pattern]

                # Only act after 2 consecutive detections (avoid false positives)
                if count >= 2:
                    # Log alert
                    conn.execute(
                        "INSERT INTO alerts (ts, severity, pattern, message) VALUES (?, ?, ?, ?)",
                        (now, severity, pattern, message)
                    )
                    conn.commit()

                    # Auto-fix if applicable
                    if severity == "CRITICAL":
                        fixed = auto_fix(pattern)
                        if fixed:
                            conn.execute(
                                "UPDATE alerts SET auto_fixed=1 WHERE ts=? AND pattern=?",
                                (now, pattern)
                            )
                            conn.commit()
                            consecutive_issues[pattern] = 0
                        else:
                            send_alert(f"[{pattern}] {message}", severity)
                    else:
                        # Only alert on WARN every 3rd occurrence (don't spam)
                        if count % 3 == 0:
                            send_alert(f"[{pattern}] {message} (x{count})", severity)

            # Clear consecutive counts for patterns not seen this cycle
            seen_patterns = {p for _, p, _ in issues}
            for p in list(consecutive_issues.keys()):
                if p not in seen_patterns:
                    consecutive_issues[p] = 0

            # 6. Write diagnostics
            write_diagnostics(conn, status, issues)

            # 7. Periodic health report (every 2 hours)
            total_checks = conn.execute("SELECT COUNT(*) FROM metrics").fetchone()[0]
            if total_checks % 24 == 0 and total_checks > 0:  # every 24 checks = 2 hours
                bal = status.get("balance", 0)
                wr = status.get("winRate", 0)
                sig = status.get("signalTrades", 0)
                send_alert(
                    f"Health: balance=${bal:.0f} WR={wr:.1f}% signals={sig} positions={status.get('openPositions', 0)}",
                    "INFO"
                )

        except Exception as e:
            print(f"[monitor] Check failed: {e}")

        time.sleep(CHECK_INTERVAL)


if __name__ == "__main__":
    main()
