#!/bin/sh
set -eu
cd "$(dirname "$0")/.."

if ! command -v xcrun >/dev/null 2>&1; then
  echo "Run this on a Mac with Xcode. It wraps the extension in a Safari app." >&2
  exit 1
fi

xcrun safari-web-extension-converter extension \
  --project-location "Tab Shade" \
  --app-name "Tab Shade" \
  --bundle-identifier "com.invertedlight.tabshade" \
  --swift \
  --copy-resources \
  --force \
  --no-prompt \
  --no-open
