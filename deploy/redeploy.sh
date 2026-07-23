#!/usr/bin/env bash
# One command to redeploy BOTH TeamHub and KNAP-HRMS from their latest main.
#
# Usage (as root, from anywhere):
#   bash ~/Management-tool/deploy/redeploy.sh
#
# It pulls each repo, rebuilds its container, and prints the result. Both
# sub-deploys are non-interactive — they reuse the config saved in
# /root/teamhub.env (and /root/teamhub-hr.env), so there are no prompts.
#
# Override the repo locations if yours differ:
#   TEAMHUB_DIR=/path/to/Management-tool HR_DIR=/path/to/KNAP-HRMS bash .../redeploy.sh
set -euo pipefail

TEAMHUB_DIR="${TEAMHUB_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
HR_DIR="${HR_DIR:-$HOME/KNAP-HRMS}"

step() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }

step "TeamHub — pulling & rebuilding"
cd "$TEAMHUB_DIR"
git pull --ff-only
bash deploy/vps-setup.sh

if [ -d "$HR_DIR/.git" ]; then
  step "KNAP-HRMS — pulling & rebuilding"
  cd "$HR_DIR"
  git checkout main
  git pull --ff-only
  bash deploy/hr-setup.sh
else
  printf '\n(KNAP-HRMS not found at %s — skipping. Set HR_DIR to its path if it lives elsewhere.)\n' "$HR_DIR"
fi

step "Running containers"
docker ps --format '  {{.Names}}\t{{.Status}}' || true

[ -f /root/teamhub.env ] && . /root/teamhub.env
printf '\n\033[1;32mDone.\033[0m  TeamHub: https://%s   ·   HR: https://hr.%s\n' "${DOMAIN:-<domain>}" "${DOMAIN:-<domain>}"
