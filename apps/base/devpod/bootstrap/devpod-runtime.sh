#!/bin/bash
# Per-start setup for anything that lives on the container filesystem
# (lost on every restart): git credential helper, gh token, login shell,
# mise on PATH. Safe to run in the bootstrap initContainer and in workspace.
set -uo pipefail
DEV_USER=vscode
DEV_HOME=/home/vscode
SRC=/etc/devpod/github/token
RUN_DIR=/run/devpod-github

# Copy the token to a vscode-readable file outside the home PVC.
if [ -s "$SRC" ]; then
  mkdir -p "$RUN_DIR"
  install -m 0400 -o 1000 -g 1000 "$SRC" "$RUN_DIR/token"
  chmod 0500 "$RUN_DIR"; chown 1000:1000 "$RUN_DIR"
  echo "devpod-runtime: GitHub token present"
else
  echo "devpod-runtime: no GitHub token mounted; private repos will not clone"
fi

# System git config: helper for github.com over HTTPS, never prompt.
git config --system credential.https://github.com.helper /opt/devpod-bootstrap/git-credential-devpod
git config --system credential.https://github.com.username x-access-token
git config --system credential.https://github.com.useHttpPath false

# gh (if installed) reads GH_TOKEN in login shells.
cat > /etc/profile.d/devpod-github.sh <<'PROF'
if [ -r /run/devpod-github/token ]; then GH_TOKEN="$(cat /run/devpod-github/token)"; export GH_TOKEN; fi
PROF
# mise for every login shell (root via kubectl exec, vscode via ssh).
cat > /etc/profile.d/devpod-mise.sh <<'PROF'
case ":$PATH:" in *":/home/vscode/.local/bin:"*) ;; *) PATH="/home/vscode/.local/bin:$PATH";; esac
export PATH
PROF
ln -sf "$DEV_HOME/.local/bin/mise" /usr/local/bin/mise 2>/dev/null || true

# The dotfiles setup runs "sudo chsh -s zsh $USER"; /etc/passwd is not
# on the PVC, so repeat it on every start.
if command -v zsh >/dev/null 2>&1; then
  chsh -s "$(command -v zsh)" "$DEV_USER" || echo "devpod-runtime: chsh failed"
fi
exit 0
