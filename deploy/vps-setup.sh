#!/usr/bin/env bash
# Turnkey TeamHub deploy for an Ubuntu/Debian VPS (e.g. a Hostinger KVM VPS).
#
# What it does: installs Docker, then runs TeamHub AND a Caddy reverse proxy
# as containers. Caddy serves the app over HTTPS on your domain, obtaining
# the certificate automatically from Let's Encrypt. Running Caddy in Docker
# avoids fragile third-party apt repositories.
#
# Run it as root, from inside the cloned repo:
#   bash deploy/vps-setup.sh
#
# Safe to re-run to deploy a new version (after `git pull`) — it reuses the
# config saved in /root/teamhub.env, so your JWT secret (and everyone's
# sessions) and your data stay intact.
#
# IMPORTANT: point your domain's DNS (an A record) at this server's IP
# BEFORE running this, or Caddy can't obtain the HTTPS certificate.
set -euo pipefail

CONFIG=/root/teamhub.env
[ -f "$CONFIG" ] && source "$CONFIG"

if [ -z "${DOMAIN:-}" ]; then read -rp "Your domain (e.g. teamhub.knapadvisory.com): " DOMAIN; fi
if [ -z "${SIGNUP_CODE:-}" ]; then read -rp "Sign-up access code for your team: " SIGNUP_CODE; fi
if [ -z "${JWT_SECRET:-}" ]; then JWT_SECRET="$(openssl rand -hex 32)"; fi

# Workspace creation can be gated by a code (defaults to your sign-up code so
# behaviour is preserved: a code is needed to start a new workspace). Optional
# TURN settings make audio/video calls work across restrictive networks.
WORKSPACE_SIGNUP_CODE="${WORKSPACE_SIGNUP_CODE:-$SIGNUP_CODE}"

umask 077
cat > "$CONFIG" <<EOF
DOMAIN="$DOMAIN"
SIGNUP_CODE="$SIGNUP_CODE"
WORKSPACE_SIGNUP_CODE="$WORKSPACE_SIGNUP_CODE"
JWT_SECRET="$JWT_SECRET"
# Optional TURN relay for calls across strict networks (fill these in to enable):
TURN_URL="${TURN_URL:-}"
TURN_USERNAME="${TURN_USERNAME:-}"
TURN_CREDENTIAL="${TURN_CREDENTIAL:-}"
EOF

# Clean up a broken Caddy apt source from earlier script versions, if present.
rm -f /etc/apt/sources.list.d/caddy-stable.list 2>/dev/null || true

echo "==> Installing Docker (if needed)..."
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi

echo "==> Opening the firewall for web traffic (if ufw is active)..."
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  ufw allow 80/tcp || true
  ufw allow 443/tcp || true
fi

echo "==> Building the TeamHub image (first build takes a few minutes)..."
docker build -t teamhub:latest .

echo "==> Setting up the container network..."
docker network create teamhub-net 2>/dev/null || true

echo "==> (Re)starting the TeamHub app container..."
docker rm -f teamhub 2>/dev/null || true
docker run -d --name teamhub --restart unless-stopped \
  --network teamhub-net \
  -e JWT_SECRET="$JWT_SECRET" \
  -e SIGNUP_CODE="$SIGNUP_CODE" \
  -e WORKSPACE_SIGNUP_CODE="$WORKSPACE_SIGNUP_CODE" \
  -e DATA_DIR=/data \
  ${TURN_URL:+-e TURN_URL="$TURN_URL"} \
  ${TURN_USERNAME:+-e TURN_USERNAME="$TURN_USERNAME"} \
  ${TURN_CREDENTIAL:+-e TURN_CREDENTIAL="$TURN_CREDENTIAL"} \
  -v teamhub-data:/data \
  teamhub:latest

echo "==> Configuring HTTPS (Caddy) for $DOMAIN..."
mkdir -p /etc/teamhub
cat > /etc/teamhub/Caddyfile <<EOF
$DOMAIN {
    reverse_proxy teamhub:3001
}
EOF

docker rm -f caddy 2>/dev/null || true
docker run -d --name caddy --restart unless-stopped \
  --network teamhub-net \
  -p 80:80 -p 443:443 \
  -v /etc/teamhub/Caddyfile:/etc/caddy/Caddyfile:ro \
  -v caddy-data:/data \
  -v caddy-config:/config \
  caddy:latest

cat <<EOF

============================================================
TeamHub is deployed.

  URL:          https://$DOMAIN
  Access code:  $SIGNUP_CODE

First load can take ~30s while Caddy fetches the HTTPS
certificate. If it doesn't load, make sure an A record for
$DOMAIN points to this server's IP, then wait a minute.

Handy commands:
  docker ps                 # see both containers running
  docker logs teamhub       # app logs
  docker logs caddy         # HTTPS / certificate logs

To deploy a new version later:
  git pull && bash deploy/vps-setup.sh
Your data (accounts, chats, tasks) lives in the "teamhub-data"
volume and is preserved across redeploys.
============================================================
EOF
