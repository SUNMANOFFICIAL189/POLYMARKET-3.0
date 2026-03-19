#!/bin/bash
# PATS-Copy Watchdog — autonomous health monitor
# Run this alongside the bot: ./watchdog.sh &
#
# Checks every 60s:
#   1. Is the bot process alive? If not, restart it
#   2. Is Ollama running? If not, start it
#   3. Has the bot produced output in the last 10 min? If not, restart
#   4. Are there duplicate bot instances? If so, kill extras
#   5. Log health status every 5 min

cd "$(dirname "$0")"
LOGFILE="/tmp/pats-watchdog.log"
BOTLOG="/tmp/pats-live.log"
CHECK_INTERVAL=60
STALE_THRESHOLD=600  # 10 minutes

log() {
  echo "$(date '+%Y-%m-%d %H:%M:%S') [watchdog] $1" | tee -a "$LOGFILE"
}

kill_all_bots() {
  pkill -9 -f "tsx src/index" 2>/dev/null
  rm -f .glint/browser-data/SingletonLock 2>/dev/null
  sleep 2
}

start_bot() {
  log "Starting bot..."
  nohup npx tsx src/index.ts >> "$BOTLOG" 2>&1 &
  echo $! > /tmp/pats-bot.pid
  log "Bot started (PID: $!)"
}

check_ollama() {
  if ! curl -s http://localhost:11434/api/tags > /dev/null 2>&1; then
    log "WARNING: Ollama not responding — start it manually"
    return 1
  fi
  return 0
}

check_bot_alive() {
  local count=$(pgrep -f "tsx src/index" | wc -l | tr -d ' ')
  if [ "$count" -eq 0 ]; then
    return 1  # dead
  elif [ "$count" -gt 2 ]; then
    log "WARNING: $count bot instances detected — killing all and restarting"
    kill_all_bots
    return 1
  fi
  return 0  # alive
}

check_bot_stale() {
  if [ ! -f "$BOTLOG" ]; then return 1; fi
  local last_modified=$(stat -f %m "$BOTLOG" 2>/dev/null || echo 0)
  local now=$(date +%s)
  local age=$(( now - last_modified ))
  if [ "$age" -gt "$STALE_THRESHOLD" ]; then
    log "WARNING: Bot log stale (${age}s since last write) — restarting"
    kill_all_bots
    return 1
  fi
  return 0
}

log "=== PATS-Copy Watchdog started ==="
log "Checking every ${CHECK_INTERVAL}s, stale threshold ${STALE_THRESHOLD}s"

HEALTH_COUNT=0
while true; do
  HEALTH_COUNT=$((HEALTH_COUNT + 1))

  # Check Ollama
  check_ollama

  # Check bot alive
  if ! check_bot_alive; then
    log "Bot is dead — restarting"
    start_bot
    sleep 10
    continue
  fi

  # Check bot stale
  if ! check_bot_stale; then
    start_bot
    sleep 10
    continue
  fi

  # Health summary every 5 min (5 checks)
  if [ $((HEALTH_COUNT % 5)) -eq 0 ]; then
    local_pids=$(pgrep -f "tsx src/index" | wc -l | tr -d ' ')
    local_lines=$(wc -l < "$BOTLOG" 2>/dev/null || echo 0)
    log "Health OK — bot instances: $local_pids, log lines: $local_lines"
  fi

  sleep "$CHECK_INTERVAL"
done
