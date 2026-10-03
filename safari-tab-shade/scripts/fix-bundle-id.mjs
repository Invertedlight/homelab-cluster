import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const EXTENSION_SUFFIX = ".Extension";

function unwrap(raw) {
  const value = raw.trim();
  if (value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1);
  return value;
}

function quoteId(id) {
  return /^[A-Za-z0-9._]+$/.test(id) ? id : `"${id}"`;
}

function findMatchingBrace(content, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < content.length; i += 1) {
    const ch = content[i];
    if (ch === '"') {
      i += 1;
      while (i < content.length && content[i] !== '"') {
        if (content[i] === "\\") i += 1;
        i += 1;
      }
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  throw new Error("Unbalanced braces in project.pbxproj");
}

function parsePbxObjects(content) {
  const objects = [];
  const startRe = /^[ \t]*([A-Fa-f0-9]{24})(?: \/\* ([^*]*) \*\/)? = \{/gm;
  let match = startRe.exec(content);
  while (match) {
    const open = match.index + match[0].length - 1;
    const close = findMatchingBrace(content, open);
    objects.push({
      id: match[1],
      comment: match[2] || "",
      open,
      close,
      body: content.slice(open + 1, close),
    });
    startRe.lastIndex = close + 1;
    match = startRe.exec(content);
  }
  return objects;
}

function field(body, name) {
  const match = body.match(new RegExp(`^[ \\t]*${name} = ([^;\\n]+);`, "m"));
  return match ? unwrap(match[1]) : null;
}

function refId(value) {
  if (!value) return null;
  const match = value.match(/[A-Fa-f0-9]{24}/);
  return match ? match[0] : null;
}

function listIds(body, name) {
  const match = body.match(new RegExp(`${name} = \\(([\\s\\S]*?)\\);`));
  if (!match) return [];
  return [...match[1].matchAll(/[A-Fa-f0-9]{24}/g)].map((item) => item[0]);
}

export function extractBundleIds(content) {
  return [...content.matchAll(/PRODUCT_BUNDLE_IDENTIFIER = ("[^"]*"|[^;\n]+);/g)].map((match) => unwrap(match[1]));
}

function idForProductType(productType, appId) {
  if (productType === "com.apple.product-type.application") return appId;
  if (productType === "com.apple.product-type.app-extension") return `${appId}${EXTENSION_SUFFIX}`;
  return null;
}

export function rewriteProjectBundleIds(content, appId) {
  if (typeof appId !== "string" || !/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(appId)) {
    throw new Error(`Invalid bundle id ${appId}`);
  }
  const objects = parsePbxObjects(content);
  if (objects.length === 0) throw new Error("No objects in project.pbxproj");
  const byId = new Map(objects.map((object) => [object.id, object]));
  const targets = objects.filter((object) => field(object.body, "isa") === "PBXNativeTarget");
  if (targets.length === 0) throw new Error("No PBXNativeTarget in project.pbxproj");

  const replacements = [];
  let sawApp = false;
  let sawExtension = false;

  for (const target of targets) {
    const productType = field(target.body, "productType");
    const nextId = idForProductType(productType, appId);
    if (!nextId) continue;
    if (productType === "com.apple.product-type.application") sawApp = true;
    if (productType === "com.apple.product-type.app-extension") sawExtension = true;

    const list = byId.get(refId(field(target.body, "buildConfigurationList")));
    const label = target.comment || target.id;
    if (!list) throw new Error(`Missing build configuration list for ${label}`);
    const configIds = listIds(list.body, "buildConfigurations");
    if (configIds.length === 0) throw new Error(`No build configurations for ${label}`);

    for (const configId of configIds) {
      const config = byId.get(configId);
      if (!config) throw new Error(`Missing build configuration ${configId} for ${label}`);
      const line = config.body.match(/^([ \t]*)PRODUCT_BUNDLE_IDENTIFIER = (?:"[^"]*"|[^;\n]+);/m);
      if (!line) throw new Error(`${label} has no PRODUCT_BUNDLE_IDENTIFIER`);
      const start = config.open + 1 + line.index;
      replacements.push({
        start,
        end: start + line[0].length,
        text: `${line[1]}PRODUCT_BUNDLE_IDENTIFIER = ${quoteId(nextId)};`,
      });
    }
  }

  if (!sawApp || !sawExtension) {
    throw new Error("project.pbxproj needs both an application target and an app-extension target");
  }

  let next = content;
  replacements.sort((a, b) => b.start - a.start);
  for (const replacement of replacements) {
    next = next.slice(0, replacement.start) + replacement.text + next.slice(replacement.end);
  }

  const ids = extractBundleIds(next);
  assertBundlePrefix(ids, appId);
  return { content: next, ids };
}

export function assertBundlePrefix(ids, appId) {
  const unique = [...new Set(ids)];
  const bad = unique.filter((id) => id !== appId && !id.startsWith(`${appId}.`));
  const hasApp = unique.includes(appId);
  const hasChild = unique.some((id) => id.startsWith(`${appId}.`));
  if (hasApp && hasChild && bad.length === 0) return unique;
  const lines = [
    `Bundle ids do not share the parent prefix ${appId}.`,
    "Xcode will fail with: Embedded binary's bundle identifier is not prefixed with the parent app's bundle identifier.",
    `Found: ${unique.join(", ") || "(none)"}`,
  ];
  if (bad.length) lines.push(`Not prefixed by ${appId}: ${bad.join(", ")}`);
  if (!hasApp) lines.push(`Missing parent id ${appId}.`);
  if (!hasChild) lines.push(`Missing an embedded id starting with ${appId}.`);
  throw new Error(lines.join("\n"));
}

export function replaceBundleIdLiterals(text, oldIds, appId) {
  const ordered = [...new Set(oldIds)].sort((a, b) => b.length - a.length);
  let next = text;
  for (const oldId of ordered) {
    if (!oldId || oldId === appId || oldId.startsWith(`${appId}.`)) continue;
    const replacement = /\.Extension$/i.test(oldId) ? `${appId}${EXTENSION_SUFFIX}` : appId;
    next = next.split(oldId).join(replacement);
  }
  return next;
}

const TEXT_EXTENSIONS = new Set([
  ".swift",
  ".plist",
  ".pbxproj",
  ".entitlements",
  ".storyboard",
  ".xcscheme",
  ".xcconfig",
  ".xml",
  ".json",
  ".strings",
  ".h",
  ".m",
]);

function walkTextFiles(dir, files) {
  const found = files || [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "xcuserdata" || entry.name === "project.xcworkspace") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkTextFiles(full, found);
    else if (TEXT_EXTENSIONS.has(path.extname(entry.name))) found.push(full);
  }
  return found;
}

function pbxprojPath(input) {
  const resolved = path.resolve(input);
  if (resolved.endsWith(".pbxproj")) return resolved;
  if (resolved.endsWith(".xcodeproj")) return path.join(resolved, "project.pbxproj");
  throw new Error(`Expected an .xcodeproj or project.pbxproj path, got ${input}`);
}

function projectRoot(pbx) {
  return path.dirname(path.dirname(pbx));
}

export function fixBundleIds(projectPath, appId) {
  const pbx = pbxprojPath(projectPath);
  const original = fs.readFileSync(pbx, "utf8");
  const oldIds = extractBundleIds(original);
  const rewritten = rewriteProjectBundleIds(original, appId);
  fs.writeFileSync(pbx, rewritten.content);

  const root = projectRoot(pbx);
  for (const file of walkTextFiles(root)) {
    const before = fs.readFileSync(file, "utf8");
    const after = replaceBundleIdLiterals(before, oldIds, appId);
    if (after !== before) fs.writeFileSync(file, after);
  }

  const leftovers = [];
  const team = appId.split(".").slice(0, 2).join(".");
  const pattern = new RegExp(`${team.replace(/\./g, "\\.")}\\.[A-Za-z0-9.-]+`, "g");
  for (const file of walkTextFiles(root)) {
    const text = fs.readFileSync(file, "utf8");
    for (const match of text.matchAll(pattern)) {
      const id = match[0];
      if (id !== appId && !id.startsWith(`${appId}.`)) leftovers.push(`${path.relative(root, file)}: ${id}`);
    }
  }
  if (leftovers.length) {
    throw new Error(
      `Bundle ids still do not share the prefix ${appId}:\n${leftovers.join("\n")}`,
    );
  }

  const ids = extractBundleIds(fs.readFileSync(pbx, "utf8"));
  assertBundlePrefix(ids, appId);
  return { ids, pbx };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const project = process.argv[2];
  const appId = process.argv[3];
  if (!project || !appId) {
    console.error("Usage: fix-bundle-id.mjs <project.xcodeproj> <app-bundle-id>");
    process.exit(1);
  }
  try {
    const result = fixBundleIds(project, appId);
    console.log(`Bundle ids share the prefix ${appId}: ${[...new Set(result.ids)].join(", ")}`);
  } catch (error) {
    console.error(error && error.message ? error.message : error);
    process.exit(1);
  }
}
