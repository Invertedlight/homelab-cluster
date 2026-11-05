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

# The committed weather export is the 65-node June 2023 flow and has no secrets.
node - "$ROOT/flows/weather-flow.json" "$ROOT/palette/package.json" << 'PY'
const fs = require("fs");
const flow = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (!Array.isArray(flow) || flow.length !== 65) {
  console.error("weather flow node count " + (Array.isArray(flow) ? flow.length : "not-array"));
  process.exit(1);
}
const types = new Set(flow.map((node) => node.type));
for (const required of ["mqtt-broker", "digitaloak-postgresql-connection-manager", "digitaloak-postgresql-query", "ui_led", "ui_base"]) {
  if (!types.has(required)) {
    console.error("missing node type " + required);
    process.exit(1);
  }
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
  "node-red-dashboard": "~3.4.0",
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
ok "committed weather flow is 65 nodes and the palette ranges match"

# Fresh volume: seed the flow bytes and ask npm to install. Leave credentials absent.
fresh_gitops="$TMP/fresh-gitops"
fresh_data="$TMP/fresh-data"
flatten "$fresh_gitops"
mkdir -p "$fresh_data"
reset_npm
run_sync "$fresh_gitops" "$fresh_data"
cmp -s "$ROOT/flows/weather-flow.json" "$fresh_data/flows.json" || fail "fresh seed did not copy the weather flow bytes"
[ ! -e "$fresh_data/flows_cred.json" ] || fail "fresh seed created flows_cred.json"
node -e 'const p=require(process.argv[1]); const d=p.dependencies; if (!d["node-red-dashboard"] || !d["node-red-contrib-ui-led"] || !d["@digitaloak/node-red-contrib-digitaloak-postgresql"]) process.exit(1)' "$fresh_data/package.json" || fail "fresh package.json missing palette deps"
grep -q "npm install" "$NPM_LOG" || fail "fresh volume did not npm install"
grep -q "$fresh_data" "$NPM_LOG" || fail "npm install ran outside the data directory"
ok "empty volume seeds the weather flow and installs the palette"

# Existing volume: flows, credentials, extra palette packages, and version specs stay put.
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
        "node-red-dashboard": "~3.6.5",
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
cmp -s "$live_data/package.json" "$TMP/live-package.json" || fail "live package.json was rewritten"
[ ! -s "$NPM_LOG" ] || fail "npm ran even though every GitOps package was already installed"
ok "existing flows, credentials, and installed packages are left in place"

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
if (deps["node-red-dashboard"] !== "~3.6.5") process.exit(1);
if (deps["node-red-contrib-extra"] !== "1.2.3") process.exit(1);
if (deps["node-red-contrib-ui-led"] !== "~0.4.11") process.exit(1);
if (deps["@digitaloak/node-red-contrib-digitaloak-postgresql"] !== "0.3.2") process.exit(1);
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

echo "all node-red gitops sync tests passed"
