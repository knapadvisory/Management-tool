#!/usr/bin/env bash
# One-time setup for pull-based auto-deploy on the VPS. Run as root:
#
#   sudo bash ~/Management-tool/deploy/install-autodeploy.sh
#
# It installs a systemd service + 1-minute timer that runs deploy/auto-pull.sh,
# which redeploys TeamHub and/or KNAP-HRMS whenever their main branch moves.
# Safe to re-run (it just rewrites the units). Override repo paths if needed:
#   TEAMHUB_DIR=/path HR_DIR=/path sudo -E bash .../install-autodeploy.sh
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Please run as root (sudo)." >&2
  exit 1
fi

# Where the repos live. Default to this script's own repo for TeamHub.
TEAMHUB_DIR="${TEAMHUB_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
HR_DIR="${HR_DIR:-$(dirname "$TEAMHUB_DIR")/KNAP-HRMS}"

# Copy the poller to a stable path so in-repo updates can't change the script
# while it's mid-run (bash reads scripts line-by-line). Re-run this installer
# after pulling a new auto-pull.sh to pick up poller changes.
INSTALLED=/usr/local/bin/teamhub-autodeploy.sh
install -m 0755 "$TEAMHUB_DIR/deploy/auto-pull.sh" "$INSTALLED"

echo "TeamHub dir: $TEAMHUB_DIR"
echo "HRMS dir:    $HR_DIR"

cat > /etc/systemd/system/teamhub-autodeploy.service <<EOF
[Unit]
Description=TeamHub/HRMS pull-based auto-deploy (checks GitHub, redeploys on change)
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=oneshot
Environment=TEAMHUB_DIR=$TEAMHUB_DIR
Environment=HR_DIR=$HR_DIR
# HOME so git/docker configs resolve as they do for interactive root.
Environment=HOME=/root
ExecStart=$INSTALLED
# One deploy can take a few minutes (Docker rebuild); don't let the timer
# stack a second run on top — the timer already guards with a fresh oneshot.
TimeoutStartSec=1200
EOF

cat > /etc/systemd/system/teamhub-autodeploy.timer <<EOF
[Unit]
Description=Run TeamHub/HRMS auto-deploy every minute

[Timer]
OnBootSec=60
OnUnitActiveSec=60
# Tight scheduling accuracy. Overlap is prevented two ways: systemd won't
# start the oneshot while it's still active, and auto-pull.sh holds a flock.
AccuracySec=10

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now teamhub-autodeploy.timer

echo
echo "Installed. The timer runs every minute. Useful commands:"
echo "  systemctl status teamhub-autodeploy.timer     # is it scheduled?"
echo "  systemctl start  teamhub-autodeploy.service   # deploy right now"
echo "  journalctl -u teamhub-autodeploy.service -f   # watch deploy logs"
echo "  systemctl disable --now teamhub-autodeploy.timer  # turn auto-deploy off"
