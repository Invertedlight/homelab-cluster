#!/bin/sh
set -eu
cd "$(dirname "$0")/.."

if ! command -v xcrun >/dev/null 2>&1; then
  echo "Run this on a Mac with Xcode. It wraps the extension in a Safari app." >&2
  exit 1
fi

if xcrun --find safari-web-extension-packager >/dev/null 2>&1; then
  tool=safari-web-extension-packager
elif xcrun --find safari-web-extension-converter >/dev/null 2>&1; then
  tool=safari-web-extension-converter
else
  echo "Xcode does not provide safari-web-extension-packager or safari-web-extension-converter." >&2
  echo "Select the Xcode app with: sudo xcode-select -s /Applications/Xcode.app" >&2
  exit 1
fi

# The tool writes <project-location>/<extension name>/<extension name>.xcodeproj.
# The extension name comes from manifest.json ("Tab Shade"), so the project is
# build/safari/Tab Shade/Tab Shade.xcodeproj — not Tab Shade/Tab Shade.xcodeproj.
out=build/safari
rm -rf "$out"
mkdir -p "$out"

set -- \
  --project-location "$out" \
  --bundle-identifier "com.invertedlight.tabshade" \
  --swift \
  --macos-only \
  --copy-resources \
  --force \
  --no-prompt \
  --no-open

# The older converter still takes --app-name. The packager rejects unknown flags
# and then writes nothing.
if [ "$tool" = "safari-web-extension-converter" ]; then
  set -- "$@" --app-name "Tab Shade"
fi

echo "Running: xcrun $tool $* extension"
xcrun "$tool" "$@" extension

project=$(find "$out" -name '*.xcodeproj' -print | head -n 1)
if [ -z "$project" ]; then
  echo "The packager exited without writing an .xcodeproj under $out." >&2
  find "$out" -print >&2
  exit 1
fi

echo "Xcode project: $(pwd)/$project"
open "$project"
