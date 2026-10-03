(function () {
  const api = globalThis.browser ?? globalThis.chrome;
  const Color = globalThis.TabShadeColor;
  const STRIP_ID = "tab-shade-sampler";

  if (globalThis.__tabShade) {
    globalThis.__tabShade.refresh();
    return;
  }

  const state = {
    color: undefined,
    showStrip: true,
    showEmoji: true,
    showFavicon: true,
    originals: null,
    icons: null,
    faviconHref: "",
    faviconFor: "",
    observer: null,
    applying: false,
    applyDepth: 0,
  };
  let paintGeneration = 0;

  function safariMajor() {
    const match = navigator.userAgent.match(/Version\/(\d+)/);
    return match ? Number(match[1]) : 0;
  }

  function isSafari() {
    const agent = navigator.userAgent;
    return /Safari\//.test(agent) && !/Chrome|Chromium|Edg\/|OPR\//.test(agent);
  }

  function channels(showStrip) {
    if (!isSafari()) return { theme: false, strip: false };
    const major = safariMajor();
    if (major >= 26) return { theme: false, strip: !!showStrip };
    if (major > 0) return { theme: true, strip: false };
    return { theme: true, strip: !!showStrip };
  }

  function headOrRoot() {
    return document.head || document.documentElement;
  }

  function remember(meta) {
    if (!state.originals) state.originals = [];
    state.originals.push({
      media: meta.getAttribute("media"),
      content: meta.getAttribute("content"),
    });
  }

  function captureOriginals() {
    if (state.originals) return;
    state.originals = [];
    document.querySelectorAll('meta[name="theme-color"]').forEach((meta) => {
      if (meta.dataset.tabShade === "1") return;
      remember(meta);
    });
  }

  function mutate(fn) {
    state.applyDepth += 1;
    state.applying = true;
    try {
      fn();
    } finally {
      queueMicrotask(() => {
        state.applyDepth = Math.max(0, state.applyDepth - 1);
        state.applying = state.applyDepth > 0;
      });
    }
  }

  function setThemeColor(color) {
    captureOriginals();
    const foreign = [...document.querySelectorAll('meta[name="theme-color"]')].filter((meta) => meta.dataset.tabShade !== "1");
    let meta = document.querySelector('meta[name="theme-color"][data-tab-shade="1"]');
    const parent = headOrRoot();
    if (foreign.length === 0 && meta && meta.getAttribute("content") === color && meta.parentNode === parent) return;
    mutate(() => {
      foreign.forEach((node) => {
        if (!state.originals.some((item) => item.content === node.getAttribute("content") && item.media === node.getAttribute("media"))) {
          remember(node);
        }
        node.remove();
      });
      if (!meta) {
        meta = document.createElement("meta");
        meta.setAttribute("name", "theme-color");
        meta.dataset.tabShade = "1";
      }
      meta.setAttribute("content", color);
      if (meta.parentNode !== parent) parent.appendChild(meta);
    });
  }

  function restoreTheme() {
    const saved = state.originals;
    const managed = document.querySelector('meta[name="theme-color"][data-tab-shade="1"]');
    if (!saved && !managed) return;
    state.originals = null;
    mutate(() => {
      document.querySelectorAll('meta[name="theme-color"][data-tab-shade="1"]').forEach((meta) => meta.remove());
      if (saved && document.head) {
        saved.forEach((item) => {
          const meta = document.createElement("meta");
          meta.setAttribute("name", "theme-color");
          if (item.media) meta.setAttribute("media", item.media);
          if (item.content != null) meta.setAttribute("content", item.content);
          document.head.appendChild(meta);
        });
      }
    });
  }

  function stripCss(color) {
    const rules = {
      position: "fixed",
      top: `${Color.STRIP.top}px`,
      left: "0",
      right: "0",
      width: "auto",
      height: `${Color.STRIP.height}px`,
      "min-height": `${Color.STRIP.height}px`,
      "max-height": `${Color.STRIP.height}px`,
      margin: "0",
      padding: "0",
      border: "0",
      "border-radius": "0",
      "background-image": "none",
      "background-color": color,
      opacity: "1",
      visibility: "visible",
      display: "block",
      "pointer-events": "none",
      "z-index": "2147483647",
      transform: "none",
      "box-shadow": "none",
      "box-sizing": "border-box",
      "forced-color-adjust": "none",
      "user-select": "none",
    };
    return Object.entries(rules).map(([key, value]) => `${key}:${value} !important;`).join("");
  }

  function setStrip(color) {
    const root = document.documentElement;
    if (!root) return;
    let node = document.getElementById(STRIP_ID);
    if (!node) {
      node = document.createElement("div");
      node.id = STRIP_ID;
      node.setAttribute("aria-hidden", "true");
    }
    if (node.dataset.color === color && node.parentNode === root && root.lastElementChild === node) return;
    mutate(() => {
      node.dataset.color = color;
      node.style.cssText = stripCss(color);
      if (node.parentNode !== root || root.lastElementChild !== node) root.appendChild(node);
    });
  }

  function removeStrip() {
    const node = document.getElementById(STRIP_ID);
    if (node) node.remove();
  }

  function applyTitle(hex) {
    const emoji = hex ? Color.markerFor(hex) : null;
    const next = Color.applyTitlePrefix(document.title, emoji);
    if (next === document.title) return;
    mutate(() => {
      document.title = next;
    });
  }

  function iconLinks() {
    return [...document.querySelectorAll("link[rel]")].filter((link) => {
      if (link.dataset.tabShade === "1") return true;
      // apple-touch-icon and mask-icon can beat rel=icon. Take every icon link
      // so the colored one is the one Safari shows, and put the originals back later.
      return (link.getAttribute("rel") || "").toLowerCase().includes("icon");
    });
  }

  function rememberIcon(link) {
    if (!link || link.dataset.tabShade === "1") return;
    const href = link.getAttribute("href");
    if (!href) return;
    if (!state.icons) state.icons = [];
    const item = {
      rel: link.getAttribute("rel") || "icon",
      href,
      type: link.getAttribute("type"),
      sizes: link.getAttribute("sizes"),
    };
    const signature = `${item.rel}|${item.href}|${item.sizes || ""}|${item.type || ""}`;
    if (state.icons.some((saved) => saved.signature === signature)) return;
    item.signature = signature;
    state.icons.push(item);
  }

  function drawFavicon(hex) {
    try {
      const canvas = document.createElement("canvas");
      canvas.width = 32;
      canvas.height = 32;
      const ctx = canvas.getContext("2d");
      if (!ctx) return Color.faviconDataUrl(hex);
      const radius = 7;
      ctx.beginPath();
      ctx.moveTo(radius, 0);
      ctx.arcTo(32, 0, 32, 32, radius);
      ctx.arcTo(32, 32, 0, 32, radius);
      ctx.arcTo(0, 32, 0, 0, radius);
      ctx.arcTo(0, 0, 32, 0, radius);
      ctx.closePath();
      ctx.fillStyle = hex;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(16, 16, 5, 0, Math.PI * 2);
      ctx.fillStyle = Color.textOn(hex);
      ctx.fill();
      return canvas.toDataURL("image/png");
    } catch (_error) {
      return Color.faviconDataUrl(hex);
    }
  }

  function setFavicon(hex) {
    if (!document.head) return;
    let href = state.faviconHref;
    if (state.faviconFor !== hex || !href) {
      href = drawFavicon(hex);
      state.faviconFor = hex;
      state.faviconHref = href || "";
    }
    if (!href) return;
    const ours = document.querySelector('link[data-tab-shade="1"]');
    const foreign = iconLinks().filter((link) => link.dataset.tabShade !== "1");
    if (ours && ours.getAttribute("href") === href && ours.parentNode === document.head && foreign.length === 0) return;
    foreign.forEach(rememberIcon);
    mutate(() => {
      foreign.forEach((node) => node.remove());
      if (ours) ours.remove();
      // A new element, rather than a new href on the old one, is what gives Safari
      // a chance to read the icon on the next collection. It still may keep a
      // cached site icon; the title emoji is the marker that does not depend on that.
      const link = document.createElement("link");
      link.rel = "icon";
      link.dataset.tabShade = "1";
      link.type = href.startsWith("data:image/png") ? "image/png" : "image/svg+xml";
      link.setAttribute("sizes", "32x32");
      link.href = href;
      document.head.appendChild(link);
    });
  }

  function restoreFavicon() {
    const saved = state.icons;
    const managed = document.querySelector('link[data-tab-shade="1"]');
    if (!saved && !managed) return;
    state.icons = null;
    mutate(() => {
      document.querySelectorAll('link[data-tab-shade="1"]').forEach((node) => node.remove());
      if (saved && document.head) {
        saved.forEach((item) => {
          const link = document.createElement("link");
          link.setAttribute("rel", item.rel || "icon");
          if (item.type) link.setAttribute("type", item.type);
          if (item.sizes) link.setAttribute("sizes", item.sizes);
          link.setAttribute("href", item.href);
          document.head.appendChild(link);
        });
      }
    });
  }

  function reapply() {
    if (!state.color) return;
    const mode = channels(state.showStrip);
    if (mode.theme) setThemeColor(state.color);
    else if (document.querySelector('meta[name="theme-color"][data-tab-shade="1"]')) restoreTheme();
    if (mode.strip) setStrip(state.color);
    else if (document.getElementById(STRIP_ID)) removeStrip();
    applyTitle(state.showEmoji ? state.color : null);
    if (state.showFavicon) setFavicon(state.color);
    else if (document.querySelector('link[data-tab-shade="1"]')) restoreFavicon();
  }

  function paint(color, options) {
    const flags = options || {};
    const hex = Color.normalizeHex(color);
    const showStrip = flags.showStrip !== false;
    const showEmoji = flags.showEmoji !== false;
    const showFavicon = flags.showFavicon !== false;
    state.color = hex;
    state.showStrip = showStrip;
    state.showEmoji = showEmoji;
    state.showFavicon = showFavicon;
    if (!hex) {
      removeStrip();
      restoreTheme();
      applyTitle(null);
      restoreFavicon();
      return;
    }
    const mode = channels(showStrip);
    if (mode.theme) setThemeColor(hex);
    else if (state.originals) restoreTheme();
    if (mode.strip) setStrip(hex);
    else removeStrip();
    applyTitle(showEmoji ? hex : null);
    if (showFavicon) setFavicon(hex);
    else restoreFavicon();
  }

  function watch() {
    if (state.observer || !document.documentElement) return;
    state.observer = new MutationObserver(() => {
      observeHead();
      if (state.applying) return;
      if (!state.color) {
        if (document.getElementById(STRIP_ID)) removeStrip();
        if (document.title !== Color.applyTitlePrefix(document.title, null)) applyTitle(null);
        if (document.querySelector('link[data-tab-shade="1"]')) restoreFavicon();
        return;
      }
      reapply();
    });
    // The title and favicon live in head. Watching the whole document would
    // repaint on every page change.
    state.observer.observe(document.documentElement, { childList: true });
    const observeHead = () => {
      if (!document.head || state.headObserved) return;
      state.headObserved = true;
      state.observer.observe(document.head, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ["content", "href", "rel"],
      });
    };
    observeHead();
  }

  function readStoredChoice() {
    if (!api || !api.storage || !api.storage.local) return Promise.resolve(null);
    return api.storage.local.get({
      enabled: true,
      showStrip: true,
      showEmoji: true,
      showFavicon: true,
      hosts: {},
      urls: {},
    }).then((stored) => {
      const hosts = stored.hosts && typeof stored.hosts === "object" ? stored.hosts : {};
      const urls = stored.urls && typeof stored.urls === "object" ? stored.urls : {};
      const key = Color.urlKey(location.href);
      const urlEntry = key ? urls[key] : null;
      return Color.resolveChoice({
        enabled: stored.enabled,
        showStrip: stored.showStrip,
        showEmoji: stored.showEmoji,
        showFavicon: stored.showFavicon,
        host: location.hostname,
        hosts,
        urlColor: urlEntry ? urlEntry.color : null,
      });
    }).catch(() => null);
  }

  function paintFromExtension(color, options) {
    paintGeneration += 1;
    paint(color, options);
    watch();
  }

  function refresh() {
    if (!api || !api.runtime) return;
    const generation = paintGeneration;
    // storage.local is readable from the page and does not wait for the worker.
    // The worker reply is authoritative because it also knows this tab's session.
    readStoredChoice().then((resolved) => {
      if (!resolved || generation !== paintGeneration) return;
      paint(resolved.color, resolved);
      watch();
    }).catch(() => {});
    api.runtime.sendMessage({ type: "query" }).then((resolved) => {
      if (!resolved || resolved.error) return;
      paintFromExtension(resolved.color, resolved);
    }).catch(() => {
      // Extension context can disappear during a reload.
    });
  }

  api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.type !== "apply") return undefined;
    paintFromExtension(message.color, message);
    sendResponse({ ok: true });
    return undefined;
  });

  globalThis.__tabShade = { refresh, paint };
  refresh();
})();
