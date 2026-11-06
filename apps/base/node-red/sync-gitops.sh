#!/bin/sh
# Apply GitOps flow exports and palette packages onto the Node-RED data directory.
# Prints nothing sensitive. See README.md for the export and palette workflow.
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
export GITOPS_DIR="${GITOPS_DIR:-$SCRIPT_DIR}"
export DATA_DIR="${DATA_DIR:-/data}"

if ! action=$(node "$SCRIPT_DIR/sync-gitops.js"); then
  exit 1
fi

case "$action" in
  skip)
    echo "sync-gitops: installed palette satisfies Git ranges" >&2
    ;;
  install)
    echo "sync-gitops: npm install in $DATA_DIR" >&2
    cd "$DATA_DIR"
    npm install --unsafe-perm --no-update-notifier --no-fund --no-audit --omit=dev
    ;;
  *)
    echo "sync-gitops: unexpected result: ${action}" >&2
    exit 1
    ;;
esac
