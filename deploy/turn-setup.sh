#!/usr/bin/env bash
#
# Stand up a TURN relay (coturn) for TeamHub audio/video calls.
#
# TURN is what lets calls connect when both people are behind home routers,
# mobile networks, or corporate firewalls (STUN alone often fails there). Run
# this ONCE on the same VPS as TeamHub:
#
#     sudo bash deploy/turn-setup.sh
#
# It prints three values (TURN_URL / TURN_USERNAME / TURN_CREDENTIAL) to add to
# /etc/teamhub/teamhub.env (or pass to deploy/vps-setup.sh), then re-run the app
# deploy so the server hands them to clients.
#
# Re-running this script is safe: it rewrites the config and restarts coturn.
set -euo pipefail

# --- Settings (override by exporting before running) ---------------------------
TURN_DOMAIN="${TURN_DOMAIN:-teamhub.knapadvisory.com}"   # clients dial this host
TURN_USER="${TURN_USER:-teamhub}"
# A stable password: reuse an existing one if this script ran before, else make one.
CONF_DIR="/etc/teamhub/coturn"
EXISTING_PW="$( [ -f "$CONF_DIR/password" ] && cat "$CONF_DIR/password" || true )"
TURN_PASSWORD="${TURN_PASSWORD:-${EXISTING_PW:-$(openssl rand -hex 16)}}"
MIN_PORT="${MIN_PORT:-49160}"
MAX_PORT="${MAX_PORT:-49200}"

# Best-effort public IP detection (needed when the VPS sits behind 1:1 NAT).
PUBLIC_IP="${PUBLIC_IP:-$(curl -fsS https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')}"

echo "==> TURN host:      $TURN_DOMAIN"
echo "==> Public IP:      $PUBLIC_IP"
echo "==> Relay UDP ports: $MIN_PORT-$MAX_PORT"

mkdir -p "$CONF_DIR"
umask 077
printf '%s' "$TURN_PASSWORD" > "$CONF_DIR/password"

# --- coturn config -------------------------------------------------------------
cat > "$CONF_DIR/turnserver.conf" <<EOF
# Managed by deploy/turn-setup.sh — edits will be overwritten on re-run.
listening-port=3478
fingerprint
lt-cred-mech
realm=$TURN_DOMAIN
user=$TURN_USER:$TURN_PASSWORD
min-port=$MIN_PORT
max-port=$MAX_PORT
external-ip=$PUBLIC_IP
no-multicast-peers
no-cli
no-tls
no-dtls
EOF

# --- Firewall ------------------------------------------------------------------
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  echo "==> Opening TURN ports in ufw..."
  ufw allow 3478/tcp || true
  ufw allow 3478/udp || true
  ufw allow "$MIN_PORT:$MAX_PORT"/udp || true
fi

# --- Run coturn (host networking so the relay port range works cleanly) --------
if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required. Run deploy/vps-setup.sh first (it installs Docker)." >&2
  exit 1
fi

echo "==> (Re)starting coturn..."
docker rm -f coturn >/dev/null 2>&1 || true
docker run -d --name coturn --restart unless-stopped \
  --network host \
  -v "$CONF_DIR/turnserver.conf:/etc/coturn/turnserver.conf:ro" \
  coturn/coturn -c /etc/coturn/turnserver.conf

cat <<EOF

============================================================
 TURN is up. Add these to /etc/teamhub/teamhub.env, then
 re-run:  sudo bash deploy/vps-setup.sh
------------------------------------------------------------
 TURN_URL="turn:$TURN_DOMAIN:3478"
 TURN_USERNAME="$TURN_USER"
 TURN_CREDENTIAL="$TURN_PASSWORD"
============================================================

 Quick check (from any machine):
   npx -y stun-turn-tester turn:$TURN_DOMAIN:3478 $TURN_USER $TURN_PASSWORD
 or paste the same values into https://icetest.info and confirm a
 "relay" candidate appears.
EOF
