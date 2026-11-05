// Seed an empty Node-RED user directory from the GitOps mount.
//
// The Longhorn volume remains the runtime copy. This script:
// - copies a flow export to flows.json only when that file is absent
// - adds palette dependencies only when the package is missing from node_modules
// - leaves an existing dependency spec and an already-installed version alone
// - writes nothing except flows.json (when absent) and package.json (when a
//   missing package needs a spec)
// flows_cred.json is never read or written. Credentials stay on the volume.
"use strict";

const fs = require("fs");
const path = require("path");

const gitopsDir = process.env.GITOPS_DIR;
const dataDir = process.env.DATA_DIR;

function fail(message) {
  console.error("sync-gitops: " + message);
  process.exit(1);
}

if (!gitopsDir || !dataDir) {
  fail("GITOPS_DIR and DATA_DIR are required");
}

const RANGE = /^[0-9A-Za-z.*^~<>=| xX-]+$/;
const SECRET_KEY = /^(password|passwd|secret|token|apikey|api_key|credential|credentialsecret|access_token|refresh_token|authorization)$/i;
const SKIP_JSON = new Set(["package.json", "package-lock.json"]);

function readJson(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    fail("cannot read " + file + ": " + err.message);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    fail(file + " is not valid JSON: " + err.message);
  }
}

function assertPackageName(name) {
  const scoped = /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/i;
  const plain = /^[a-z0-9][a-z0-9._-]*$/i;
  if (name.startsWith("@") ? !scoped.test(name) : !plain.test(name)) {
    fail("invalid palette package name: " + name);
  }
}

function assertNoSecrets(value, where) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecrets(item, where + "[" + index + "]"));
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === "credentials") {
      if (child && typeof child === "object" && !Array.isArray(child) && Object.keys(child).length > 0) {
        fail(where + " has non-empty credentials. Keep those in flows_cred.json on the volume.");
      }
      continue;
    }
    if (SECRET_KEY.test(key) && child !== "" && child != null) {
      fail(where + " has a " + key + " field. Flow exports in Git stay free of secrets.");
    }
    assertNoSecrets(child, where + "." + key);
  }
}

function loadPalette() {
  const file = path.join(gitopsDir, "package.json");
  if (!fs.existsSync(file)) {
    fail("missing " + file);
  }
  const doc = readJson(file);
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    fail(file + " must be a JSON object");
  }
  const dependencies = doc.dependencies;
  if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) {
    fail(file + " must contain a dependencies object");
  }
  for (const [name, spec] of Object.entries(dependencies)) {
    assertPackageName(name);
    if (typeof spec !== "string" || spec.length === 0 || !RANGE.test(spec)) {
      fail("palette spec for " + name + " must be a version range, not a URL or git repository");
    }
  }
  return dependencies;
}

function flowSourceNames() {
  let names;
  try {
    names = fs.readdirSync(gitopsDir);
  } catch (err) {
    fail("cannot read " + gitopsDir + ": " + err.message);
  }
  const jsonNames = names.filter((name) => name.endsWith(".json") && !SKIP_JSON.has(name)).sort();
  if (jsonNames.length === 0) {
    fail("no flow exports (*.json) in " + gitopsDir);
  }
  const chosen = jsonNames.includes("flows.json") ? ["flows.json"] : jsonNames;
  return { chosen, all: jsonNames };
}

function loadFlowFile(name) {
  const nodes = readJson(path.join(gitopsDir, name));
  if (!Array.isArray(nodes)) {
    fail(name + " must be a Node-RED flow export (a JSON array)");
  }
  const seen = new Set();
  for (const node of nodes) {
    if (!node || typeof node !== "object" || Array.isArray(node)) {
      fail(name + " contains an item that is not a node object");
    }
    if (typeof node.id !== "string" || node.id.length === 0) {
      fail(name + " contains a node without an id");
    }
    if (typeof node.type !== "string" || node.type.length === 0) {
      fail(name + " node " + node.id + " has no type");
    }
    if (seen.has(node.id)) {
      fail(name + " contains duplicate id " + node.id);
    }
    seen.add(node.id);
    assertNoSecrets(node, name + ":" + node.id);
  }
  return nodes;
}

function installedVersion(name) {
  const pkg = path.join(dataDir, "node_modules", name, "package.json");
  if (!fs.existsSync(pkg)) {
    return null;
  }
  try {
    const doc = JSON.parse(fs.readFileSync(pkg, "utf8"));
    if (!doc || typeof doc.version !== "string" || doc.version.length === 0) {
      return null;
    }
    return doc.version;
  } catch (err) {
    console.error("sync-gitops: ignoring unreadable " + pkg + ": " + err.message);
    return null;
  }
}

function inspectDataPackage() {
  const pkgPath = path.join(dataDir, "package.json");
  if (!fs.existsSync(dataDir) || !fs.statSync(dataDir).isDirectory()) {
    fail(dataDir + " is not a directory");
  }
  if (!fs.existsSync(pkgPath)) {
    return {
      pkgPath,
      exists: false,
      current: {
        name: "node-red-project",
        version: "0.0.1",
        private: true,
        dependencies: {},
      },
    };
  }
  let text;
  try {
    text = fs.readFileSync(pkgPath, "utf8");
  } catch (err) {
    fail("cannot read " + pkgPath + ": " + err.message);
  }
  let current;
  try {
    current = JSON.parse(text);
  } catch (err) {
    fail(pkgPath + " is not valid JSON, so it was left unchanged: " + err.message);
  }
  if (!current || typeof current !== "object" || Array.isArray(current)) {
    fail(pkgPath + " must be a JSON object, so it was left unchanged");
  }
  if (current.dependencies == null) {
    current.dependencies = {};
  }
  if (typeof current.dependencies !== "object" || Array.isArray(current.dependencies)) {
    fail(pkgPath + " dependencies must be an object, so the file was left unchanged");
  }
  return { pkgPath, exists: true, current };
}

function seedFlows(chosen, loaded) {
  const dest = path.join(dataDir, "flows.json");
  if (fs.existsSync(dest)) {
    console.error("sync-gitops: keeping existing flows.json");
    return;
  }
  const tmp = dest + ".gitops-tmp";
  if (chosen.length === 1) {
    fs.copyFileSync(path.join(gitopsDir, chosen[0]), tmp);
    fs.renameSync(tmp, dest);
    console.error(
      "sync-gitops: seeded flows.json from " + chosen[0] + " (" + loaded.get(chosen[0]).length + " nodes)"
    );
    return;
  }
  const byId = new Map();
  const order = [];
  for (const name of chosen) {
    for (const node of loaded.get(name)) {
      const serialized = JSON.stringify(node);
      const prev = byId.get(node.id);
      if (prev && prev.serialized !== serialized) {
        fail(
          "flow id " +
            node.id +
            " differs between " +
            prev.name +
            " and " +
            name +
            ". Commit one full export as flows.json and remove the overlapping file."
        );
      }
      if (!prev) {
        order.push(node.id);
        byId.set(node.id, { serialized, name, node });
      }
    }
  }
  const merged = order.map((id) => byId.get(id).node);
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2) + "\n");
  fs.renameSync(tmp, dest);
  console.error("sync-gitops: seeded flows.json from " + chosen.join(", ") + " (" + merged.length + " nodes)");
}

function applyPalette(state, desired) {
  let missingModule = false;
  let addedSpec = false;
  for (const [name, spec] of Object.entries(desired)) {
    const installed = installedVersion(name);
    if (installed) {
      if (!Object.prototype.hasOwnProperty.call(state.current.dependencies, name)) {
        // Pin the copy already on the volume so npm does not treat it as extraneous.
        state.current.dependencies[name] = installed;
        addedSpec = true;
        console.error("sync-gitops: " + name + "@" + installed + " is installed; recording that version");
      } else {
        console.error("sync-gitops: " + name + "@" + installed + " already installed");
      }
      continue;
    }
    missingModule = true;
    if (!Object.prototype.hasOwnProperty.call(state.current.dependencies, name)) {
      state.current.dependencies[name] = spec;
      addedSpec = true;
      console.error("sync-gitops: recording missing palette package " + name + "@" + spec);
    } else {
      console.error(
        "sync-gitops: " + name + " is missing from node_modules; npm will use " + state.current.dependencies[name]
      );
    }
  }
  if (addedSpec) {
    const tmp = state.pkgPath + ".gitops-tmp";
    fs.writeFileSync(tmp, JSON.stringify(state.current, null, 2) + "\n");
    fs.renameSync(tmp, state.pkgPath);
  }
  return missingModule ? "install" : "skip";
}

function main() {
  const desired = loadPalette();
  const sources = flowSourceNames();
  const loaded = new Map();
  for (const name of sources.all) {
    loaded.set(name, loadFlowFile(name));
  }
  const packageState = inspectDataPackage();
  seedFlows(sources.chosen, loaded);
  const action = applyPalette(packageState, desired);
  process.stdout.write(action + "\n");
}

main();
