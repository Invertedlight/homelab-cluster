#!/bin/bash
# Homebrew on Linux for the DevPod, kept on the home PVC.
# /home/linuxbrew is a subPath mount of the "home" volume (.linuxbrew-root),
# so brew survives pod restarts. Runs as root from the workspace container
# on every start: fixes ownership, and only if brew is missing (brand-new
# home volume) runs the official installer as vscode (the installer refuses
# root). Idempotent; never exits non-zero. Log: ~/.devpod-brew.log
set -uo pipefail
DEV_USER=vscode
DEV_HOME=/home/vscode
PREFIX=/home/linuxbrew/.linuxbrew
LOG="$DEV_HOME/.devpod-brew.log"

if ! mountpoint -q /home/linuxbrew 2>/dev/null; then
  echo "devpod-brew: /home/linuxbrew is not a volume mount; skipping (brew would not persist)"
  exit 0
fi

mkdir -p "$PREFIX"
# Ownership of the mount point and prefix dir only (home-perms already
# chowns the PVC recursively on start).
[ "$(stat -c %u /home/linuxbrew)" = 1000 ] || chown 1000:1000 /home/linuxbrew
[ "$(stat -c %u "$PREFIX")" = 1000 ] || chown 1000:1000 "$PREFIX"

if [ -x "$PREFIX/bin/brew" ]; then
  echo "devpod-brew: $("$PREFIX/bin/brew" --version 2>/dev/null | head -1) present on the home volume"
  exit 0
fi

{
  echo "=== devpod-brew install start $(date -Is)"
  need=""
  for p in gcc:build-essential make:build-essential ps:procps file:file git:git curl:curl; do
    command -v "${p%%:*}" >/dev/null 2>&1 || need="$need ${p##*:}"
  done
  if [ -n "$need" ]; then
    # shellcheck disable=SC2046  # intentional word splitting of package list
    apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends $(echo "$need" | tr ' ' '\n' | sort -u) || echo "prereq install failed"
  fi
  runuser -u "$DEV_USER" -- env -i HOME="$DEV_HOME" USER="$DEV_USER" LOGNAME="$DEV_USER" \
    PATH=/usr/local/bin:/usr/bin:/bin NONINTERACTIVE=1 \
    /bin/bash -c 'curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh | /bin/bash'
  rc=$?
  echo "=== devpod-brew install exit code $rc $(date -Is)"
  [ -x "$PREFIX/bin/brew" ] && "$PREFIX/bin/brew" --version | head -1
} >> "$LOG" 2>&1
chown 1000:1000 "$LOG" 2>/dev/null || true
tail -3 "$LOG"
exit 0
