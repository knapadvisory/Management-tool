#!/usr/bin/env bash
# Pull-based auto-deploy: the VPS checks GitHub for new commits on main and
# redeploys ONLY the repo that changed. Runs on a 1-minute systemd timer.
#
# Why pull instead of GitHub-SSHes-in: GitHub's runners use a huge, shifting
# IP range, so any inbound-SSH firewall change breaks a push-based deploy
# (dial tcp ...:22: i/o timeout). Pulling needs no inbound port and no
# GitHub secret — the box only ever fast-forwards to origin/main, which only
# maintainers can push to, so it's safe even for a public repo.
#
# Install once with deploy/install-autodeploy.sh (which copies this to a
# stable path and enables the timer). Configure paths via the environment:
#   TEAMHUB_DIR  (default: this script's repo, or ~/Management-tool)
#   HR_DIR       (default: ~/KNAP-HRMS)
set -euo pipefail

TEAMHUB_DIR="${TEAMHUB_DIR:-$HOME/Management-tool}"
HR_DIR="${HR_DIR:-$HOME/KNAP-HRMS}"

log() { printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$1"; }

# Never let two deploys overlap (e.g. a manual run during a timer tick).
exec 9>/run/teamhub-autodeploy.lock || true
if ! flock -n 9; then
  log "another deploy is in progress — skipping this run"
  exit 0
fi

# Fast-forward $1 to origin/main and, if it actually moved, run $2 (the deploy).
# No-ops (and stays quiet) when already up to date, so the 1-min timer is cheap.
sync_repo() {
  local dir="$1" name="$2" deploy="$3"
  [ -d "$dir/.git" ] || { log "$name: $dir not a git repo — skipping"; return 0; }
  cd "$dir"

  # Fetch quietly; tolerate transient network blips without failing the run.
  if ! git fetch --quiet origin main 2>/dev/null; then
    log "$name: git fetch failed (network?) — will retry next tick"
    return 0
  fi

  local local_sha remote_sha
  local_sha="$(git rev-parse HEAD)"
  remote_sha="$(git rev-parse origin/main)"
  if [ "$local_sha" = "$remote_sha" ]; then
    return 0   # nothing new
  fi

  log "$name: new commit ${remote_sha:0:8} (was ${local_sha:0:8}) — deploying"
  git checkout -q main
  if ! git pull --ff-only --quiet; then
    log "$name: fast-forward pull failed (diverged history?) — manual fix needed"
    return 0
  fi

  if eval "$deploy"; then
    log "$name: deployed ${remote_sha:0:8} OK"
  else
    log "$name: DEPLOY FAILED for ${remote_sha:0:8} — see output above"
  fi
}

log "auto-deploy tick"
sync_repo "$TEAMHUB_DIR" "TeamHub" "bash deploy/vps-setup.sh"
sync_repo "$HR_DIR"      "KNAP-HRMS" "bash deploy/hr-setup.sh"
