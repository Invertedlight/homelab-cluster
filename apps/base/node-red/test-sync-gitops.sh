#!/bin/sh
# Exercises sync-gitops.sh against a fake data directory. npm is a stub.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
fail() {
  echo "FAIL: $*" >&2
  exit 1
}
ok() {
  echo "ok: $*"
}

SCRIPT="$ROOT/sync-gitops.sh"
[ -f "$SCRIPT" ] || fail "missing sync-gitops.sh"
[ -f "$ROOT/flows/weather-flow.json" ] || fail "missing weather flow"
[ -f "$ROOT/palette/package.json" ] || fail "missing palette package.json"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
NPM_LOG="$TMP/npm.log"
touch "$NPM_LOG"
FAKE=$(mktemp -d)
cat > "$FAKE/npm" << EOF
#!/bin/sh
echo "npm \$*" >> "$NPM_LOG"
pwd >> "$NPM_LOG"
exit 0
EOF
chmod +x "$FAKE/npm"
export PATH="$FAKE:$PATH"

reset_npm() {
  : > "$NPM_LOG"
}

flatten() {
  dest=$1
  mkdir -p "$dest"
  cp "$ROOT/palette/package.json" "$dest/package.json"
  cp "$ROOT/flows/weather-flow.json" "$dest/weather-flow.json"
}

install_module() {
  data=$1
  name=$2
  version=$3
  dir="$data/node_modules/$name"
  mkdir -p "$dir"
  printf '{"name":"%s","version":"%s"}\n' "$name" "$version" > "$dir/package.json"
}

run_sync() {
  gitops=$1
  data=$2
  GITOPS_DIR=$gitops DATA_DIR=$data sh "$SCRIPT"
}

# The committed weather export is the 65-node flow and has no secrets.
# The public dashboard has no input widgets. Unit choice is two editor injects.
node - "$ROOT/flows/weather-flow.json" "$ROOT/palette/package.json" << 'PY'
const fs = require("fs");
const flow = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (!Array.isArray(flow) || flow.length !== 65) {
  console.error("weather flow node count " + (Array.isArray(flow) ? flow.length : "not-array"));
  process.exit(1);
}
const types = new Set(flow.map((node) => node.type));
for (const required of ["mqtt-broker", "digitaloak-postgresql-connection-manager", "digitaloak-postgresql-query", "ui_led", "ui_base", "ui_chart", "ui_gauge"]) {
  if (!types.has(required)) {
    console.error("missing node type " + required);
    process.exit(1);
  }
}
const inputWidgets = ["ui_button", "ui_dropdown", "ui_switch", "ui_slider", "ui_numeric", "ui_text_input", "ui_date_picker", "ui_colour_picker", "ui_form"];
for (const node of flow) {
  if (inputWidgets.includes(node.type)) {
    console.error("public flow still has input widget " + node.type + " " + node.id);
    process.exit(1);
  }
}
const changeId = "9ff796d2663996e4";
function wiresTo(node, id) {
  return Array.isArray(node.wires) && node.wires.some((ports) => Array.isArray(ports) && ports.includes(id));
}
const hpa = flow.find((node) => node.type === "inject" && node.name === "Editor: hPa");
const inhg = flow.find((node) => node.type === "inject" && node.name === "Editor: inHg");
if (!hpa || hpa.payload !== true || hpa.payloadType !== "bool" || hpa.once !== false || !wiresTo(hpa, changeId)) {
  console.error("Editor: hPa inject is missing or not wired to the unit change");
  process.exit(1);
}
if (!inhg || inhg.payload !== false || inhg.payloadType !== "bool" || inhg.once !== false || !wiresTo(inhg, changeId)) {
  console.error("Editor: inHg inject is missing or not wired to the unit change");
  process.exit(1);
}
for (const node of flow) {
  if (typeof node.type === "string" && node.type.startsWith("ui_") && wiresTo(node, changeId)) {
    console.error("a dashboard node still wires into the unit change: " + node.type);
    process.exit(1);
  }
}
const template = flow.find((node) => node.type === "ui_template");
if (!template || /scope\.send|ng-click|ng-change|ng-submit|socket\.emit/.test(template.format || "")) {
  console.error("ui_template can send from the browser");
  process.exit(1);
}
const secretKey = /^(password|passwd|secret|token|apikey|api_key|credential|credentialsecret|access_token|refresh_token|authorization)$/i;
function walk(value, where) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, where + "[" + index + "]"));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (key === "credentials" && child && typeof child === "object" && Object.keys(child).length > 0) {
      console.error("non-empty credentials at " + where);
      process.exit(1);
    }
    if (secretKey.test(key) && child !== "" && child != null) {
      console.error("secret field " + key + " at " + where);
      process.exit(1);
    }
    walk(child, where + "." + key);
  }
}
walk(flow, "$");
const deps = JSON.parse(fs.readFileSync(process.argv[3], "utf8")).dependencies;
const expected = {
  "node-red-dashboard": "~3.6.0",
  "@digitaloak/node-red-contrib-digitaloak-postgresql": "~0.3.2",
  "node-red-contrib-ui-led": "~0.4.11",
};
const depNames = Object.keys(deps).sort();
const expectedNames = Object.keys(expected).sort();
if (depNames.join("\n") !== expectedNames.join("\n")) {
  console.error("palette package names drifted: " + depNames.join(", "));
  process.exit(1);
}
for (const name of expectedNames) {
  if (deps[name] !== expected[name]) {
    console.error("palette spec drifted for " + name + ": " + deps[name]);
    process.exit(1);
  }
}
PY
ok "committed weather flow is 65 nodes, view-only, and the palette ranges match"

# Range checks follow npm for ~, ^, exact, comparators, and a few other forms the
# palette file is allowed to contain. Cases that do not satisfy must take the
# install path, including a version on the other side of the range.
node - "$ROOT/sync-gitops.js" << 'PY'
const { versionSatisfies } = require(process.argv[2]);
const cases = [
  ["3.4.0", "~3.6.0", false],
  ["3.6.0", "~3.6.0", true],
  ["3.6.5", "~3.6.0", true],
  ["3.7.0", "~3.6.0", false],
  ["0.3.2", "~0.3.2", true],
  ["0.3.9", "~0.3.2", true],
  ["0.4.0", "~0.3.2", false],
  ["0.4.11", "~0.4.11", true],
  ["0.4.20", "~0.4.11", true],
  ["0.5.0", "~0.4.11", false],
  ["1.2.3", "~1.2.3", true],
  ["1.2.9", "~1.2", true],
  ["1.3.0", "~1.2", false],
  ["1.2.3", "^1.2.3", true],
  ["1.9.0", "^1.2.3", true],
  ["2.0.0", "^1.2.3", false],
  ["0.2.3", "^0.2.3", true],
  ["0.2.9", "^0.2.3", true],
  ["0.3.0", "^0.2.3", false],
  ["0.0.3", "^0.0.3", true],
  ["0.0.4", "^0.0.3", false],
  ["1.2.3", "1.2.3", true],
  ["1.2.4", "1.2.3", false],
  ["1.2.3", "=1.2.3", true],
  ["1.2.3", "==1.2.3", false],
  ["v1.2.3", "1.2.3", true],
  ["1.2.3", "v1.2.3", true],
  ["1.2.3+build.4", "1.2.3", true],
  ["1.2.3-beta.1", "~1.2.3", false],
  ["1.2.4-rc.1", "~1.2.3", false],
  ["1.2.3-beta.2", "^1.2.3-beta.1", true],
  ["1.2.4-beta.1", "^1.2.3-beta.1", false],
  ["1.2.3-beta.1", "^1.2.3-beta.1", true],
  ["3.6.0", ">=3.6.0 <3.7.0", true],
  ["3.6.5", ">=3.6.0 <3.7.0", true],
  ["3.7.0", ">=3.6.0 <3.7.0", false],
  ["3.5.9", ">=3.6.0 <3.7.0", false],
  ["1.2.0", "1.2.x", true],
  ["1.2.9", "1.2.x", true],
  ["1.3.0", "1.2.x", false],
  ["1.2.3", "1.2", true],
  ["1.3.0", "1.2", false],
  ["2.1.0", "^1.2.3 || ^2.0.0", true],
  ["1.2.3", "1.2.3 - 2.0.0", true],
  ["2.0.0", "1.2.3 - 2.0.0", true],
  ["2.0.1", "1.2.3 - 2.0.0", false],
  ["1.0.0", "*", true],
  ["1.0.0-rc.1", "*", false],
  ["3.6.0", "~ 3.6.0", true],
];
for (const [version, range, expected] of cases) {
  const got = versionSatisfies(version, range);
  if (got !== expected) {
    console.error(version + " vs " + range + " got " + got + " expected " + expected);
    process.exit(1);
  }
}
PY
ok "version ranges match npm for ~, ^, exact, and comparators"

# Fresh volume: seed the flow bytes and ask npm to install. Leave credentials absent.
fresh_gitops="$TMP/fresh-gitops"
fresh_data="$TMP/fresh-data"
flatten "$fresh_gitops"
mkdir -p "$fresh_data"
reset_npm
run_sync "$fresh_gitops" "$fresh_data"
cmp -s "$ROOT/flows/weather-flow.json" "$fresh_data/flows.json" || fail "fresh seed did not copy the weather flow bytes"
[ ! -e "$fresh_data/flows_cred.json" ] || fail "fresh seed created flows_cred.json"
node - "$fresh_data/package.json" << 'PY' || fail "fresh package.json missing palette deps"
const doc = require(process.argv[2]);
const deps = doc.dependencies;
if (deps["node-red-dashboard"] !== "~3.6.0") process.exit(1);
if (deps["node-red-contrib-ui-led"] !== "~0.4.11") process.exit(1);
if (deps["@digitaloak/node-red-contrib-digitaloak-postgresql"] !== "~0.3.2") process.exit(1);
PY
grep -q "npm install" "$NPM_LOG" || fail "fresh volume did not npm install"
grep -q "$fresh_data" "$NPM_LOG" || fail "npm install ran outside the data directory"
ok "empty volume seeds the weather flow and installs the palette"

# Installed versions already satisfy the Git ranges. Flows, credentials, editor
# packages, and the recorded specs stay put, and npm does not run.
live_gitops="$TMP/live-gitops"
live_data="$TMP/live-data"
flatten "$live_gitops"
mkdir -p "$live_data"
printf 'LIVE-FLOWS\n' > "$live_data/flows.json"
printf 'LIVE-CRED\n' > "$live_data/flows_cred.json"
printf 'KEEP\n' > "$live_data/important.txt"
cat > "$live_data/package.json" << 'EOF'
{
    "name": "node-red-project",
    "private": true,
    "dependencies": {
        "node-red-dashboard": "~3.6.0",
        "node-red-contrib-extra": "1.2.3",
        "@digitaloak/node-red-contrib-digitaloak-postgresql": "~0.3.2",
        "node-red-contrib-ui-led": "~0.4.11"
    }
}
EOF
cp "$live_data/package.json" "$TMP/live-package.json"
install_module "$live_data" node-red-dashboard 3.6.5
install_module "$live_data" node-red-contrib-ui-led 0.4.11
install_module "$live_data" @digitaloak/node-red-contrib-digitaloak-postgresql 0.3.2
install_module "$live_data" node-red-contrib-extra 1.2.3
reset_npm
run_sync "$live_gitops" "$live_data"
cmp -s "$live_data/flows.json" - << 'EOF' || fail "live flows.json changed"
LIVE-FLOWS
EOF
cmp -s "$live_data/flows_cred.json" - << 'EOF' || fail "flows_cred.json changed"
LIVE-CRED
EOF
cmp -s "$live_data/important.txt" - << 'EOF' || fail "unrelated data file changed"
KEEP
EOF
cmp -s "$live_data/package.json" "$TMP/live-package.json" || fail "satisfying package.json was rewritten"
cmp -s "$live_data/node_modules/node-red-contrib-extra/package.json" - << 'EOF' || fail "editor-only module was changed"
{"name":"node-red-contrib-extra","version":"1.2.3"}
EOF
[ ! -s "$NPM_LOG" ] || fail "npm ran even though every GitOps package already satisfied its range"
ok "installed versions that satisfy the Git ranges are left in place"

# The editor recorded a different spec, but the installed version already
# satisfies the Git range. Git's spec replaces it and npm does not run.
# Packages that are only on the volume stay.
match_gitops="$TMP/match-gitops"
match_data="$TMP/match-data"
flatten "$match_gitops"
mkdir -p "$match_data"
printf 'LIVE-FLOWS\n' > "$match_data/flows.json"
printf 'LIVE-CRED\n' > "$match_data/flows_cred.json"
cat > "$match_data/package.json" << 'EOF'
{
  "name": "node-red-project",
  "description": "keep-me",
  "private": true,
  "dependencies": {
    "node-red-dashboard": "~3.6.5",
    "node-red-contrib-extra": "1.2.3",
    "@digitaloak/node-red-contrib-digitaloak-postgresql": "~0.3.2",
    "node-red-contrib-ui-led": "~0.4.11"
  }
}
EOF
install_module "$match_data" node-red-dashboard 3.6.5
install_module "$match_data" node-red-contrib-ui-led 0.4.11
install_module "$match_data" @digitaloak/node-red-contrib-digitaloak-postgresql 0.3.2
install_module "$match_data" node-red-contrib-extra 1.2.3
reset_npm
run_sync "$match_gitops" "$match_data"
node - "$match_data/package.json" << 'PY' || fail "satisfying install did not record the Git range"
const fs = require("fs");
const doc = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (doc.description !== "keep-me") process.exit(1);
const deps = doc.dependencies;
if (deps["node-red-dashboard"] !== "~3.6.0") process.exit(1);
if (deps["node-red-contrib-extra"] !== "1.2.3") process.exit(1);
if (deps["node-red-contrib-ui-led"] !== "~0.4.11") process.exit(1);
if (deps["@digitaloak/node-red-contrib-digitaloak-postgresql"] !== "~0.3.2") process.exit(1);
PY
cmp -s "$match_data/flows.json" - << 'EOF' || fail "flows changed while aligning a satisfying spec"
LIVE-FLOWS
EOF
cmp -s "$match_data/flows_cred.json" - << 'EOF' || fail "credentials changed while aligning a satisfying spec"
LIVE-CRED
EOF
cmp -s "$match_data/node_modules/node-red-dashboard/package.json" - << 'EOF' || fail "satisfying module was reinstalled"
{"name":"node-red-dashboard","version":"3.6.5"}
EOF
[ ! -s "$NPM_LOG" ] || fail "npm ran even though the installed version satisfies the Git range"
ok "a satisfying install records the Git range and skips npm"

# Git moved the dashboard range above the copy on the volume (3.4.0 -> ~3.6.0).
# Record the new range and npm install. Editor-only packages stay.
bump_gitops="$TMP/bump-gitops"
bump_data="$TMP/bump-data"
flatten "$bump_gitops"
mkdir -p "$bump_data"
printf 'LIVE-FLOWS\n' > "$bump_data/flows.json"
printf 'LIVE-CRED\n' > "$bump_data/flows_cred.json"
cat > "$bump_data/package.json" << 'EOF'
{
  "name": "node-red-project",
  "private": true,
  "dependencies": {
    "node-red-dashboard": "~3.4.0",
    "node-red-contrib-extra": "1.2.3",
    "@digitaloak/node-red-contrib-digitaloak-postgresql": "~0.3.2",
    "node-red-contrib-ui-led": "~0.4.11"
  }
}
EOF
install_module "$bump_data" node-red-dashboard 3.4.0
install_module "$bump_data" node-red-contrib-ui-led 0.4.11
install_module "$bump_data" @digitaloak/node-red-contrib-digitaloak-postgresql 0.3.2
install_module "$bump_data" node-red-contrib-extra 1.2.3
reset_npm
run_sync "$bump_gitops" "$bump_data"
node - "$bump_data/package.json" << 'PY' || fail "bumped range was not recorded beside the editor package"
const fs = require("fs");
const doc = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const deps = doc.dependencies;
if (deps["node-red-dashboard"] !== "~3.6.0") process.exit(1);
if (deps["node-red-contrib-extra"] !== "1.2.3") process.exit(1);
if (deps["node-red-contrib-ui-led"] !== "~0.4.11") process.exit(1);
if (deps["@digitaloak/node-red-contrib-digitaloak-postgresql"] !== "~0.3.2") process.exit(1);
PY
cmp -s "$bump_data/flows.json" - << 'EOF' || fail "flows changed during a palette upgrade"
LIVE-FLOWS
EOF
cmp -s "$bump_data/flows_cred.json" - << 'EOF' || fail "credentials changed during a palette upgrade"
LIVE-CRED
EOF
cmp -s "$bump_data/node_modules/node-red-contrib-extra/package.json" - << 'EOF' || fail "editor-only module was changed during upgrade"
{"name":"node-red-contrib-extra","version":"1.2.3"}
EOF
grep -q "npm install" "$NPM_LOG" || fail "range bump above the installed version did not npm install"
grep -q "$bump_data" "$NPM_LOG" || fail "upgrade npm install ran outside the data directory"
ok "a Git range above the installed version upgrades that package only"

# The spec on the volume already matches Git, but node_modules is still older.
# npm install has to run again; rewriting the spec is not enough.
stale_gitops="$TMP/stale-gitops"
stale_data="$TMP/stale-data"
flatten "$stale_gitops"
mkdir -p "$stale_data"
printf 'LIVE-FLOWS\n' > "$stale_data/flows.json"
printf 'LIVE-CRED\n' > "$stale_data/flows_cred.json"
cat > "$stale_data/package.json" << 'EOF'
{
  "name": "node-red-project",
  "private": true,
  "dependencies": {
    "node-red-contrib-extra": "1.2.3",
    "node-red-dashboard": "~3.6.0",
    "@digitaloak/node-red-contrib-digitaloak-postgresql": "~0.3.2",
    "node-red-contrib-ui-led": "~0.4.11"
  }
}
EOF
cp "$stale_data/package.json" "$TMP/stale-package.json"
install_module "$stale_data" node-red-dashboard 3.4.0
install_module "$stale_data" node-red-contrib-ui-led 0.4.11
install_module "$stale_data" @digitaloak/node-red-contrib-digitaloak-postgresql 0.3.2
install_module "$stale_data" node-red-contrib-extra 1.2.3
reset_npm
run_sync "$stale_gitops" "$stale_data"
cmp -s "$stale_data/package.json" "$TMP/stale-package.json" || fail "matching specs were rewritten"
cmp -s "$stale_data/flows_cred.json" - << 'EOF' || fail "credentials changed while retrying npm install"
LIVE-CRED
EOF
grep -q "npm install" "$NPM_LOG" || fail "stale install whose spec already matches Git did not npm install"
ok "a stale module is installed again when its spec already matches Git"

# A missing module is added beside packages James installed in the editor.
miss_gitops="$TMP/miss-gitops"
miss_data="$TMP/miss-data"
flatten "$miss_gitops"
mkdir -p "$miss_data"
printf 'LIVE-FLOWS\n' > "$miss_data/flows.json"
printf 'LIVE-CRED\n' > "$miss_data/flows_cred.json"
cat > "$miss_data/package.json" << 'EOF'
{
  "name": "node-red-project",
  "private": true,
  "dependencies": {
    "node-red-dashboard": "~3.6.5",
    "node-red-contrib-extra": "1.2.3"
  }
}
EOF
install_module "$miss_data" node-red-dashboard 3.6.5
install_module "$miss_data" @digitaloak/node-red-contrib-digitaloak-postgresql 0.3.2
reset_npm
run_sync "$miss_gitops" "$miss_data"
node - "$miss_data/package.json" << 'PY' || fail "missing package was not recorded beside existing deps"
const fs = require("fs");
const doc = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const deps = doc.dependencies;
if (deps["node-red-dashboard"] !== "~3.6.0") process.exit(1);
if (deps["node-red-contrib-extra"] !== "1.2.3") process.exit(1);
if (deps["node-red-contrib-ui-led"] !== "~0.4.11") process.exit(1);
if (deps["@digitaloak/node-red-contrib-digitaloak-postgresql"] !== "~0.3.2") process.exit(1);
PY
cmp -s "$miss_data/flows.json" - << 'EOF' || fail "flows changed while recording a missing package"
LIVE-FLOWS
EOF
cmp -s "$miss_data/flows_cred.json" - << 'EOF' || fail "credentials changed while recording a missing package"
LIVE-CRED
EOF
grep -q "npm install" "$NPM_LOG" || fail "missing module did not trigger npm install"
ok "missing palette package is added without dropping editor-installed dependencies"

# flows.json in Git is the full export. Other JSON files are checked and then ignored for seeding.
full_gitops="$TMP/full-gitops"
full_data="$TMP/full-data"
mkdir -p "$full_gitops" "$full_data"
cp "$ROOT/palette/package.json" "$full_gitops/package.json"
cp "$ROOT/flows/weather-flow.json" "$full_gitops/weather-flow.json"
printf '[{"id":"tab-only","type":"tab","label":"Full","disabled":false,"info":""}]\n' > "$full_gitops/flows.json"
reset_npm
run_sync "$full_gitops" "$full_data"
cmp -s "$full_data/flows.json" "$full_gitops/flows.json" || fail "flows.json was not the sole seed"
ok "flows.json is the sole seed when it is present"

# Two overlapping exports with different bodies must fail before creating flows.json.
clash_gitops="$TMP/clash-gitops"
clash_data="$TMP/clash-data"
mkdir -p "$clash_gitops" "$clash_data"
cp "$ROOT/palette/package.json" "$clash_gitops/package.json"
printf '[{"id":"same","type":"tab","label":"A","disabled":false,"info":""}]\n' > "$clash_gitops/a.json"
printf '[{"id":"same","type":"tab","label":"B","disabled":false,"info":""}]\n' > "$clash_gitops/b.json"
reset_npm
if GITOPS_DIR=$clash_gitops DATA_DIR=$clash_data sh "$SCRIPT"; then
  fail "conflicting flow ids were accepted"
fi
[ ! -e "$clash_data/flows.json" ] || fail "conflict wrote flows.json"
[ ! -s "$NPM_LOG" ] || fail "npm ran after a flow conflict"
ok "conflicting flow ids stop the seed"

# A secret in a flow export fails and leaves the volume untouched.
secret_gitops="$TMP/secret-gitops"
secret_data="$TMP/secret-data"
mkdir -p "$secret_gitops" "$secret_data"
cp "$ROOT/palette/package.json" "$secret_gitops/package.json"
printf '[{"id":"broker","type":"mqtt-broker","name":"x","password":"super-secret"}]\n' > "$secret_gitops/leaked.json"
printf 'ALREADY\n' > "$secret_data/flows.json"
printf 'CRED\n' > "$secret_data/flows_cred.json"
reset_npm
if GITOPS_DIR=$secret_gitops DATA_DIR=$secret_data sh "$SCRIPT"; then
  fail "flow export containing a password was accepted"
fi
cmp -s "$secret_data/flows.json" - << 'EOF' || fail "secret rejection changed flows.json"
ALREADY
EOF
cmp -s "$secret_data/flows_cred.json" - << 'EOF' || fail "secret rejection changed flows_cred.json"
CRED
EOF
[ ! -s "$NPM_LOG" ] || fail "npm ran after a secret rejection"
ok "a flow export that contains a password is rejected"

# Broken volume package.json is left byte-for-byte alone.
bad_gitops="$TMP/bad-gitops"
bad_data="$TMP/bad-data"
flatten "$bad_gitops"
mkdir -p "$bad_data"
printf '{\n' > "$bad_data/package.json"
printf 'CRED\n' > "$bad_data/flows_cred.json"
reset_npm
if GITOPS_DIR=$bad_gitops DATA_DIR=$bad_data sh "$SCRIPT"; then
  fail "invalid package.json was accepted"
fi
cmp -s "$bad_data/package.json" - << 'EOF' || fail "invalid package.json was rewritten"
{
EOF
[ ! -e "$bad_data/flows.json" ] || fail "invalid package.json still seeded flows.json"
cmp -s "$bad_data/flows_cred.json" - << 'EOF' || fail "invalid package.json handling touched credentials"
CRED
EOF
ok "invalid volume package.json is left unchanged"

# URL specs are rejected so a palette entry cannot smuggle a credentialed git URL.
url_gitops="$TMP/url-gitops"
url_data="$TMP/url-data"
mkdir -p "$url_gitops" "$url_data"
printf '%s\n' '{"dependencies":{"node-red-dashboard":"git+https://user:token@github.com/example/node-red-dashboard.git"}}' > "$url_gitops/package.json"
printf '[{"id":"tab","type":"tab","label":"T","disabled":false,"info":""}]\n' > "$url_gitops/flows.json"
if GITOPS_DIR=$url_gitops DATA_DIR=$url_data sh "$SCRIPT"; then
  fail "git URL palette spec was accepted"
fi
[ ! -e "$url_data/flows.json" ] || fail "rejected palette spec still seeded a flow"
[ ! -e "$url_data/package.json" ] || fail "rejected palette spec wrote package.json"
ok "palette specs stay version ranges"

# Dashboard HTTP and socket rules. settings.js must load the helper from the
# settings ConfigMap, and the docs must name the login path and the seed rule.
grep -q "http-node-auth.js" "$ROOT/kustomization.yaml" || fail "settings ConfigMap does not mount http-node-auth.js"
grep -q "node-red-http-login" "$ROOT/README.md" || fail "README does not name the HTTP login path"
grep -q "only when" "$ROOT/README.md" || fail "README does not say flows.json is seeded only when missing"
node "$ROOT/test-dashboard-auth.js" || fail "dashboard auth checks failed"

echo "all node-red gitops sync tests passed"
