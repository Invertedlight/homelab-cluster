import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const sandbox = {};
sandbox.globalThis = sandbox;
vm.runInNewContext(
  fs.readFileSync(new URL("../extension/color.js", import.meta.url), "utf8"),
  sandbox,
);
const { PALETTE, STRIP, hostKey, autoColor, normalizeHex, textOn, resolveChoice } = sandbox.TabShadeColor;

test("hostKey drops www, case, and a trailing dot", () => {
  assert.equal(hostKey("WWW.GitHub.com."), "github.com");
  assert.equal(hostKey("mail.google.com"), "mail.google.com");
  assert.equal(hostKey(""), "");
  assert.equal(hostKey(null), "");
});

test("autoColor is stable and stays inside the palette", () => {
  assert.equal(autoColor("GitHub.com"), autoColor("www.github.com"));
  assert.ok(PALETTE.includes(autoColor("github.com")));
  const hosts = ["github.com", "news.ycombinator.com", "apple.com", "example.com", "nytimes.com", "bbc.co.uk", "reddit.com", "wikipedia.org", "maps.google.com", "mail.google.com", "developer.mozilla.org", "stackoverflow.com"];
  const colors = new Set(hosts.map((host) => autoColor(host)));
  assert.ok(colors.size >= 8);
});

test("normalizeHex accepts short and long hex and rejects anything else", () => {
  assert.equal(normalizeHex("#abc"), "#aabbcc");
  assert.equal(normalizeHex("ABC"), "#aabbcc");
  assert.equal(normalizeHex("  #A1B2C3 "), "#a1b2c3");
  assert.equal(normalizeHex("#abcd"), null);
  assert.equal(normalizeHex("red"), null);
  assert.equal(normalizeHex("#12"), null);
  assert.equal(normalizeHex("#aabbcc; background:url(x)"), null);
  assert.equal(normalizeHex(""), null);
});

test("textOn picks ink that stays readable on the fill", () => {
  assert.equal(textOn("#ffffff"), "#1c1c1e");
  assert.equal(textOn("#112233"), "#ffffff");
  assert.equal(textOn("nope"), "#ffffff");
});

test("resolveChoice prefers a tab color, then the site, then the automatic color", () => {
  const off = resolveChoice({ enabled: false, host: "github.com", hostEntry: null, tabColor: "#112233" });
  assert.equal(off.source, "disabled");
  assert.equal(off.color, null);

  const tab = resolveChoice({
    enabled: true,
    host: "github.com",
    hostEntry: { mode: "off" },
    tabColor: "#abc",
  });
  assert.deepEqual({ color: tab.color, source: tab.source }, { color: "#aabbcc", source: "tab" });

  const custom = resolveChoice({
    enabled: true,
    host: "www.github.com",
    hostEntry: { mode: "custom", color: "#123456" },
    tabColor: null,
  });
  assert.equal(custom.host, "github.com");
  assert.equal(custom.source, "custom");

  const siteOff = resolveChoice({
    enabled: true,
    host: "github.com",
    hostEntry: { mode: "off" },
    tabColor: null,
  });
  assert.equal(siteOff.source, "off");

  const auto = resolveChoice({ enabled: true, host: "github.com" });
  assert.equal(auto.source, "auto");
  assert.equal(auto.color, autoColor("github.com"));

  const unsupported = resolveChoice({ enabled: true, host: "" });
  assert.equal(unsupported.source, "unsupported");
});

test("the Safari 26 sampler strip covers WebKit's sample point and minimum box", () => {
  assert.ok(STRIP.height >= STRIP.minBox);
  assert.ok(STRIP.top <= STRIP.samplePoint);
  assert.ok(STRIP.top + STRIP.height >= STRIP.samplePoint + 2);
});
