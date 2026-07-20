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

# Public URL used in email links (defaults to your domain over HTTPS).
APP_URL="${APP_URL:-https://$DOMAIN}"

umask 077
cat > "$CONFIG" <<EOF
DOMAIN="$DOMAIN"
SIGNUP_CODE="$SIGNUP_CODE"
WORKSPACE_SIGNUP_CODE="$WORKSPACE_SIGNUP_CODE"
JWT_SECRET="$JWT_SECRET"
APP_URL="$APP_URL"
# TURN relay for calls across strict networks. Run deploy/turn-setup.sh to stand
# up coturn on this VPS; it prints these three values to paste in here.
TURN_URL="${TURN_URL:-}"
TURN_USERNAME="${TURN_USERNAME:-}"
TURN_CREDENTIAL="${TURN_CREDENTIAL:-}"
# Optional email (fill these in to enable password-reset + notification emails):
SMTP_HOST="${SMTP_HOST:-}"
SMTP_PORT="${SMTP_PORT:-587}"
SMTP_USER="${SMTP_USER:-}"
SMTP_PASS="${SMTP_PASS:-}"
SMTP_FROM="${SMTP_FROM:-}"
SMTP_SECURE="${SMTP_SECURE:-}"
# Optional mobile push (from your Firebase service-account JSON; enables FCM):
FCM_PROJECT_ID="${FCM_PROJECT_ID:-}"
FCM_CLIENT_EMAIL="${FCM_CLIENT_EMAIL:-}"
FCM_PRIVATE_KEY="${FCM_PRIVATE_KEY:-}"
# Easiest & most reliable: the whole Firebase service-account JSON as one base64
# blob (avoids private-key newline-escaping issues). If set, it takes precedence.
FCM_SERVICE_ACCOUNT="${FCM_SERVICE_ACCOUNT:-}"
# Browser Web Push (Chrome/Edge/Firefox). Optional — if left blank the server
# generates a VAPID key pair on first boot and persists it, so browser push
# works with no setup. Set these only to pin your own keys.
WEB_PUSH_PUBLIC_KEY="${WEB_PUSH_PUBLIC_KEY:-}"
WEB_PUSH_PRIVATE_KEY="${WEB_PUSH_PRIVATE_KEY:-}"
WEB_PUSH_SUBJECT="${WEB_PUSH_SUBJECT:-}"
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
  -e APP_URL="$APP_URL" \
  ${TURN_URL:+-e TURN_URL="$TURN_URL"} \
  ${TURN_USERNAME:+-e TURN_USERNAME="$TURN_USERNAME"} \
  ${TURN_CREDENTIAL:+-e TURN_CREDENTIAL="$TURN_CREDENTIAL"} \
  ${SMTP_HOST:+-e SMTP_HOST="$SMTP_HOST"} \
  ${SMTP_PORT:+-e SMTP_PORT="$SMTP_PORT"} \
  ${SMTP_USER:+-e SMTP_USER="$SMTP_USER"} \
  ${SMTP_PASS:+-e SMTP_PASS="$SMTP_PASS"} \
  ${SMTP_FROM:+-e SMTP_FROM="$SMTP_FROM"} \
  ${SMTP_SECURE:+-e SMTP_SECURE="$SMTP_SECURE"} \
  ${FCM_PROJECT_ID:+-e FCM_PROJECT_ID="$FCM_PROJECT_ID"} \
  ${FCM_CLIENT_EMAIL:+-e FCM_CLIENT_EMAIL="$FCM_CLIENT_EMAIL"} \
  ${FCM_PRIVATE_KEY:+-e FCM_PRIVATE_KEY="$FCM_PRIVATE_KEY"} \
  ${FCM_SERVICE_ACCOUNT:+-e FCM_SERVICE_ACCOUNT="$FCM_SERVICE_ACCOUNT"} \
  ${WEB_PUSH_PUBLIC_KEY:+-e WEB_PUSH_PUBLIC_KEY="$WEB_PUSH_PUBLIC_KEY"} \
  ${WEB_PUSH_PRIVATE_KEY:+-e WEB_PUSH_PRIVATE_KEY="$WEB_PUSH_PRIVATE_KEY"} \
  ${WEB_PUSH_SUBJECT:+-e WEB_PUSH_SUBJECT="$WEB_PUSH_SUBJECT"} \
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
