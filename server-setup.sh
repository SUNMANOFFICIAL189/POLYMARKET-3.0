#!/bin/bash
# server-setup.sh — One-time cloud server provisioning for PATS-Copy
# Usage: ssh root@YOUR_SERVER_IP < server-setup.sh
#
# Prerequisites:
#   - Fresh Ubuntu 24.04 server (Hetzner CX22 recommended)
#   - SSH access as root
#
set -euo pipefail

echo "=== PATS-Copy Server Setup ==="

# 1. Update system
apt-get update && apt-get upgrade -y

# 2. Install Docker
curl -fsSL https://get.docker.com | sh
systemctl enable docker
systemctl start docker

# 3. Install Docker Compose plugin
apt-get install -y docker-compose-plugin

# 4. Create bot user
useradd -m -s /bin/bash botuser || true
usermod -aG docker botuser

# 5. Clone repo
su - botuser -c '
  cd ~
  git clone https://github.com/SUNMANOFFICIAL189/POLYMARKET-3.0.git pats-copy
  cd pats-copy
'

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Next steps:"
echo "  1. Copy your .env file to /home/botuser/pats-copy/.env"
echo "  2. cd /home/botuser/pats-copy"
echo "  3. npm ci && npm run build"
echo "  4. docker compose up -d"
echo "  5. docker logs -f pats-copy"
echo ""
echo "For Glint first-time login:"
echo "  Set GLINT_HEADLESS=false in .env, then run manually:"
echo "  docker compose run --rm bot"
echo "  Complete Google OAuth, then set GLINT_HEADLESS=true"
