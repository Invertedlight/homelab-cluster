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

# --bundle-identifier is the host app id. --app-name names the project. It does
# not stop the packager from rewriting that id. Passing --app-name to an old
# packager is unsafe: unknown flags make it write nothing. The converter accepts it.
# No --macos-only: the same project gets a Mac target and an iPhone/iPad target.
app_id=com.invertedlight.tabshade
app_name="Tab Shade"

team_id=${APPLE_TEAM_ID:-}
if [ -z "$team_id" ] && [ -f apple-team-id ]; then
  team_id=$(tr -d '[:space:]' < apple-team-id)
fi
team_id=$(printf '%s' "$team_id" | tr '[:lower:]' '[:upper:]')
case "$team_id" in
  [A-Z0-9][A-Z0-9][A-Z0-9][A-Z0-9][A-Z0-9][A-Z0-9][A-Z0-9][A-Z0-9][A-Z0-9][A-Z0-9])
    ;;
  *)
    echo "Tab Shade is signed with your Apple Developer team, not an ad-hoc signature." >&2
    echo "Put the 10-character Team ID in safari-tab-shade/apple-team-id or export APPLE_TEAM_ID." >&2
    echo "Xcode → Settings → Accounts → your team, or developer.apple.com/account → Membership." >&2
    exit 1
    ;;
esac

set -- \
  --project-location "$out" \
  --bundle-identifier "$app_id" \
  --swift \
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

# The packager can rewrite an app target's id from the manifest name
# ("Tab Shade" -> com.invertedlight.Tab-Shade) and leave the extension at
# com.invertedlight.tabshade.Extension. Xcode then errors: "Embedded binary's
# bundle identifier is not prefixed with the parent app's bundle identifier."
# Put every app id back from the target product type, sign every configuration
# with the Apple Developer team, and mark the iOS target as iPhone and iPad.
if ! command -v node >/dev/null 2>&1; then
  echo "node is required to correct the generated bundle ids." >&2
  exit 1
fi
node "./scripts/fix-bundle-id.mjs" "$project" "$app_id" "$team_id"

echo "Xcode project: $(pwd)/$project"
open "$project"
