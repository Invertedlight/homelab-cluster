import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const sandbox = { URL, encodeURIComponent };
sandbox.globalThis = sandbox;
vm.runInNewContext(
  fs.readFileSync(new URL("../extension/color.js", import.meta.url), "utf8"),
  sandbox,
);
const {
  PALETTE,
  MARKERS,
  MARKER_SEP,
  STRIP,
  URL_MAP_LIMIT,
  hostKey,
  autoColor,
  normalizeHex,
  textOn,
  markerFor,
  applyTitlePrefix,
  faviconDataUrl,
  urlKey,
  tabBarMode,
  pruneUrlMap,
  writeUrlColor,
  applyTabColors,
  applyNavigation,
  resolveChoice,
} = sandbox.TabShadeColor;

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

test("macOS Safari 26 uses the strip and iPhone and iPad use theme-color", () => {
  const mac26 = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6.2 Safari/605.1.15";
  const mac18 = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15";
  const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1";
  const ipad = "Mozilla/5.0 (iPad; CPU OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1";
  const desktopIpad = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15";
  const chrome = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

  const mode = (ua, strip, hints) => {
    const result = tabBarMode(ua, strip, hints);
    return { theme: result.theme, strip: result.strip, platform: result.platform };
  };
  assert.deepEqual(mode(mac26, true), { theme: false, strip: true, platform: "macos" });
  assert.deepEqual(mode(mac26, false), { theme: false, strip: false, platform: "macos" });
  assert.deepEqual(mode(mac18, true), { theme: true, strip: false, platform: "macos" });
  assert.deepEqual(mode(iphone, true), { theme: true, strip: false, platform: "ios" });
  assert.deepEqual(mode(ipad, true), { theme: true, strip: false, platform: "ios" });
  assert.deepEqual(mode(desktopIpad, true, { touchMac: true }), { theme: true, strip: false, platform: "ios" });
  assert.deepEqual(mode(chrome, true), { theme: false, strip: false, platform: "other" });
});

test("the Safari 26 sampler strip covers WebKit's sample point and minimum box", () => {
  assert.ok(STRIP.height >= STRIP.minBox);
  assert.ok(STRIP.top <= STRIP.samplePoint);
  assert.ok(STRIP.top + STRIP.height >= STRIP.samplePoint + 2);
});

test("resolveChoice ranks tab, then the exact site, then a parent that includes subdomains", () => {
  const hosts = {
    "google.com": { mode: "custom", color: "#2255aa", subdomains: true },
    "news.google.com": { mode: "off" },
    "github.com": { mode: "custom", color: "#123456", subdomains: false },
  };

  const tab = resolveChoice({
    enabled: true,
    host: "mail.google.com",
    hosts,
    tabColor: "#abc",
  });
  assert.equal(tab.source, "tab");
  assert.equal(tab.color, "#aabbcc");

  const session = resolveChoice({
    enabled: true,
    host: "github.com",
    hosts,
    sessionEntry: { color: "#111111", host: "github.com" },
    urlColor: "#222222",
  });
  assert.equal(session.source, "tab");
  assert.equal(session.color, "#111111");

  const moved = resolveChoice({
    enabled: true,
    host: "example.com",
    hosts,
    sessionEntry: { color: "#111111", host: "github.com" },
    urlColor: "#222222",
  });
  assert.equal(moved.source, "tab");
  assert.equal(moved.color, "#222222");

  const restored = resolveChoice({
    enabled: true,
    host: "example.com",
    urlColor: "#abcdef",
  });
  assert.equal(restored.source, "tab");
  assert.equal(restored.color, "#abcdef");

  const otherSite = resolveChoice({
    enabled: true,
    host: "example.com",
    hosts: { "example.com": { mode: "custom", color: "#333333" } },
    sessionEntry: { color: "#111111", host: "github.com" },
  });
  assert.equal(otherSite.source, "custom");
  assert.equal(otherSite.color, "#333333");

  const exact = resolveChoice({ enabled: true, host: "www.github.com", hosts });
  assert.equal(exact.source, "custom");
  assert.equal(exact.color, "#123456");
  assert.equal(exact.matchedHost, "github.com");

  const child = resolveChoice({ enabled: true, host: "mail.google.com", hosts });
  assert.equal(child.source, "subdomain");
  assert.equal(child.color, "#2255aa");
  assert.equal(child.matchedHost, "google.com");

  const blocked = resolveChoice({ enabled: true, host: "news.google.com", hosts });
  assert.equal(blocked.source, "off");
  assert.equal(blocked.color, null);
  assert.equal(blocked.matchedHost, "news.google.com");

  const ignored = resolveChoice({ enabled: true, host: "gist.github.com", hosts });
  assert.equal(ignored.source, "auto");
  assert.equal(ignored.color, autoColor("gist.github.com"));

  const markersOff = resolveChoice({
    enabled: true,
    host: "github.com",
    showEmoji: false,
    showFavicon: false,
    showStrip: false,
  });
  assert.equal(markersOff.showEmoji, false);
  assert.equal(markersOff.showFavicon, false);
  assert.equal(markersOff.showStrip, false);
  assert.equal(markersOff.color, autoColor("github.com"));
});

test("title prefixes are idempotent and come off cleanly", () => {
  const emoji = markerFor("#e53935");
  assert.equal(emoji, "🟥");
  assert.equal(markerFor("#212121"), "⬛");
  assert.equal(markerFor("#f5f5f5"), "⬜");
  assert.equal(markerFor("nope"), null);

  const once = applyTitlePrefix("Inbox", emoji);
  assert.equal(once, `🟥${MARKER_SEP}Inbox`);
  assert.equal(applyTitlePrefix(once, emoji), once);
  assert.equal(applyTitlePrefix(`${once} (2)`, emoji), `🟥${MARKER_SEP}Inbox (2)`);
  assert.equal(applyTitlePrefix(`🟥${MARKER_SEP}🟥${MARKER_SEP}Inbox`, "🟦"), `🟦${MARKER_SEP}Inbox`);
  assert.equal(applyTitlePrefix(once, null), "Inbox");
  assert.equal(applyTitlePrefix("🟥 Sale", emoji), `🟥${MARKER_SEP}🟥 Sale`);
  assert.equal(applyTitlePrefix("🟥 Sale", null), "🟥 Sale");
  assert.equal(applyTitlePrefix("", emoji), `🟥${MARKER_SEP}`);
  assert.equal(applyTitlePrefix(null, emoji), `🟥${MARKER_SEP}`);
  assert.ok(MARKERS.length >= 9);
});

test("favicon data urls are colored svg documents", () => {
  const url = faviconDataUrl("#abc");
  assert.ok(url.startsWith("data:image/svg+xml,"));
  assert.equal(decodeURIComponent(url.slice("data:image/svg+xml,".length)).includes("#aabbcc"), true);
  assert.equal(url.includes("<script"), false);
  assert.equal(faviconDataUrl("red"), null);
});

test("url keys keep the exact http url and drop the hash", () => {
  assert.equal(urlKey("https://WWW.GitHub.com/Inbox/1?x=1#section"), "https://www.github.com/Inbox/1?x=1");
  assert.equal(urlKey("https://github.com"), "https://github.com/");
  assert.equal(urlKey("https://github.com/"), "https://github.com/");
  assert.equal(urlKey("about:blank"), "");
  assert.equal(urlKey("file:///tmp/a"), "");
  assert.equal(urlKey(""), "");
});

test("the url color map drops the least recently used entries past the cap", () => {
  let map = {};
  for (let i = 0; i < 5; i += 1) {
    map = writeUrlColor(map, `https://example.com/${i}`, i % 2 === 0 ? "#abc" : "#123456", 1000 + i, 3);
  }
  assert.equal(Object.keys(map).length, 3);
  assert.equal(map["https://example.com/0"], undefined);
  assert.equal(map["https://example.com/1"], undefined);
  assert.equal(map["https://example.com/4"].color, "#aabbcc");
  assert.equal(map["https://example.com/4"].used, 1004);

  map = writeUrlColor(map, "https://example.com/4#later", null, 2000, 3);
  assert.equal(map["https://example.com/4"], undefined);

  const tied = pruneUrlMap({
    "https://example.com/b": { color: "#111111", used: 5 },
    "https://example.com/a": { color: "#222222", used: 5 },
    "https://example.com/c": { color: "#333333", used: 5 },
  }, 2);
  assert.deepEqual(Object.keys(tied).sort(), ["https://example.com/b", "https://example.com/c"]);

  const kept = writeUrlColor({}, "https://example.com/new", "#abcdef", 9, URL_MAP_LIMIT);
  assert.equal(kept["https://example.com/new"].color, "#abcdef");
  assert.equal(writeUrlColor({}, "chrome://newtab", "#abcdef", 9)["chrome://newtab"], undefined);
});

test("per-tab color follows the same site, keeps the pinned and current urls, and drops on another site", () => {
  const set = applyTabColors({}, {}, [
    { id: 7, url: "https://github.com/invertedlight/homelab" },
  ], "#abc", 10);
  assert.equal(set.ok, true);
  assert.equal(set.session["7"].host, "github.com");
  assert.equal(set.session["7"].pinnedUrl, "https://github.com/invertedlight/homelab");
  assert.equal(set.urls["https://github.com/invertedlight/homelab"].color, "#aabbcc");

  const blank = applyNavigation(set.session, set.urls, 7, "about:blank", 11);
  assert.equal(blank.action, "ignore");
  assert.equal(blank.session["7"].color, "#aabbcc");
  assert.equal(blank.urls, set.urls);

  const moved = applyNavigation(set.session, set.urls, 7, "https://www.github.com/invertedlight/homelab/issues", 12);
  assert.equal(moved.action, "move");
  assert.equal(moved.session["7"].host, "github.com");
  assert.equal(moved.session["7"].pinnedUrl, "https://github.com/invertedlight/homelab");
  assert.equal(moved.session["7"].url, "https://www.github.com/invertedlight/homelab/issues");
  assert.equal(moved.urls["https://github.com/invertedlight/homelab"].color, "#aabbcc");
  assert.equal(moved.urls["https://www.github.com/invertedlight/homelab/issues"].color, "#aabbcc");

  const passed = applyNavigation(moved.session, moved.urls, 7, "https://github.com/invertedlight/homelab/pulls", 13);
  assert.equal(passed.urls["https://www.github.com/invertedlight/homelab/issues"], undefined);
  assert.equal(passed.urls["https://github.com/invertedlight/homelab"].color, "#aabbcc");
  assert.equal(passed.urls["https://github.com/invertedlight/homelab/pulls"].color, "#aabbcc");

  const cleared = applyTabColors(passed.session, passed.urls, [
    { id: 7, url: "https://github.com/invertedlight/homelab/pulls" },
  ], null, 14);
  assert.equal(cleared.ok, true);
  assert.equal(cleared.session["7"], undefined);
  assert.equal(cleared.urls["https://github.com/invertedlight/homelab/pulls"], undefined);
  assert.equal(cleared.urls["https://github.com/invertedlight/homelab"], undefined);

  const left = applyNavigation(passed.session, passed.urls, 7, "https://example.com/", 15);
  assert.equal(left.action, "drop");
  assert.equal(left.session["7"], undefined);
  assert.equal(left.urls["https://github.com/invertedlight/homelab"].color, "#aabbcc");
  assert.equal(left.urls["https://github.com/invertedlight/homelab/pulls"].color, "#aabbcc");
});

test("clearing one tab leaves a url that another tab still uses", () => {
  const both = applyTabColors({}, {}, [
    { id: 1, url: "https://github.com/a" },
    { id: 2, url: "https://github.com/a" },
  ], "#123456", 20);
  const cleared = applyTabColors(both.session, both.urls, [
    { id: 1, url: "https://github.com/a" },
  ], null, 21);
  assert.equal(cleared.session["1"], undefined);
  assert.equal(cleared.session["2"].color, "#123456");
  assert.equal(cleared.urls["https://github.com/a"].color, "#123456");
});

test("a tab override beats a parent site, including www", () => {
  const hosts = { "google.com": { mode: "custom", color: "#2255aa", subdomains: true } };
  const child = resolveChoice({ enabled: true, host: "www.mail.google.com", hosts });
  assert.equal(child.source, "subdomain");
  assert.equal(child.matchedHost, "google.com");
  const tab = resolveChoice({
    enabled: true,
    host: "mail.google.com",
    hosts,
    sessionEntry: { color: "#abcdef", host: "mail.google.com" },
  });
  assert.equal(tab.source, "tab");
  assert.equal(tab.color, "#abcdef");
});
