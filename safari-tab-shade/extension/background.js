importScripts("color.js");

const api = globalThis.browser ?? globalThis.chrome;
const Color = globalThis.TabShadeColor;

let memoryTabs = {};
let settingsCache = null;
let settingsLoad = null;
let sessionCache = null;
let sessionLoad = null;

function emptySettings() {
  return {
    enabled: true,
    showStrip: true,
    showEmoji: true,
    showFavicon: true,
    hosts: {},
    urls: {},
  };
}

function normalizeSettings(stored) {
  const data = stored || {};
  return {
    enabled: data.enabled !== false,
    showStrip: data.showStrip !== false,
    showEmoji: data.showEmoji !== false,
    showFavicon: data.showFavicon !== false,
    hosts: data.hosts && typeof data.hosts === "object" ? data.hosts : {},
    urls: data.urls && typeof data.urls === "object" ? data.urls : {},
  };
}

function loadSettings() {
  if (settingsCache) return Promise.resolve(settingsCache);
  if (!settingsLoad) {
    settingsLoad = api.storage.local.get(emptySettings()).then((stored) => {
      settingsCache = normalizeSettings(stored);
      return settingsCache;
    });
  }
  return settingsLoad;
}

async function getSettings() {
  await loadSettings();
  return normalizeSettings(settingsCache);
}

function loadSession() {
  if (sessionCache) return Promise.resolve(sessionCache);
  if (!sessionLoad) {
    sessionLoad = (async () => {
      if (api.storage.session) {
        try {
          const data = await api.storage.session.get({ tabs: {} });
          if (data.tabs && typeof data.tabs === "object") {
            sessionCache = { ...data.tabs };
            memoryTabs = sessionCache;
            return sessionCache;
          }
        } catch (_error) {
          // Session storage is missing on older Safari. The in-memory map still works
          // until the service worker stops.
        }
      }
      sessionCache = { ...memoryTabs };
      return sessionCache;
    })();
  }
  return sessionLoad;
}

async function readTabMap() {
  await loadSession();
  return { ...sessionCache };
}

async function writeTabMap(tabs) {
  sessionCache = { ...tabs };
  memoryTabs = sessionCache;
  if (api.storage.session) {
    try {
      await api.storage.session.set({ tabs: sessionCache });
    } catch (_error) {
      // Keep the in-memory copy when session storage is unavailable.
    }
  }
}

function pageUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    const host = Color.hostKey(parsed.hostname);
    if (!host) return null;
    return { host, key: Color.urlKey(url) };
  } catch (_error) {
    return null;
  }
}

async function resolveColor(tab, settings, session) {
  const stored = settings || await getSettings();
  const tabs = session || await readTabMap();
  const page = pageUrl(tab && tab.url);
  const entry = tab && tab.id != null ? tabs[String(tab.id)] : null;
  const urlEntry = page && page.key ? stored.urls[page.key] : null;
  return Color.resolveChoice({
    enabled: stored.enabled,
    showStrip: stored.showStrip,
    showEmoji: stored.showEmoji,
    showFavicon: stored.showFavicon,
    host: page ? page.host : "",
    hosts: stored.hosts,
    sessionEntry: entry,
    urlColor: urlEntry ? urlEntry.color : null,
  });
}

function paintMessage(resolved) {
  return {
    type: "apply",
    color: resolved.color,
    showStrip: resolved.showStrip !== false,
    showEmoji: resolved.showEmoji !== false,
    showFavicon: resolved.showFavicon !== false,
  };
}

async function touchUrl(url) {
  const key = Color.urlKey(url);
  if (!key) return;
  await loadSettings();
  const entry = settingsCache.urls[key];
  if (!entry) return;
  const now = Date.now();
  if (now - (Number(entry.used) || 0) < 60 * 60 * 1000) return;
  const urls = Color.writeUrlColor(settingsCache.urls, url, entry.color, now);
  settingsCache = { ...settingsCache, urls };
  await api.storage.local.set({ urls });
}

async function paintTab(tab) {
  if (!tab || tab.id == null) return;
  const settings = await getSettings();
  await loadSession();
  let session = sessionCache;
  const resolved = await resolveColor(tab, settings, session);
  const page = pageUrl(tab.url);
  if (resolved.source === "tab" && page) {
    const id = String(tab.id);
    if (!sessionCache[id]) {
      sessionCache = {
        ...sessionCache,
        [id]: {
          color: resolved.color,
          host: page.host,
          url: page.key,
          pinnedUrl: page.key,
        },
      };
      await writeTabMap(sessionCache);
      session = sessionCache;
    }
    const entry = session[id];
    try {
      await touchUrl(entry && (entry.pinnedUrl || entry.url) ? (entry.pinnedUrl || entry.url) : page.key);
      if (entry && entry.url && entry.url !== entry.pinnedUrl) await touchUrl(entry.url);
      if (page.key !== (entry && entry.url)) await touchUrl(page.key);
    } catch (_error) {
      // A failed timestamp update should not stop the paint.
    }
  }
  try {
    await api.tabs.sendMessage(tab.id, paintMessage(resolved));
  } catch (_error) {
    // The tab has no content script yet, or it is a page Safari will not script.
  }
}

async function broadcast() {
  const tabs = await api.tabs.query({});
  await Promise.all(tabs.map((tab) => paintTab(tab)));
}

async function injectAll() {
  const tabs = await api.tabs.query({});
  await Promise.all(tabs.map(async (tab) => {
    if (!pageUrl(tab.url) || tab.id == null) return;
    try {
      await api.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["color.js", "content.js"],
      });
    } catch (_error) {
      // Restricted pages and already-closed tabs are expected.
    }
  }));
}

async function setEnabled(enabled) {
  await loadSettings();
  settingsCache = { ...settingsCache, enabled: !!enabled };
  await api.storage.local.set({ enabled: !!enabled });
  await broadcast();
}

async function setFlag(name, value) {
  await loadSettings();
  settingsCache = { ...settingsCache, [name]: !!value };
  await api.storage.local.set({ [name]: !!value });
  await broadcast();
}

async function setHost(host, mode, color, subdomains) {
  const key = Color.hostKey(host);
  if (!key) throw new Error("Missing site");
  await loadSettings();
  const hosts = { ...settingsCache.hosts };
  const inherit = !!subdomains;
  if (mode === "auto") {
    delete hosts[key];
  } else if (mode === "off") {
    hosts[key] = { mode: "off", subdomains: inherit };
  } else if (mode === "custom") {
    const hex = Color.normalizeHex(color);
    if (!hex) throw new Error("Enter a color like #2f6fbe");
    hosts[key] = { mode: "custom", color: hex, subdomains: inherit };
  } else {
    throw new Error("Unknown color mode");
  }
  settingsCache = { ...settingsCache, hosts };
  await api.storage.local.set({ hosts });
  await broadcast();
}

async function colorTabs(tabIds, color) {
  const ids = new Set((tabIds || []).map((id) => Number(id)));
  if (ids.size === 0) throw new Error("Select one or more tabs.");
  if (color && !Color.normalizeHex(color)) throw new Error("Enter a color like #2f6fbe");
  await loadSettings();
  await loadSession();
  const open = await api.tabs.query({});
  const chosen = open.filter((tab) => ids.has(tab.id)).map((tab) => ({ id: tab.id, url: tab.url }));
  const result = Color.applyTabColors(sessionCache, settingsCache.urls, chosen, color || null, Date.now());
  if (!result.ok) throw new Error(result.error);
  settingsCache = { ...settingsCache, urls: result.urls };
  await api.storage.local.set({ urls: result.urls });
  await writeTabMap(result.session);
  await broadcast();
}

async function noteNavigation(tab) {
  if (!tab || tab.id == null) return;
  await loadSettings();
  await loadSession();
  const result = Color.applyNavigation(sessionCache, settingsCache.urls, tab.id, tab.url, Date.now());
  if (result.action !== "drop" && result.action !== "move" && result.action !== "adopt") return;
  if (result.urls !== settingsCache.urls) {
    settingsCache = { ...settingsCache, urls: result.urls };
    await api.storage.local.set({ urls: result.urls });
  }
  await writeTabMap(result.session);
}

function tabSummary(tab) {
  if (!tab) return null;
  return {
    id: tab.id,
    title: tab.title || "",
    url: tab.url || "",
    favIconUrl: tab.favIconUrl || "",
    windowId: tab.windowId,
  };
}

api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const respond = (promise) => {
    promise.then(sendResponse).catch((error) => {
      sendResponse({ error: error && error.message ? error.message : String(error) });
    });
    return true;
  };

  if (!message || typeof message !== "object") return undefined;

  if (message.type === "query") {
    return respond(resolveColor(sender.tab || {}));
  }

  if (message.type === "getState") {
    return respond((async () => {
      // The popup resolves currentWindow itself. A service worker's idea of
      // the current window is the last focused one, which is not always the
      // window that opened the popup.
      let tab = null;
      if (message.tabId != null) {
        try {
          tab = await api.tabs.get(message.tabId);
        } catch (_error) {
          tab = null;
        }
      }
      if (!tab) {
        const [active] = await api.tabs.query({ active: true, currentWindow: true });
        tab = active || null;
      }
      const settings = await getSettings();
      const session = await readTabMap();
      const resolved = await resolveColor(tab || {}, settings, session);
      const entry = resolved.host ? settings.hosts[resolved.host] : null;
      return {
        enabled: settings.enabled,
        showStrip: settings.showStrip,
        showEmoji: settings.showEmoji,
        showFavicon: settings.showFavicon,
        hosts: settings.hosts,
        urls: settings.urls,
        session,
        tab: tabSummary(tab),
        host: resolved.host,
        source: resolved.source,
        color: resolved.color,
        matchedHost: resolved.matchedHost,
        hostMode: entry && entry.mode === "off" ? "off" : entry && entry.mode === "custom" ? "custom" : "auto",
        hostColor: entry && entry.mode === "custom" ? Color.normalizeHex(entry.color) : null,
        hostSubdomains: !!(entry && entry.subdomains),
        tabColor: resolved.source === "tab" ? resolved.color : null,
      };
    })());
  }

  if (message.type === "setEnabled") return respond(setEnabled(message.enabled).then(getSettings));
  if (message.type === "setShowStrip") return respond(setFlag("showStrip", message.showStrip).then(getSettings));
  if (message.type === "setShowEmoji") return respond(setFlag("showEmoji", message.showEmoji).then(getSettings));
  if (message.type === "setShowFavicon") return respond(setFlag("showFavicon", message.showFavicon).then(getSettings));
  if (message.type === "setHost") {
    return respond(setHost(message.host, message.mode, message.color, message.subdomains).then(getSettings));
  }
  if (message.type === "setTabColor") return respond(colorTabs([message.tabId], message.color).then(getSettings));
  if (message.type === "setTabsColor") return respond(colorTabs(message.tabIds, message.color).then(getSettings));

  return undefined;
});

api.tabs.onRemoved.addListener((tabId) => {
  readTabMap().then((tabs) => {
    const key = String(tabId);
    if (!tabs[key]) return undefined;
    delete tabs[key];
    return writeTabMap(tabs);
  });
});

api.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo.url && changeInfo.status !== "complete") return;
  noteNavigation(tab || { id: tabId, url: changeInfo.url }).then(() => paintTab(tab || { id: tabId, url: changeInfo.url }));
});

api.runtime.onInstalled.addListener(() => {
  injectAll();
});

api.runtime.onStartup.addListener(() => {
  injectAll();
});
