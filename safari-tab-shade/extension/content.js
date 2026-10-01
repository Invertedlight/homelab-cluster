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
    originals: null,
    observer: null,
    applying: false,
    applyDepth: 0,
  };

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

  function paint(color, showStrip) {
    const hex = Color.normalizeHex(color);
    const wantedStrip = showStrip !== false;
    if (hex === state.color && wantedStrip === state.showStrip && hex) {
      const mode = channels(state.showStrip);
      if (mode.strip) setStrip(hex);
      return;
    }
    state.color = hex;
    state.showStrip = wantedStrip;
    if (!hex) {
      removeStrip();
      restoreTheme();
      return;
    }
    const mode = channels(wantedStrip);
    if (mode.theme) setThemeColor(hex);
    else if (state.originals) restoreTheme();
    if (mode.strip) setStrip(hex);
    else removeStrip();
  }

  function watch() {
    if (state.observer || !document.documentElement) return;
    state.observer = new MutationObserver(() => {
      if (state.applying || !state.color) return;
      const mode = channels(state.showStrip);
      if (mode.theme) setThemeColor(state.color);
      if (mode.strip) setStrip(state.color);
    });
    state.observer.observe(document.documentElement, { childList: true });
    const observeHead = () => {
      if (!document.head || state.headObserved) return;
      state.headObserved = true;
      state.observer.observe(document.head, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["content"],
      });
    };
    observeHead();
    if (!state.headObserved) {
      const wait = new MutationObserver(() => {
        observeHead();
        if (state.headObserved) wait.disconnect();
      });
      wait.observe(document.documentElement, { childList: true });
    }
  }

  function refresh() {
    if (!api || !api.runtime) return;
    api.runtime.sendMessage({ type: "query" }).then((resolved) => {
      if (!resolved || resolved.error) return;
      paint(resolved.color, resolved.showStrip);
      watch();
    }).catch(() => {
      // Extension context can disappear during a reload.
    });
  }

  api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.type !== "apply") return undefined;
    paint(message.color, message.showStrip);
    watch();
    sendResponse({ ok: true });
    return undefined;
  });

  globalThis.__tabShade = { refresh, paint };
  refresh();
})();
