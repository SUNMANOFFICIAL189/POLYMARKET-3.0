#!/bin/bash
# deploy.sh — Deploy latest code to cloud server
# Usage: ./deploy.sh [server-ip]
#
set -euo pipefail

SERVER=${1:-${DEPLOY_SERVER:-""}}
USER=${DEPLOY_USER:-botuser}

if [ -z "$SERVER" ]; then
  echo "Usage: ./deploy.sh <server-ip>"
  echo "   or: DEPLOY_SERVER=1.2.3.4 ./deploy.sh"
  exit 1
fi

echo "=== Deploying PATS-Copy to ${USER}@${SERVER} ==="

# 1. Build locally
echo "[1/4] Building TypeScript..."
npm run build

# 2. Push to GitHub
echo "[2/4] Pushing to GitHub..."
git push origin HEAD

# 3. Pull on server, rebuild Docker, restart
echo "[3/4] Pulling and rebuilding on server..."
ssh ${USER}@${SERVER} '
  cd ~/pats-copy
  git pull origin main
  npm ci && npm run build
  docker compose build
  docker compose up -d
  echo "Waiting 5s for startup..."
  sleep 5
'

# 4. Show health check
echo "[4/4] Health check..."
curl -s "http://${SERVER}:8080/health" | python3 -m json.tool 2>/dev/null || \
  echo "(health endpoint not yet responding — check docker logs -f pats-copy)"

echo ""
echo "=== Deploy complete ==="
echo "Dashboard: Check your Supabase dashboard for live data"
echo "Logs: ssh ${USER}@${SERVER} 'docker logs -f pats-copy'"
