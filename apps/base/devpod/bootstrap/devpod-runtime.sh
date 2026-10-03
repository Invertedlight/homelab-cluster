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

# SOPS age private key (Secret devpod/sops-age, mounted only in workspace).
# Copy to the container fs for vscode; ~/.config/sops/age/keys.txt (sops'
# default path) is only a symlink, so the key never lands on the home PVC.
AGE_SRC=/etc/sops-age/age.agekey
AGE_DIR=/run/devpod-sops
if [ -s "$AGE_SRC" ]; then
  mkdir -p "$AGE_DIR"
  install -m 0400 -o 1000 -g 1000 "$AGE_SRC" "$AGE_DIR/keys.txt"
  chmod 0500 "$AGE_DIR"; chown 1000:1000 "$AGE_DIR"
  install -d -m 0700 -o 1000 -g 1000 "$DEV_HOME/.config/sops" "$DEV_HOME/.config/sops/age"
  if [ ! -e "$DEV_HOME/.config/sops/age/keys.txt" ] || [ -L "$DEV_HOME/.config/sops/age/keys.txt" ]; then
    ln -sfn "$AGE_DIR/keys.txt" "$DEV_HOME/.config/sops/age/keys.txt"
    chown -h 1000:1000 "$DEV_HOME/.config/sops/age/keys.txt"
  fi
  cat > /etc/profile.d/devpod-sops.sh <<'PROF'
if [ -r /run/devpod-sops/keys.txt ]; then SOPS_AGE_KEY_FILE=/run/devpod-sops/keys.txt; export SOPS_AGE_KEY_FILE; fi
PROF
  echo "devpod-runtime: SOPS age key present"
else
  echo "devpod-runtime: no SOPS age key mounted; sops -d will not work"
fi

# System git config: helper for github.com over HTTPS, never prompt.
git config --system credential.https://github.com.helper /opt/devpod-bootstrap/git-credential-devpod
git config --system credential.https://github.com.username x-access-token
git config --system credential.https://github.com.useHttpPath false
# Rewrite SSH-style GitHub URLs (git@github.com:, ssh://git@github.com/,
# bare github.com:) to HTTPS so the token helper above is used; the pod has
# no SSH key on GitHub. Reset and re-add so reruns stay idempotent.
git config --system --unset-all url.https://github.com/.insteadOf 2>/dev/null || true
for pfx in git@github.com: ssh://git@github.com/ github.com:; do
  git config --system --add url.https://github.com/.insteadOf "$pfx" || echo "devpod-runtime: insteadOf $pfx failed"
done

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
# Homebrew (on the home PVC) for every login shell, including bash login
# shells that never reach the dotfiles' interactive .bashrc.
cat > /etc/profile.d/devpod-brew.sh <<'PROF'
if [ -x /home/linuxbrew/.linuxbrew/bin/brew ]; then
  case ":$PATH:" in *":/home/linuxbrew/.linuxbrew/bin:"*) ;; *) eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)";; esac
fi
PROF

# SSH and "su -" sessions don't inherit the container env, so kubectl's
# in-cluster config (KUBERNETES_SERVICE_HOST/PORT + the mounted SA token)
# would fall back to localhost:8080. pam_env reads /etc/environment for
# sshd and su regardless of shell (zsh skips /etc/profile.d).
sed -i '/^KUBERNETES_SERVICE_HOST=/d;/^KUBERNETES_SERVICE_PORT=/d;/^SOPS_AGE_KEY_FILE=/d' /etc/environment 2>/dev/null || true
if [ -n "${KUBERNETES_SERVICE_HOST:-}" ]; then
  printf 'KUBERNETES_SERVICE_HOST=%s\nKUBERNETES_SERVICE_PORT=%s\n' "$KUBERNETES_SERVICE_HOST" "${KUBERNETES_SERVICE_PORT:-443}" >> /etc/environment
fi
if [ -r "${AGE_DIR}/keys.txt" ]; then
  echo "SOPS_AGE_KEY_FILE=${AGE_DIR}/keys.txt" >> /etc/environment
fi

# The dotfiles setup runs "sudo chsh -s zsh $USER"; /etc/passwd is not
# on the PVC, so repeat it on every start.
if command -v zsh >/dev/null 2>&1; then
  chsh -s "$(command -v zsh)" "$DEV_USER" || echo "devpod-runtime: chsh failed"
fi
exit 0
