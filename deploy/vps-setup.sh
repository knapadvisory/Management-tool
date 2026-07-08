#!/usr/bin/env bash
# Turnkey TeamHub deploy for an Ubuntu/Debian VPS (e.g. a Hostinger KVM VPS).
#
# What it does: installs Docker + Caddy, builds and runs TeamHub in a
# container, and configures Caddy to serve it over HTTPS on your domain
# (certificate obtained automatically from Let's Encrypt).
#
# Run it as root, from inside the cloned repo:
#   sudo bash deploy/vps-setup.sh
#
# Safe to re-run to deploy a new version (after `git pull`) — it reuses the
# config saved in /root/teamhub.env, so your JWT secret (and everyone's
# sessions) stay intact.
#
# IMPORTANT: point your domain's DNS (an A record) at this server's IP
# BEFORE running this, or Caddy can't obtain the HTTPS certificate.
set -euo pipefail

CONFIG=/root/teamhub.env
[ -f "$CONFIG" ] && source "$CONFIG"

if [ -z "${DOMAIN:-}" ]; then read -rp "Your domain (e.g. teamhub.knapadvisory.com): " DOMAIN; fi
if [ -z "${SIGNUP_CODE:-}" ]; then read -rp "Sign-up access code for your team: " SIGNUP_CODE; fi
if [ -z "${JWT_SECRET:-}" ]; then JWT_SECRET="$(openssl rand -hex 32)"; fi

umask 077
cat > "$CONFIG" <<EOF
DOMAIN="$DOMAIN"
SIGNUP_CODE="$SIGNUP_CODE"
JWT_SECRET="$JWT_SECRET"
EOF

echo "==> Installing Docker (if needed)..."
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi

echo "==> Installing Caddy (if needed)..."
if ! command -v caddy >/dev/null 2>&1; then
  apt-get update
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl gnupg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update
  apt-get install -y caddy
fi

echo "==> Opening the firewall for web traffic (if ufw is active)..."
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  ufw allow 80/tcp || true
  ufw allow 443/tcp || true
fi

echo "==> Building the TeamHub image..."
docker build -t teamhub:latest .

echo "==> (Re)starting the TeamHub container..."
docker rm -f teamhub 2>/dev/null || true
docker run -d --name teamhub --restart unless-stopped \
  -p 127.0.0.1:3001:3001 \
  -e JWT_SECRET="$JWT_SECRET" \
  -e SIGNUP_CODE="$SIGNUP_CODE" \
  -e DATA_DIR=/data \
  -v teamhub-data:/data \
  teamhub:latest

echo "==> Configuring Caddy for HTTPS on $DOMAIN..."
cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
    reverse_proxy 127.0.0.1:3001
}
EOF
systemctl reload caddy 2>/dev/null || systemctl restart caddy

cat <<EOF

============================================================
TeamHub is deployed.

  URL:          https://$DOMAIN
  Access code:  $SIGNUP_CODE

If the page doesn't load yet, DNS may still be propagating —
give it a few minutes, then reload. Caddy fetches the HTTPS
certificate automatically once DNS points here.

To deploy a new version later:
  git pull && sudo bash deploy/vps-setup.sh
Your data (accounts, chats, tasks) lives in the Docker volume
"teamhub-data" and is preserved across redeploys.
============================================================
EOF
