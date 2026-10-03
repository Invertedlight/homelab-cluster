#!/bin/bash
# DevPod base environment. Runs as root in the "bootstrap" initContainer
# with the home PVC at /home/vscode. Full setup only when the marker is
# missing or carries an older version; a restart skips it. Never exits
# non-zero so a failed bootstrap does not crash-loop the pod; the result
# is in ~/.devpod-bootstrap.status and ~/.devpod-bootstrap.log.
set -uo pipefail
BOOTSTRAP_VERSION=1
export HOME=/home/vscode USER=vscode LOGNAME=vscode SHELL=/bin/bash
MARKER="$HOME/.devpod-bootstrap-done"
STATUS="$HOME/.devpod-bootstrap.status"
LOG="$HOME/.devpod-bootstrap.log"
DOTFILES_URL=https://github.com/Invertedlight/dotfiles.git
SRC_DIR="$HOME/.local/share/chezmoi"
WORK="$HOME/.cache/devpod-bootstrap"
export PATH="$HOME/.local/bin:$PATH"
# vscode login shells use umask 002; match it so chezmoi status does not
# report mode-only drift on every file written here as root.
umask 0002

if [ -f "$MARKER" ] && grep -qx "version=$BOOTSTRAP_VERSION" "$MARKER"; then
  echo "devpod-bootstrap: marker version=$BOOTSTRAP_VERSION found, skipping full setup"
  cat "$MARKER"
  exit 0
fi

exec > >(tee -a "$LOG") 2>&1
echo "=== devpod-bootstrap v$BOOTSTRAP_VERSION start $(date -Is) on $(hostname)"
step() { echo; echo "--- $*"; }

step "packages"
need=""
for p in curl:curl git:git sudo:sudo zsh:zsh; do
  command -v "${p%%:*}" >/dev/null 2>&1 || need="$need ${p##*:}"
done
if [ -n "$need" ]; then
  apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates $need
fi

step "git auth"
/opt/devpod-bootstrap/devpod-runtime.sh
if [ -s /etc/devpod/github/token ]; then
  # Authenticated GitHub API calls for mise/chezmoi downloads (rate limit).
  GITHUB_TOKEN="$(cat /etc/devpod/github/token)"; export GITHUB_TOKEN
fi

step "dotfiles clone"
mkdir -p "$HOME/.local/share" "$WORK"
if [ -d "$SRC_DIR/.git" ]; then
  git -C "$SRC_DIR" pull --ff-only || echo "pull failed, using existing clone"
else
  git clone "$DOTFILES_URL" "$SRC_DIR"
fi
clone_rc=$?

step "dotfiles setup (run from $WORK so ./bin/chezmoi lands there)"
# The script runs chezmoi init only if chezmoi is not on PATH; keep mise
# shims off PATH here so it does. It needs $USER set (set -u).
cd "$WORK"
PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" bash "$SRC_DIR/setup"
setup_rc=$?
echo "setup exit code: $setup_rc"
# If chezmoi was already on PATH the script skips init; apply anyway.
CZ=""
for c in "$WORK/bin/chezmoi" "$HOME/bin/chezmoi" "$(command -v chezmoi 2>/dev/null)"; do
  [ -n "$c" ] && [ -x "$c" ] && { CZ="$c"; break; }
done
if [ -n "$CZ" ]; then
  "$CZ" apply --force --no-tty; apply_rc=$?
else
  echo "no chezmoi binary found"; apply_rc=127
fi
echo "chezmoi apply exit code: $apply_rc"

step "mise"
if [ ! -x "$HOME/.local/bin/mise" ]; then
  curl -fsSL https://mise.run | MISE_INSTALL_PATH="$HOME/.local/bin/mise" sh
fi
"$HOME/.local/bin/mise" --version
# .bashrc/.zshrc are owned by chezmoi (the dotfiles activate mise when it
# is on PATH), so do not append to them; that caused chezmoi drift.
# Non-interactive and login shells (ssh cmd, su -) do not read .zshrc or
# reach the end of .bashrc; put mise and its shims on PATH there too.
for f in "$HOME/.zshenv" "$HOME/.profile"; do
  touch "$f"
  grep -q 'devpod-bootstrap: mise path' "$f" || printf '\n# devpod-bootstrap: mise path\nexport PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"\n' >> "$f"
done
cd "$SRC_DIR"
"$HOME/.local/bin/mise" trust "$SRC_DIR/mise.toml"
[ -f "$HOME/mise.toml" ] && "$HOME/.local/bin/mise" trust "$HOME/mise.toml"
[ -f "$HOME/.config/mise/config.toml" ] && "$HOME/.local/bin/mise" trust "$HOME/.config/mise/config.toml"
"$HOME/.local/bin/mise" install
mise_rc=$?
echo "mise install exit code: $mise_rc"

step "GitHub auth check"
# homelab-cluster is public, so ls-remote alone does not prove auth. The
# receive-pack advertisement needs valid credentials (401 without).
if GIT_TERMINAL_PROMPT=0 git ls-remote https://github.com/Invertedlight/homelab-cluster HEAD >/dev/null 2>&1; then
  lsr=ok; else lsr=failed; fi
code=$(printf 'protocol=https\nhost=github.com\n\n' | git credential fill 2>/dev/null \
  | awk -F= '/^username=/{u=$2} /^password=/{p=$2} END{if(p!="") printf "user = \"%s:%s\"\n", u, p}' \
  | curl -s -o /dev/null -w '%{http_code}' -K - \
    'https://github.com/Invertedlight/homelab-cluster.git/info/refs?service=git-receive-pack')
echo "git ls-remote homelab-cluster: $lsr; authenticated receive-pack probe: HTTP $code"
priv="ls_remote=$lsr,auth_http=$code"

step "ownership"
chown -R 1000:1000 "$HOME"

{
  echo "version=$BOOTSTRAP_VERSION"
  echo "date=$(date -Is)"
  echo "clone_rc=$clone_rc"
  echo "setup_rc=$setup_rc"
  echo "chezmoi_apply_rc=$apply_rc"
  echo "mise_install_rc=$mise_rc"
  echo "github_check=$priv"
} > "$STATUS"
chown 1000:1000 "$STATUS"
if [ "$clone_rc" = 0 ] && [ "$setup_rc" = 0 ] && [ "$mise_rc" = 0 ]; then
  cp "$STATUS" "$MARKER"; chown 1000:1000 "$MARKER"
  echo "=== devpod-bootstrap done, marker written"
else
  echo "=== devpod-bootstrap incomplete; no marker, will retry on next start"
fi
exit 0
