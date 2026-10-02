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

# --bundle-identifier is the host app id. --app-name names the project; it does
# not stop --macos-only from rewriting that id. Passing --app-name to an old
# packager is unsafe: unknown flags make it write nothing. The converter accepts it.
app_id=com.invertedlight.tabshade
app_name="Tab Shade"

set -- \
  --project-location "$out" \
  --bundle-identifier "$app_id" \
  --swift \
  --macos-only \
  --copy-resources \
  --force \
  --no-prompt \
  --no-open

if [ "$tool" = "safari-web-extension-converter" ]; then
  set -- "$@" --app-name "$app_name"
fi

echo "Running: xcrun $tool $* extension"
xcrun "$tool" "$@" extension

project=$(find "$out" -name '*.xcodeproj' -print | head -n 1)
if [ -z "$project" ]; then
  echo "The packager exited without writing an .xcodeproj under $out." >&2
  find "$out" -print >&2
  exit 1
fi

# With --macos-only the packager rewrites the app target's id from the
# manifest name ("Tab Shade" -> com.invertedlight.Tab-Shade) and leaves the
# extension at com.invertedlight.tabshade.Extension. Xcode then errors:
# "Embedded binary's bundle identifier is not prefixed with the parent
# app's bundle identifier." --app-name does not correct that; it only
# titles the project. Put the app id back from each target's product type
# and refuse to open the project if any id still misses the prefix.
if ! command -v node >/dev/null 2>&1; then
  echo "node is required to correct the generated bundle ids." >&2
  exit 1
fi
node "./scripts/fix-bundle-id.mjs" "$project" "$app_id"

echo "Xcode project: $(pwd)/$project"
open "$project"
