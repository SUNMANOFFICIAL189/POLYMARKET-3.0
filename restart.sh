#!/bin/bash
# PATS-Copy — clean restart script
# Kills all stale processes before starting fresh

cd "$(dirname "$0")"

echo "Stopping PATS-Copy..."

# Kill any tsx/node processes running our bot
pkill -9 -f "tsx src/index" 2>/dev/null
pkill -9 -f "node.*index\.ts" 2>/dev/null

# Remove stale Puppeteer browser lock
rm -f .glint/browser-data/SingletonLock 2>/dev/null

# Wait for processes to die
sleep 2

# Verify clean
if pgrep -f "tsx src/index" > /dev/null 2>&1; then
  echo "WARNING: Processes still running, force killing..."
  killall -9 node 2>/dev/null
  sleep 2
fi

echo "Starting PATS-Copy..."
nohup npx tsx src/index.ts > /tmp/pats-live.log 2>&1 &
echo "PID: $!"
echo "Logs: tail -f /tmp/pats-live.log"
