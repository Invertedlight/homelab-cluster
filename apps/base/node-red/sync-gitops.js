// Seed an empty Node-RED user directory from the GitOps mount.
//
// The Longhorn volume remains the runtime copy. This script:
// - copies a flow export to flows.json only when that file is absent
// - sets each Git palette dependency to the committed range
// - asks for npm install when a listed package is missing, or the installed
//   version does not satisfy that range
// - leaves packages that are not listed in Git untouched
// - writes nothing except flows.json (when absent) and package.json (when a
//   listed spec changes)
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

// npm semver 7 range rules for the operators palette/package.json may contain
// (~, ^, exact, comparators, x-ranges, hyphen ranges, and ||). A version or
// range that cannot be evaluated does not satisfy, so the caller runs
// npm install instead of leaving a stale module in place.
function isPrereleaseId(id) {
  return /^(?:0|[1-9]\d*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)$/.test(id);
}

function isWild(id) {
  return id == null || id === "" || id === "*" || id.toLowerCase() === "x";
}

function parseVersion(input) {
  if (typeof input !== "string") {
    return null;
  }
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
    input
  );
  if (!match) {
    return null;
  }
  const prerelease = match[4] ? match[4].split(".") : [];
  if (!prerelease.every(isPrereleaseId)) {
    return null;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: prerelease,
  };
}

function parsePartial(input) {
  let trimmed = String(input).trim();
  if (trimmed.charAt(0) === "v") {
    trimmed = trimmed.slice(1);
  }
  if (trimmed === "*" || trimmed === "x" || trimmed === "X") {
    return { major: "*", minor: null, patch: null, prerelease: null };
  }
  const match = /^(0|[1-9]\d*|x|X|\*)(?:\.(0|[1-9]\d*|x|X|\*)(?:\.(0|[1-9]\d*|x|X|\*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?)?)?$/.exec(
    trimmed
  );
  if (!match) {
    return null;
  }
  const prerelease = match[4] || null;
  if (prerelease && !prerelease.split(".").every(isPrereleaseId)) {
    return null;
  }
  const parts = { major: match[1], minor: match[2] || null, patch: match[3] || null, prerelease: prerelease };
  if (isWild(parts.major) && parts.minor != null && !isWild(parts.minor)) {
    return null;
  }
  if (isWild(parts.minor) && parts.patch != null && !isWild(parts.patch)) {
    return null;
  }
  if (prerelease && (isWild(parts.major) || isWild(parts.minor) || isWild(parts.patch) || parts.patch == null)) {
    return null;
  }
  return parts;
}

function concrete(major, minor, patch, prerelease) {
  const version = {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: prerelease ? String(prerelease).split(".") : [],
  };
  if (!Number.isInteger(version.major) || !Number.isInteger(version.minor) || !Number.isInteger(version.patch)) {
    throw new Error("bad version");
  }
  if (!version.prerelease.every(isPrereleaseId)) {
    throw new Error("bad prerelease");
  }
  return version;
}

function partialToVersion(parts) {
  return concrete(parts.major, parts.minor, parts.patch, parts.prerelease);
}

function comparator(op, version) {
  return { op: op, version: version };
}

function compareIdentifiers(left, right) {
  const leftNum = /^(?:0|[1-9]\d*)$/.test(left);
  const rightNum = /^(?:0|[1-9]\d*)$/.test(right);
  if (leftNum && rightNum) {
    return left === right ? 0 : Number(left) < Number(right) ? -1 : 1;
  }
  if (leftNum) {
    return -1;
  }
  if (rightNum) {
    return 1;
  }
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function compareVersions(left, right) {
  if (left.major !== right.major) {
    return left.major < right.major ? -1 : 1;
  }
  if (left.minor !== right.minor) {
    return left.minor < right.minor ? -1 : 1;
  }
  if (left.patch !== right.patch) {
    return left.patch < right.patch ? -1 : 1;
  }
  if (left.prerelease.length === 0 && right.prerelease.length === 0) {
    return 0;
  }
  if (left.prerelease.length === 0) {
    return 1;
  }
  if (right.prerelease.length === 0) {
    return -1;
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let i = 0; i < length; i++) {
    if (i >= left.prerelease.length) {
      return -1;
    }
    if (i >= right.prerelease.length) {
      return 1;
    }
    const diff = compareIdentifiers(left.prerelease[i], right.prerelease[i]);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

function comparatorMatches(entry, version) {
  const diff = compareVersions(version, entry.version);
  if (entry.op === "=") {
    return diff === 0;
  }
  if (entry.op === ">") {
    return diff > 0;
  }
  if (entry.op === ">=") {
    return diff >= 0;
  }
  if (entry.op === "<") {
    return diff < 0;
  }
  if (entry.op === "<=") {
    return diff <= 0;
  }
  return false;
}

function testComparatorSet(set, version) {
  for (let i = 0; i < set.length; i++) {
    if (!comparatorMatches(set[i], version)) {
      return false;
    }
  }
  if (version.prerelease.length === 0) {
    return true;
  }
  for (let i = 0; i < set.length; i++) {
    const allowed = set[i].version;
    if (
      allowed.prerelease.length > 0 &&
      allowed.major === version.major &&
      allowed.minor === version.minor &&
      allowed.patch === version.patch
    ) {
      return true;
    }
  }
  return false;
}

function tildeComparators(body) {
  const parts = parsePartial(body);
  if (!parts) {
    return null;
  }
  if (isWild(parts.major)) {
    return [];
  }
  if (isWild(parts.minor)) {
    return [
      comparator(">=", concrete(parts.major, 0, 0)),
      comparator("<", concrete(Number(parts.major) + 1, 0, 0, "0")),
    ];
  }
  if (isWild(parts.patch)) {
    return [
      comparator(">=", concrete(parts.major, parts.minor, 0)),
      comparator("<", concrete(parts.major, Number(parts.minor) + 1, 0, "0")),
    ];
  }
  return [
    comparator(">=", partialToVersion(parts)),
    comparator("<", concrete(parts.major, Number(parts.minor) + 1, 0, "0")),
  ];
}

function caretComparators(body) {
  const parts = parsePartial(body);
  if (!parts) {
    return null;
  }
  if (isWild(parts.major)) {
    return [];
  }
  if (isWild(parts.minor)) {
    return [
      comparator(">=", concrete(parts.major, 0, 0)),
      comparator("<", concrete(Number(parts.major) + 1, 0, 0, "0")),
    ];
  }
  if (isWild(parts.patch)) {
    if (parts.major === "0") {
      return [
        comparator(">=", concrete(parts.major, parts.minor, 0)),
        comparator("<", concrete(parts.major, Number(parts.minor) + 1, 0, "0")),
      ];
    }
    return [
      comparator(">=", concrete(parts.major, parts.minor, 0)),
      comparator("<", concrete(Number(parts.major) + 1, 0, 0, "0")),
    ];
  }
  const lower = partialToVersion(parts);
  if (parts.major === "0") {
    if (parts.minor === "0") {
      return [comparator(">=", lower), comparator("<", concrete(parts.major, parts.minor, Number(parts.patch) + 1, "0"))];
    }
    return [comparator(">=", lower), comparator("<", concrete(parts.major, Number(parts.minor) + 1, 0, "0"))];
  }
  return [comparator(">=", lower), comparator("<", concrete(Number(parts.major) + 1, 0, 0, "0"))];
}

function expandWildcard(op, parts) {
  let major = parts.major;
  let minor = parts.minor;
  let patch = parts.patch;
  const wildMajor = isWild(major);
  const wildMinor = wildMajor || isWild(minor);
  const wildPatch = wildMinor || isWild(patch);
  if (wildMajor) {
    if (op === ">" || op === "<") {
      return [comparator("<", concrete(0, 0, 0, "0"))];
    }
    return [];
  }
  if (op !== "=" && wildPatch) {
    if (wildMinor) {
      minor = "0";
    }
    patch = "0";
    if (op === ">") {
      op = ">=";
      if (wildMinor) {
        major = String(Number(major) + 1);
        minor = "0";
        patch = "0";
      } else {
        minor = String(Number(minor) + 1);
        patch = "0";
      }
    } else if (op === "<=") {
      op = "<";
      if (wildMinor) {
        major = String(Number(major) + 1);
        minor = "0";
        patch = "0";
      } else {
        minor = String(Number(minor) + 1);
        patch = "0";
      }
    }
    if (op === "<") {
      return [comparator("<", concrete(major, minor, patch, "0"))];
    }
    return [comparator(op, concrete(major, minor, patch))];
  }
  if (wildMinor) {
    return [
      comparator(">=", concrete(major, 0, 0)),
      comparator("<", concrete(Number(major) + 1, 0, 0, "0")),
    ];
  }
  return [
    comparator(">=", concrete(major, minor, 0)),
    comparator("<", concrete(major, Number(minor) + 1, 0, "0")),
  ];
}

function expandToken(token) {
  if (token === "*" || token === "x" || token === "X") {
    return [];
  }
  if (token.charAt(0) === "~") {
    return tildeComparators(token.replace(/^~>?/, ""));
  }
  if (token.charAt(0) === "^") {
    return caretComparators(token.slice(1));
  }
  const opMatch = /^(>=|<=|>|<|=)(.+)$/.exec(token);
  let op = "=";
  let rest = token;
  if (opMatch) {
    op = opMatch[1];
    rest = opMatch[2];
  }
  if (rest === "*" || rest === "x" || rest === "X") {
    if (op === ">" || op === "<") {
      return [comparator("<", concrete(0, 0, 0, "0"))];
    }
    return [];
  }
  const parts = parsePartial(rest);
  if (!parts) {
    return null;
  }
  if (isWild(parts.major) || isWild(parts.minor) || isWild(parts.patch) || parts.minor == null || parts.patch == null) {
    return expandWildcard(op, parts);
  }
  return [comparator(op, partialToVersion(parts))];
}

function hyphenTokens(part) {
  const match = /^(\S+)\s+-\s+(\S+)$/.exec(part);
  if (!match) {
    return null;
  }
  const from = parsePartial(match[1]);
  const to = parsePartial(match[2]);
  if (!from || !to) {
    return null;
  }
  const tokens = [];
  if (!isWild(from.major)) {
    if (isWild(from.minor)) {
      tokens.push(">=" + from.major + ".0.0");
    } else if (isWild(from.patch)) {
      tokens.push(">=" + from.major + "." + from.minor + ".0");
    } else {
      tokens.push(">=" + match[1].replace(/^v/, ""));
    }
  }
  if (!isWild(to.major)) {
    if (isWild(to.minor)) {
      tokens.push("<" + String(Number(to.major) + 1) + ".0.0-0");
    } else if (isWild(to.patch)) {
      tokens.push("<" + to.major + "." + String(Number(to.minor) + 1) + ".0-0");
    } else if (to.prerelease) {
      tokens.push("<=" + to.major + "." + to.minor + "." + to.patch + "-" + to.prerelease);
    } else {
      tokens.push("<=" + match[2].replace(/^v/, ""));
    }
  }
  return tokens;
}

function compileAnd(part) {
  const normalized = part
    .replace(/~\s+/g, "~")
    .replace(/\^\s+/g, "^")
    .replace(/(>=|<=|>|<|=)\s+/g, "$1");
  const hyphen = hyphenTokens(normalized);
  const tokens = hyphen || normalized.split(" ").filter(Boolean);
  const comparators = [];
  for (let i = 0; i < tokens.length; i++) {
    const expanded = expandToken(tokens[i]);
    if (expanded == null) {
      return null;
    }
    for (let j = 0; j < expanded.length; j++) {
      comparators.push(expanded[j]);
    }
  }
  return comparators;
}

function compileRange(range) {
  if (typeof range !== "string" || range.trim() === "") {
    return null;
  }
  const parts = range
    .trim()
    .replace(/\s+/g, " ")
    .split("||")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) {
    return null;
  }
  const sets = [];
  for (let i = 0; i < parts.length; i++) {
    const set = compileAnd(parts[i]);
    // An empty list is the "*" range. null means the text did not parse.
    if (set == null) {
      return null;
    }
    sets.push(set);
  }
  return sets;
}

function versionSatisfies(version, range) {
  try {
    const parsed = parseVersion(version);
    if (!parsed) {
      return false;
    }
    const sets = compileRange(range);
    if (!sets) {
      return false;
    }
    for (let i = 0; i < sets.length; i++) {
      if (testComparatorSet(sets[i], parsed)) {
        return true;
      }
    }
    return false;
  } catch (err) {
    return false;
  }
}

function applyPalette(state, desired) {
  let needsInstall = false;
  let changedSpec = false;
  for (const [name, spec] of Object.entries(desired)) {
    const hasRecorded = Object.prototype.hasOwnProperty.call(state.current.dependencies, name);
    const recorded = hasRecorded ? state.current.dependencies[name] : undefined;
    if (recorded !== spec) {
      state.current.dependencies[name] = spec;
      changedSpec = true;
    }
    const installed = installedVersion(name);
    if (!installed || !versionSatisfies(installed, spec)) {
      needsInstall = true;
      if (!installed) {
        console.error("sync-gitops: " + name + " is missing; npm will install " + spec);
      } else {
        console.error(
          "sync-gitops: " + name + "@" + installed + " does not satisfy " + spec + "; npm will install"
        );
      }
    } else if (recorded !== spec) {
      console.error("sync-gitops: " + name + "@" + installed + " satisfies " + spec + "; recording " + spec);
    } else {
      console.error("sync-gitops: " + name + "@" + installed + " satisfies " + spec);
    }
  }
  if (changedSpec) {
    const tmp = state.pkgPath + ".gitops-tmp";
    fs.writeFileSync(tmp, JSON.stringify(state.current, null, 2) + "\n");
    fs.renameSync(tmp, state.pkgPath);
  }
  return needsInstall ? "install" : "skip";
}

function main() {
  if (!gitopsDir || !dataDir) {
    fail("GITOPS_DIR and DATA_DIR are required");
  }
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

// Exported for test-sync-gitops.sh. The pod runs this file as a script.
module.exports = { versionSatisfies: versionSatisfies };

if (require.main === module) {
  main();
}
