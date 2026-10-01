importScripts("color.js");

const api = globalThis.browser ?? globalThis.chrome;
const Color = globalThis.TabShadeColor;

let memoryTabs = {};

function emptySettings() {
  return { enabled: true, showStrip: true, hosts: {} };
}

async function getSettings() {
  const stored = await api.storage.local.get(emptySettings());
  return {
    enabled: stored.enabled !== false,
    showStrip: stored.showStrip !== false,
    hosts: stored.hosts && typeof stored.hosts === "object" ? stored.hosts : {},
  };
}

async function readTabMap() {
  if (api.storage.session) {
    try {
      const data = await api.storage.session.get({ tabs: {} });
      if (data.tabs && typeof data.tabs === "object") {
        memoryTabs = data.tabs;
        return { ...data.tabs };
      }
    } catch (_error) {
      // Session storage is missing on older Safari. The in-memory map still works.
    }
  }
  return { ...memoryTabs };
}

async function writeTabMap(tabs) {
  memoryTabs = tabs;
  if (api.storage.session) {
    try {
      await api.storage.session.set({ tabs });
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
    return { host };
  } catch (_error) {
    return null;
  }
}

async function resolveColor(tab) {
  const settings = await getSettings();
  const page = pageUrl(tab && tab.url);
  const tabs = await readTabMap();
  const override = tab && tab.id != null ? tabs[String(tab.id)] : null;
  return Color.resolveChoice({
    enabled: settings.enabled,
    showStrip: settings.showStrip,
    host: page ? page.host : "",
    hostEntry: page ? settings.hosts[page.host] : null,
    tabColor: override ? override.color : null,
  });
}

function paintMessage(resolved) {
  return { type: "apply", color: resolved.color, showStrip: resolved.showStrip !== false };
}

async function paintTab(tab) {
  if (!tab || tab.id == null) return;
  const resolved = await resolveColor(tab);
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
  await api.storage.local.set({ enabled: !!enabled });
  await broadcast();
}

async function setShowStrip(showStrip) {
  await api.storage.local.set({ showStrip: !!showStrip });
  await broadcast();
}

async function setHost(host, mode, color) {
  const key = Color.hostKey(host);
  if (!key) throw new Error("Missing site");
  const settings = await getSettings();
  const hosts = { ...settings.hosts };
  if (mode === "auto") {
    delete hosts[key];
  } else if (mode === "off") {
    hosts[key] = { mode: "off" };
  } else if (mode === "custom") {
    const hex = Color.normalizeHex(color);
    if (!hex) throw new Error("Enter a color like #2f6fbe");
    hosts[key] = { mode: "custom", color: hex };
  } else {
    throw new Error("Unknown color mode");
  }
  await api.storage.local.set({ hosts });
  await broadcast();
}

async function setTabColor(tabId, color) {
  if (tabId == null) throw new Error("Missing tab");
  const tabs = await readTabMap();
  const key = String(tabId);
  if (!color) {
    delete tabs[key];
  } else {
    const hex = Color.normalizeHex(color);
    if (!hex) throw new Error("Enter a color like #2f6fbe");
    tabs[key] = { color: hex };
  }
  await writeTabMap(tabs);
  await broadcast();
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
      const [tab] = await api.tabs.query({ active: true, currentWindow: true });
      const settings = await getSettings();
      const resolved = await resolveColor(tab || {});
      const tabs = await readTabMap();
      const entry = resolved.host ? settings.hosts[resolved.host] : null;
      return {
        enabled: settings.enabled,
        showStrip: settings.showStrip,
        tab: tab
          ? {
            id: tab.id,
            title: tab.title || "",
            url: tab.url || "",
            favIconUrl: tab.favIconUrl || "",
          }
          : null,
        host: resolved.host,
        source: resolved.source,
        color: resolved.color,
        hostMode: entry && entry.mode === "off" ? "off" : entry && entry.mode === "custom" ? "custom" : "auto",
        hostColor: entry && entry.mode === "custom" ? Color.normalizeHex(entry.color) : null,
        tabColor: tab && tabs[String(tab.id)] ? Color.normalizeHex(tabs[String(tab.id)].color) : null,
      };
    })());
  }

  if (message.type === "setEnabled") return respond(setEnabled(message.enabled).then(getSettings));
  if (message.type === "setShowStrip") return respond(setShowStrip(message.showStrip).then(getSettings));
  if (message.type === "setHost") return respond(setHost(message.host, message.mode, message.color).then(getSettings));
  if (message.type === "setTabColor") return respond(setTabColor(message.tabId, message.color).then(getSettings));

  return undefined;
});

api.tabs.onRemoved.addListener((tabId) => {
  readTabMap().then((tabs) => {
    const key = String(tabId);
    if (!tabs[key]) return;
    delete tabs[key];
    return writeTabMap(tabs);
  });
});

api.runtime.onInstalled.addListener(() => {
  injectAll();
});

api.runtime.onStartup.addListener(() => {
  injectAll();
});
