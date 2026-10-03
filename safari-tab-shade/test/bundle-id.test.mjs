import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { applyAppleSigning, assertBundlePrefix, fixBundleIds, rewriteProjectBundleIds } from "../scripts/fix-bundle-id.mjs";

const APP = "AAAAAAAAAAAAAAAAAAAAAAAA";
const EXTENSION = "BBBBBBBBBBBBBBBBBBBBBBBB";
const APP_LIST = "CCCCCCCCCCCCCCCCCCCCCCCC";
const EXTENSION_LIST = "DDDDDDDDDDDDDDDDDDDDDDDD";
const APP_DEBUG = "EEEEEEEEEEEEEEEEEEEEEEE1";
const APP_RELEASE = "EEEEEEEEEEEEEEEEEEEEEEE2";
const EXTENSION_DEBUG = "FFFFFFFFFFFFFFFFFFFFFFF1";
const EXTENSION_RELEASE = "FFFFFFFFFFFFFFFFFFFFFFF2";

function project(appId, extensionId) {
  const quote = (id) => (/^[A-Za-z0-9._]+$/.test(id) ? id : `"${id}"`);
  return `// !$*UTF8*$!
{
	objects = {
		${APP} /* Tab Shade */ = {
			isa = PBXNativeTarget;
			buildConfigurationList = ${APP_LIST} /* Build configuration list for PBXNativeTarget "Tab Shade" */;
			name = "Tab Shade";
			productType = "com.apple.product-type.application";
		};
		${EXTENSION} /* Tab Shade Extension */ = {
			isa = PBXNativeTarget;
			buildConfigurationList = ${EXTENSION_LIST} /* Build configuration list for PBXNativeTarget "Tab Shade Extension" */;
			name = "Tab Shade Extension";
			productType = "com.apple.product-type.app-extension";
		};
		${APP_DEBUG} /* Debug */ = {
			isa = XCBuildConfiguration;
			buildSettings = {
				PRODUCT_BUNDLE_IDENTIFIER = ${quote(appId)};
				PRODUCT_NAME = "$(TARGET_NAME)";
			};
			name = Debug;
		};
		${APP_RELEASE} /* Release */ = {
			isa = XCBuildConfiguration;
			buildSettings = {
				PRODUCT_BUNDLE_IDENTIFIER = ${quote(appId)};
				PRODUCT_NAME = "$(TARGET_NAME)";
			};
			name = Release;
		};
		${EXTENSION_DEBUG} /* Debug */ = {
			isa = XCBuildConfiguration;
			buildSettings = {
				PRODUCT_BUNDLE_IDENTIFIER = ${quote(extensionId)};
				PRODUCT_NAME = "$(TARGET_NAME)";
			};
			name = Debug;
		};
		${EXTENSION_RELEASE} /* Release */ = {
			isa = XCBuildConfiguration;
			buildSettings = {
				PRODUCT_BUNDLE_IDENTIFIER = ${quote(extensionId)};
				PRODUCT_NAME = "$(TARGET_NAME)";
			};
			name = Release;
		};
		${APP_LIST} /* Build configuration list for PBXNativeTarget "Tab Shade" */ = {
			isa = XCConfigurationList;
			buildConfigurations = (
				${APP_DEBUG} /* Debug */,
				${APP_RELEASE} /* Release */,
			);
			defaultConfigurationName = Release;
		};
		${EXTENSION_LIST} /* Build configuration list for PBXNativeTarget "Tab Shade Extension" */ = {
			isa = XCConfigurationList;
			buildConfigurations = (
				${EXTENSION_DEBUG} /* Debug */,
				${EXTENSION_RELEASE} /* Release */,
			);
			defaultConfigurationName = Release;
		};
	};
}
`;
}

test("macos-only packager ids are rewritten so the extension keeps the app prefix", () => {
  const mangled = project("com.invertedlight.Tab-Shade", "com.invertedlight.tabshade.Extension");
  const rewritten = rewriteProjectBundleIds(mangled, "com.invertedlight.tabshade");
  assert.deepEqual([...new Set(rewritten.ids)].sort(), [
    "com.invertedlight.tabshade",
    "com.invertedlight.tabshade.Extension",
  ]);
  assert.equal(rewritten.content.includes("Tab-Shade"), false);
  assertBundlePrefix(rewritten.ids, "com.invertedlight.tabshade");
});

test("a display-name suffix on both targets is replaced, not just the parent", () => {
  const mangled = project("com.invertedlight.Tab-Shade", "com.invertedlight.Tab-Shade.Extension");
  const rewritten = rewriteProjectBundleIds(mangled, "com.invertedlight.tabshade");
  assert.deepEqual([...new Set(rewritten.ids)].sort(), [
    "com.invertedlight.tabshade",
    "com.invertedlight.tabshade.Extension",
  ]);
});

test("an extension id with no suffix is given the app prefix", () => {
  const mangled = project("com.invertedlight.Tab-Shade", "com.invertedlight.tabshade");
  const rewritten = rewriteProjectBundleIds(mangled, "com.invertedlight.tabshade");
  assert.deepEqual([...new Set(rewritten.ids)].sort(), [
    "com.invertedlight.tabshade",
    "com.invertedlight.tabshade.Extension",
  ]);
  assertBundlePrefix(rewritten.ids, "com.invertedlight.tabshade");
});

test("Apple Developer team signing covers the Mac and marks iOS as iPhone and iPad", () => {
  const ios = "111111111111111111111111";
  const mac = "222222222222222222222222";
  const content = `
		${ios} /* Debug */ = {
			isa = XCBuildConfiguration;
			buildSettings = {
				CODE_SIGN_IDENTITY = "-";
				IPHONEOS_DEPLOYMENT_TARGET = 16.0;
				PRODUCT_BUNDLE_IDENTIFIER = com.invertedlight.tabshade;
				SDKROOT = iphoneos;
				TARGETED_DEVICE_FAMILY = 1;
			};
			name = Debug;
		};
		${mac} /* Debug */ = {
			isa = XCBuildConfiguration;
			buildSettings = {
				CODE_SIGN_IDENTITY = "-";
				MACOSX_DEPLOYMENT_TARGET = 14.0;
				PRODUCT_BUNDLE_IDENTIFIER = com.invertedlight.tabshade;
				SDKROOT = macosx;
			};
			name = Debug;
		};
`;
  const signed = applyAppleSigning(content, "ab12cd34ef");
  assert.equal(signed.team, "AB12CD34EF");
  assert.equal(signed.iosConfigs, 1);
  assert.equal(signed.content.includes('DEVELOPMENT_TEAM = AB12CD34EF;'), true);
  assert.equal(signed.content.includes("CODE_SIGN_STYLE = Automatic;"), true);
  assert.equal(signed.content.includes('CODE_SIGN_IDENTITY = "-"'), false);
  assert.equal(signed.content.includes('TARGETED_DEVICE_FAMILY = "1,2";'), true);
  assert.equal(signed.content.includes("SDKROOT = macosx;"), true);
  const macBlock = signed.content.slice(signed.content.indexOf(mac));
  assert.equal(macBlock.includes("TARGETED_DEVICE_FAMILY"), false);
  assert.throws(() => applyAppleSigning(content, "not-a-team"), /Team ID/);
});

test("bundle id check fails when the embedded id is not prefixed by the app", () => {
  assert.throws(
    () => assertBundlePrefix(
      ["com.invertedlight.Tab-Shade", "com.invertedlight.tabshade.Extension"],
      "com.invertedlight.tabshade",
    ),
    /not prefixed/,
  );
});

test("fixBundleIds rewrites the project and hardcoded Swift identifiers", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tab-shade-"));
  const xcodeproj = path.join(root, "Tab Shade.xcodeproj");
  fs.mkdirSync(xcodeproj);
  fs.writeFileSync(
    path.join(xcodeproj, "project.pbxproj"),
    project("com.invertedlight.Tab-Shade", "com.invertedlight.tabshade.Extension"),
  );
  fs.writeFileSync(
    path.join(root, "ViewController.swift"),
    [
      'let extensionBundleIdentifier = "com.invertedlight.tabshade.Extension"',
      'let appBundleIdentifier = "com.invertedlight.Tab-Shade"',
      "",
    ].join("\n"),
  );

  const result = fixBundleIds(xcodeproj, "com.invertedlight.tabshade");
  assert.deepEqual([...new Set(result.ids)].sort(), [
    "com.invertedlight.tabshade",
    "com.invertedlight.tabshade.Extension",
  ]);
  const swift = fs.readFileSync(path.join(root, "ViewController.swift"), "utf8");
  assert.equal(swift.includes("com.invertedlight.Tab-Shade"), false);
  assert.equal(swift.includes("com.invertedlight.tabshade.Extension"), true);
  assert.equal(swift.includes('let appBundleIdentifier = "com.invertedlight.tabshade"'), true);
});
