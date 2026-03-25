#!/bin/bash
# Health check script - runs every 5 minutes via cron
BOT_STATUS=$(pm2 jlist 2>/dev/null | python3 -c "import sys,json; apps=json.load(sys.stdin); bot=[a for a in apps if a[\"name\"]==\"polymarket-bot\"]; print(bot[0][\"pm2_env\"][\"status\"] if bot else \"missing\")" 2>/dev/null)
DASH_STATUS=$(pm2 jlist 2>/dev/null | python3 -c "import sys,json; apps=json.load(sys.stdin); dash=[a for a in apps if a[\"name\"]==\"polymarket-dashboard\"]; print(dash[0][\"pm2_env\"][\"status\"] if dash else \"missing\")" 2>/dev/null)
RESTARTS=$(pm2 jlist 2>/dev/null | python3 -c "import sys,json; apps=json.load(sys.stdin); bot=[a for a in apps if a[\"name\"]==\"polymarket-bot\"]; print(bot[0][\"pm2_env\"][\"restart_time\"] if bot else 0)" 2>/dev/null)

# Log status
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) bot=$BOT_STATUS dash=$DASH_STATUS restarts=$RESTARTS" >> /opt/polymarket-bot/logs/health.log

# Auto-restart if down
if [ "$BOT_STATUS" != "online" ]; then
    echo "$(date -u) BOT DOWN - restarting" >> /opt/polymarket-bot/logs/health.log
    pm2 restart polymarket-bot
fi
if [ "$DASH_STATUS" != "online" ]; then
    echo "$(date -u) DASHBOARD DOWN - restarting" >> /opt/polymarket-bot/logs/health.log
    pm2 restart polymarket-dashboard
fi
