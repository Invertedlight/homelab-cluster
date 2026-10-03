(function (root) {
  // Mid-tone solids. Light enough to read as a tab fill, distinct enough to tell sites apart.
  const PALETTE = [
    "#c44536",
    "#d76a2b",
    "#c8960c",
    "#6a8f2b",
    "#2f8f6b",
    "#1f8a9c",
    "#2f6fbe",
    "#3d4db8",
    "#6d45b0",
    "#a33d88",
    "#8f4d3a",
    "#4e6e82",
    "#b23b55",
    "#3f7d4e",
    "#8a6a2f",
    "#3a6ea5",
  ];

  // One emoji per hue. The title prefix uses a zero-width space after the emoji so a
  // page whose real title starts with the same character is left alone, and so a page
  // that copies document.title cannot stack a second marker.
  const MARKERS = [
    { emoji: "🟥", hex: "#e53935" },
    { emoji: "🟧", hex: "#fb8c00" },
    { emoji: "🟨", hex: "#fdd835" },
    { emoji: "🟩", hex: "#43a047" },
    { emoji: "🟦", hex: "#1e88e5" },
    { emoji: "🟪", hex: "#8e24aa" },
    { emoji: "🟫", hex: "#6d4c41" },
    { emoji: "⬛", hex: "#212121" },
    { emoji: "⬜", hex: "#f5f5f5" },
  ];
  const MARKER_SEP = "\u200b";

  // WebKit's tab-bar sampler hit-tests about 4px below the top of the viewport and
  // ignores a fixed box whose border-box is 10px or shorter. The strip has to cover
  // that point and be taller than 10px. See LocalFrameView::fixedContainerEdges.
  const STRIP = {
    top: 0,
    height: 12,
    samplePoint: 4,
    minBox: 11,
  };

  // Exact-URL overrides outlive the tab, but Safari issues new tab ids after a restart.
  // Keep a bounded map and drop the entries that have not been used lately.
  const URL_MAP_LIMIT = 200;

  function hostKey(hostname) {
    if (typeof hostname !== "string") return "";
    let host = hostname.trim().toLowerCase();
    if (host.endsWith(".")) host = host.slice(0, -1);
    if (host.startsWith("www.")) host = host.slice(4);
    return host;
  }

  function parentHosts(hostname) {
    const key = hostKey(hostname);
    const labels = key.split(".").filter(Boolean);
    const parents = [];
    for (let i = 1; i <= labels.length - 2; i += 1) {
      parents.push(labels.slice(i).join("."));
    }
    return parents;
  }

  function matchHost(hosts, hostname) {
    const key = hostKey(hostname);
    if (!key || !hosts || typeof hosts !== "object") return null;
    if (hosts[key]) return { key, entry: hosts[key], exact: true };
    const parents = parentHosts(key);
    for (let i = 0; i < parents.length; i += 1) {
      const parent = parents[i];
      const entry = hosts[parent];
      if (entry && entry.subdomains) return { key: parent, entry, exact: false };
    }
    return null;
  }

  function autoColor(hostname) {
    const host = hostKey(hostname);
    let hash = 2166136261;
    for (let i = 0; i < host.length; i += 1) {
      hash ^= host.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return PALETTE[(hash >>> 0) % PALETTE.length];
  }

  function normalizeHex(input) {
    if (typeof input !== "string") return null;
    let value = input.trim().toLowerCase();
    if (!value) return null;
    if (!value.startsWith("#")) value = `#${value}`;
    if (/^#[0-9a-f]{3}$/.test(value)) {
      value = `#${[...value.slice(1)].map((channel) => channel + channel).join("")}`;
    }
    if (!/^#[0-9a-f]{6}$/.test(value)) return null;
    return value;
  }

  function hexToRgb(hex) {
    const value = Number.parseInt(hex.slice(1), 16);
    return {
      r: (value >> 16) & 255,
      g: (value >> 8) & 255,
      b: value & 255,
    };
  }

  function textOn(hex) {
    const color = normalizeHex(hex);
    if (!color) return "#ffffff";
    const rgb = hexToRgb(color);
    const luminance = (0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b) / 255;
    return luminance > 0.62 ? "#1c1c1e" : "#ffffff";
  }

  function markerFor(hex) {
    const color = normalizeHex(hex);
    if (!color) return null;
    const rgb = hexToRgb(color);
    let best = MARKERS[0];
    let bestDistance = Infinity;
    for (let i = 0; i < MARKERS.length; i += 1) {
      const other = hexToRgb(MARKERS[i].hex);
      const distance = ((rgb.r - other.r) ** 2) + ((rgb.g - other.g) ** 2) + ((rgb.b - other.b) ** 2);
      if (distance < bestDistance) {
        best = MARKERS[i];
        bestDistance = distance;
      }
    }
    return best.emoji;
  }

  function markerExpression() {
    return MARKERS.map((marker) => marker.emoji.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  }

  function stripTitlePrefix(title) {
    if (typeof title !== "string") return "";
    const pattern = new RegExp(`^(?:(?:${markerExpression()})${MARKER_SEP})+`, "u");
    return title.replace(pattern, "");
  }

  function applyTitlePrefix(title, emoji) {
    const base = stripTitlePrefix(title);
    if (!emoji || !MARKERS.some((marker) => marker.emoji === emoji)) return base;
    return `${emoji}${MARKER_SEP}${base}`;
  }

  function faviconDataUrl(hex) {
    const color = normalizeHex(hex);
    if (!color) return null;
    const ink = textOn(color);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="4" fill="${color}"/><circle cx="8" cy="8" r="3" fill="${ink}"/></svg>`;
    return `data:image/svg+xml,${encodeURIComponent(svg)}`;
  }

  function urlKey(url) {
    if (typeof url !== "string" || !url) return "";
    let parsed;
    try {
      parsed = new URL(url);
    } catch (_error) {
      return "";
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    let hostname = parsed.hostname.toLowerCase();
    if (hostname.endsWith(".")) hostname = hostname.slice(0, -1);
    if (!hostname) return "";
    parsed.hash = "";
    parsed.hostname = hostname;
    return `${parsed.origin}${parsed.pathname}${parsed.search}`;
  }

  function cleanUrlMap(map) {
    const next = {};
    if (!map || typeof map !== "object") return next;
    const keys = Object.keys(map);
    for (let i = 0; i < keys.length; i += 1) {
      const canonical = urlKey(keys[i]);
      const value = map[keys[i]];
      const color = value && normalizeHex(value.color);
      if (!color || !canonical) continue;
      const used = Number(value.used) || 0;
      if (!next[canonical] || used >= next[canonical].used) next[canonical] = { color, used };
    }
    return next;
  }

  function pruneUrlMap(map, limit) {
    const cap = limit == null ? URL_MAP_LIMIT : limit;
    const entries = Object.entries(cleanUrlMap(map));
    entries.sort((a, b) => {
      const delta = a[1].used - b[1].used;
      if (delta !== 0) return delta;
      if (a[0] < b[0]) return -1;
      if (a[0] > b[0]) return 1;
      return 0;
    });
    const kept = cap <= 0 ? [] : entries.slice(Math.max(0, entries.length - cap));
    const next = {};
    for (let i = 0; i < kept.length; i += 1) {
      next[kept[i][0]] = kept[i][1];
    }
    return next;
  }

function writeUrlColor(map, url, color, now, limit) {
  const next = cleanUrlMap(map);
  const key = urlKey(url);
  if (key) {
    const hex = normalizeHex(color);
    if (!hex) delete next[key];
    else next[key] = { color: hex, used: Number(now) || 0 };
  }
  return pruneUrlMap(next, limit == null ? URL_MAP_LIMIT : limit);
}

function pageParts(url) {
  const key = urlKey(url);
  if (!key) return null;
  let host = "";
  try {
    host = hostKey(new URL(key).hostname);
  } catch (_error) {
    return null;
  }
  if (!host) return null;
  return { host, key };
}

function cloneSession(session) {
  const next = {};
  if (!session || typeof session !== "object") return next;
  const keys = Object.keys(session);
  for (let i = 0; i < keys.length; i += 1) {
    const entry = session[keys[i]];
    if (!entry || typeof entry !== "object") continue;
    next[keys[i]] = {
      color: entry.color,
      host: entry.host,
      url: entry.url,
      pinnedUrl: entry.pinnedUrl,
    };
  }
  return next;
}

function urlReferenced(session, key) {
  if (!key) return false;
  const ids = Object.keys(session || {});
  for (let i = 0; i < ids.length; i += 1) {
    const entry = session[ids[i]];
    if (!entry) continue;
    if (entry.url === key || entry.pinnedUrl === key) return true;
  }
  return false;
}

// While a tab is open, its override follows same-host navigations. The map keeps
// the address where the color was set and the address the tab is on now, so a
// restart can restore either. Pages only passed through are dropped.
function classifyNavigation(entry, rawUrl) {
  if (!entry || !normalizeHex(entry.color)) return { action: "none" };
  const page = pageParts(rawUrl);
  if (!page) return { action: "ignore" };
  const entryHost = hostKey(entry.host || "");
  if (!entryHost) {
    return {
      action: "adopt",
      entry: {
        color: normalizeHex(entry.color),
        host: page.host,
        url: page.key,
        pinnedUrl: entry.pinnedUrl || entry.url || page.key,
      },
    };
  }
  if (entryHost !== page.host) return { action: "drop" };
  const live = entry.url || "";
  if (live === page.key) return { action: "same" };
  return {
    action: "move",
    entry: {
      color: normalizeHex(entry.color),
      host: page.host,
      url: page.key,
      pinnedUrl: entry.pinnedUrl || live || page.key,
    },
  };
}

function planNavigation(session, tabId, rawUrl) {
  const next = cloneSession(session);
  const id = String(tabId);
  const entry = next[id];
  const decision = classifyNavigation(entry, rawUrl);
  if (decision.action === "none" || decision.action === "ignore" || decision.action === "same") {
    return { action: decision.action, session: next, remember: null, forget: [] };
  }
  if (decision.action === "drop") {
    delete next[id];
    return { action: "drop", session: next, remember: null, forget: [] };
  }
  const previousLive = entry.url || "";
  next[id] = decision.entry;
  const forget = [];
  if (
    previousLive
    && previousLive !== decision.entry.url
    && previousLive !== decision.entry.pinnedUrl
    && !urlReferenced(next, previousLive)
  ) {
    forget.push(previousLive);
  }
  return {
    action: decision.action,
    session: next,
    remember: { key: decision.entry.url, color: decision.entry.color },
    forget,
  };
}

function planTabColor(session, tabId, rawUrl, color) {
  const next = cloneSession(session);
  const id = String(tabId);
  const previous = next[id];
  const page = pageParts(rawUrl);
  if (!page) {
    return {
      ok: false,
      error: "None of those tabs have a site to color.",
      session: next,
      remember: null,
      forget: [],
    };
  }
  const hex = color ? normalizeHex(color) : null;
  if (color && !hex) {
    return {
      ok: false,
      error: "Enter a color like #2f6fbe",
      session: next,
      remember: null,
      forget: [],
    };
  }
  const forget = [];
  if (!hex) {
    delete next[id];
  } else {
    next[id] = { color: hex, host: page.host, url: page.key, pinnedUrl: page.key };
  }
  const oldKeys = previous ? [previous.url, previous.pinnedUrl] : [];
  for (let i = 0; i < oldKeys.length; i += 1) {
    const old = oldKeys[i];
    if (!old || urlReferenced(next, old) || forget.includes(old)) continue;
    if (hex && old === page.key) continue;
    forget.push(old);
  }
  if (!hex && page.key && !urlReferenced(next, page.key) && !forget.includes(page.key)) {
    forget.push(page.key);
  }
  return {
    ok: true,
    session: next,
    remember: hex ? { key: page.key, color: hex } : null,
    forget,
  };
}

function applyTabColors(session, urls, tabs, color, now, limit) {
  const cap = limit == null ? URL_MAP_LIMIT : limit;
  let nextSession = cloneSession(session);
  let nextUrls = urls && typeof urls === "object" ? urls : {};
  const forget = [];
  const remember = [];
  let updated = 0;
  const list = Array.isArray(tabs) ? tabs : [];
  for (let i = 0; i < list.length; i += 1) {
    const tab = list[i];
    if (!tab || tab.id == null) continue;
    const planned = planTabColor(nextSession, tab.id, tab.url, color);
    if (!planned.ok) continue;
    nextSession = planned.session;
    updated += 1;
    if (planned.remember) remember.push(planned.remember);
    for (let j = 0; j < planned.forget.length; j += 1) forget.push(planned.forget[j]);
  }
  if (updated === 0) {
    return {
      ok: false,
      error: color && !normalizeHex(color)
        ? "Enter a color like #2f6fbe"
        : "None of those tabs have a site to color.",
      session: cloneSession(session),
      urls: nextUrls,
    };
  }
  const stamp = Number(now) || 0;
  for (let i = 0; i < remember.length; i += 1) {
    nextUrls = writeUrlColor(nextUrls, remember[i].key, remember[i].color, stamp + i, cap);
  }
  const remembered = new Set(remember.map((item) => item.key));
  for (let i = 0; i < forget.length; i += 1) {
    if (remembered.has(forget[i])) continue;
    nextUrls = writeUrlColor(nextUrls, forget[i], null, stamp, cap);
  }
  return { ok: true, session: nextSession, urls: nextUrls };
}

function applyNavigation(session, urls, tabId, rawUrl, now, limit) {
  const planned = planNavigation(session, tabId, rawUrl);
  let nextUrls = urls && typeof urls === "object" ? urls : {};
  if (!planned.remember && planned.forget.length === 0) {
    return { action: planned.action, session: planned.session, urls: nextUrls };
  }
  const cap = limit == null ? URL_MAP_LIMIT : limit;
  const stamp = Number(now) || 0;
  if (planned.remember) {
    nextUrls = writeUrlColor(nextUrls, planned.remember.key, planned.remember.color, stamp, cap);
  }
  for (let i = 0; i < planned.forget.length; i += 1) {
    if (planned.remember && planned.remember.key === planned.forget[i]) continue;
    nextUrls = writeUrlColor(nextUrls, planned.forget[i], null, stamp, cap);
  }
  return { action: planned.action, session: planned.session, urls: nextUrls };
}

  function tabBarMode(userAgent, showStrip, hints) {
    const ua = typeof userAgent === "string" ? userAgent : "";
    const safari = /Safari\//.test(ua) && !/Chrome|Chromium|Edg\/|OPR\//.test(ua);
    if (!safari) return { theme: false, strip: false, platform: "other" };
    const touchMac = !!(hints && hints.touchMac);
    if (/iPhone|iPad|iPod/.test(ua) || touchMac) {
      return { theme: true, strip: false, platform: "ios" };
    }
    const match = ua.match(/Version\/(\d+)/);
    const major = match ? Number(match[1]) : 0;
    if (major >= 26) return { theme: false, strip: !!showStrip, platform: "macos" };
    if (major > 0) return { theme: true, strip: false, platform: "macos" };
    return { theme: true, strip: !!showStrip, platform: "macos" };
  }

  function resolveChoice(input) {
    const options = input || {};
    const enabled = options.enabled !== false;
    const showStrip = options.showStrip !== false;
    const showEmoji = options.showEmoji !== false;
    const showFavicon = options.showFavicon !== false;
    const key = hostKey(options.host);
    const base = {
      host: key || null,
      showStrip,
      showEmoji,
      showFavicon,
      matchedHost: null,
    };

    if (!key) return { ...base, color: null, source: "unsupported" };
    if (!enabled) return { ...base, color: null, source: "disabled" };

    const sessionHost = options.sessionEntry ? hostKey(options.sessionEntry.host) : "";
    const sessionColor = sessionHost && sessionHost === key ? normalizeHex(options.sessionEntry.color) : null;
    const tabHex = normalizeHex(options.tabColor) || sessionColor || normalizeHex(options.urlColor);
    if (tabHex) return { ...base, color: tabHex, source: "tab", matchedHost: key };

    const hosts = options.hosts && typeof options.hosts === "object" ? options.hosts : null;
    let match = null;
    if (hosts) match = matchHost(hosts, key);
    else if (options.hostEntry) match = { key, entry: options.hostEntry, exact: true };

    if (match && match.entry && match.entry.mode === "off") {
      return { ...base, color: null, source: "off", matchedHost: match.key };
    }
    if (match && match.entry && match.entry.mode === "custom") {
      const custom = normalizeHex(match.entry.color);
      if (custom) {
        return {
          ...base,
          color: custom,
          source: match.exact ? "custom" : "subdomain",
          matchedHost: match.key,
        };
      }
    }
    return { ...base, color: autoColor(key), source: "auto", matchedHost: key };
  }

  root.TabShadeColor = {
    PALETTE,
    MARKERS,
    MARKER_SEP,
    STRIP,
    URL_MAP_LIMIT,
    hostKey,
    parentHosts,
    matchHost,
    autoColor,
    normalizeHex,
    textOn,
    markerFor,
    stripTitlePrefix,
    applyTitlePrefix,
    faviconDataUrl,
    urlKey,
    tabBarMode,
    pruneUrlMap,
    writeUrlColor,
    classifyNavigation,
    planNavigation,
    planTabColor,
    applyTabColors,
    applyNavigation,
    resolveChoice,
  };
})(globalThis);
