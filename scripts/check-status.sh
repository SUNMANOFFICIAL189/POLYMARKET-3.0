#!/bin/bash
# PATS-Copy Log Analyzer (macOS compatible)
LOG="${1:-$HOME/Desktop/pats-copy.log}"

if [ ! -f "$LOG" ]; then
  echo "ERROR: Log not found at $LOG"
  echo "Start with: npm run paper 2>&1 | tee ~/Desktop/pats-copy.log"
  exit 1
fi

LINES=$(wc -l < "$LOG" | tr -d ' ')
SIZE=$(du -h "$LOG" | cut -f1)
FIRST=$(head -1 "$LOG" | grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}' | head -1)
LAST=$(tail -1 "$LOG" | grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}' | head -1)

echo "==========================================="
echo "  PATS-Copy Log Summary"
echo "==========================================="
echo "Log: $LOG ($SIZE, $LINES lines)"
echo "Period: ${FIRST:-unknown} -> ${LAST:-unknown}"
echo ""
echo "-- LEADER --"
grep 'Current leader\|Leader rotation\|became leader' "$LOG" 2>/dev/null | tail -3
echo ""
echo "-- TRADES --"
OPENED=$(grep -c 'TRADE EXECUTED' "$LOG" 2>/dev/null)
CLOSED=$(grep -c 'trade CLOSED' "$LOG" 2>/dev/null)
VETOED=$(grep -c 'vetoed\|Vetoed' "$LOG" 2>/dev/null)
STOPPED=$(grep -c 'stop-loss' "$LOG" 2>/dev/null)
echo "Copied: $OPENED | Closed: $CLOSED | Vetoed: $VETOED | Stops: $STOPPED"
grep 'TRADE EXECUTED' "$LOG" 2>/dev/null | tail -5
echo ""
echo "-- LATEST STATUS --"
grep -A 12 '=== PATS' "$LOG" 2>/dev/null | tail -13
echo ""
echo "-- ERRORS --"
ERRORS=$(grep -c '\[error\]' "$LOG" 2>/dev/null)
echo "Errors: $ERRORS"
if [ "$ERRORS" -gt 0 ] 2>/dev/null; then grep '\[error\]' "$LOG" | tail -3; fi
echo ""
echo "-- WHALES --"
grep 'Whale \[' "$LOG" 2>/dev/null | tail -3
echo "==========================================="
