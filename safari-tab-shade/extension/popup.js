(function () {
  const api = globalThis.browser ?? globalThis.chrome;
  const Color = globalThis.TabShadeColor;
  const standalone = !api || !api.tabs;

  const els = {
    enabled: document.querySelector("#enabled"),
    preview: document.querySelector("#preview"),
    favicon: document.querySelector("#favicon"),
    monogram: document.querySelector("#monogram"),
    title: document.querySelector("#tab-title"),
    summary: document.querySelector("#summary"),
    status: document.querySelector("#status"),
    auto: document.querySelector("#mode-auto"),
    off: document.querySelector("#mode-off"),
    subdomains: document.querySelector("#subdomains"),
    swatches: document.querySelector("#swatches"),
    form: document.querySelector("#hex-form"),
    hex: document.querySelector("#hex"),
    tabOnly: document.querySelector("#tab-only"),
    showStrip: document.querySelector("#show-strip"),
    showEmoji: document.querySelector("#show-emoji"),
    showFavicon: document.querySelector("#show-favicon"),
    windowColor: document.querySelector("#window-color"),
    windowClear: document.querySelector("#window-clear"),
    selectedColor: document.querySelector("#selected-color"),
    selectedClear: document.querySelector("#selected-clear"),
    tabList: document.querySelector("#tab-list"),
    note: document.querySelector("#note"),
  };

  const selected = new Set();
  let draftColor = null;
  let openTabs = [];
  let model = standalone ? blankModel() : null;
  let state = standalone ? derive(model) : null;

  function blankModel() {
    return {
      enabled: true,
      showStrip: true,
      showEmoji: true,
      showFavicon: true,
      hosts: {},
      urls: {},
      session: {},
      tab: {
        id: 1,
        title: "GitHub",
        url: "https://github.com/",
        favIconUrl: "",
      },
      windowTabs: [
        { id: 1, title: "GitHub", url: "https://github.com/", active: true },
        { id: 2, title: "Inbox", url: "https://mail.google.com/mail/u/0/", active: false },
        { id: 3, title: "Maps", url: "https://maps.google.com/", active: false },
      ],
    };
  }

  function hostOf(url) {
    try {
      return Color.hostKey(new URL(url).hostname);
    } catch (_error) {
      return "";
    }
  }

  function colorFor(tab, snapshot) {
    if (!tab || !snapshot) return null;
    const host = hostOf(tab.url);
    if (!host) return null;
    const urls = snapshot.urls || {};
    const urlEntry = urls[Color.urlKey(tab.url)];
    const session = snapshot.session || {};
    const resolved = Color.resolveChoice({
      enabled: snapshot.enabled,
      showStrip: snapshot.showStrip,
      showEmoji: snapshot.showEmoji,
      showFavicon: snapshot.showFavicon,
      host,
      hosts: snapshot.hosts || {},
      sessionEntry: session[String(tab.id)] || null,
      urlColor: urlEntry ? urlEntry.color : null,
    });
    return resolved.color;
  }

  function derive(raw) {
    const tab = raw.tab;
    const host = tab ? hostOf(tab.url) : "";
    const urlEntry = tab && raw.urls[Color.urlKey(tab.url)];
    const resolved = Color.resolveChoice({
      enabled: raw.enabled,
      showStrip: raw.showStrip,
      showEmoji: raw.showEmoji,
      showFavicon: raw.showFavicon,
      host,
      hosts: raw.hosts,
      sessionEntry: tab ? raw.session[String(tab.id)] : null,
      urlColor: urlEntry ? urlEntry.color : null,
    });
    const entry = host ? raw.hosts[host] : null;
    return {
      enabled: raw.enabled,
      showStrip: raw.showStrip,
      showEmoji: raw.showEmoji,
      showFavicon: raw.showFavicon,
      hosts: raw.hosts,
      urls: raw.urls,
      session: raw.session,
      tab,
      host: resolved.host,
      source: resolved.source,
      color: resolved.color,
      matchedHost: resolved.matchedHost,
      hostMode: entry && entry.mode === "off" ? "off" : entry && entry.mode === "custom" ? "custom" : "auto",
      hostColor: entry && entry.mode === "custom" ? Color.normalizeHex(entry.color) : null,
      hostSubdomains: !!(entry && entry.subdomains),
      tabColor: resolved.source === "tab" ? resolved.color : null,
    };
  }

  function sourceLabel(current) {
    if (current.source === "unsupported") return "This page stays on Safari’s own tab color.";
    if (current.source === "disabled") return "Tab Shade is off.";
    if (current.source === "off" && current.matchedHost && current.matchedHost !== current.host) {
      return `${current.host} stays on the page color because ${current.matchedHost} includes subdomains.`;
    }
    if (current.source === "off") return `${current.host} keeps the page’s own color.`;
    if (current.source === "tab") return `${current.host} · this tab`;
    if (current.source === "subdomain") return `${current.host} · same as ${current.matchedHost}`;
    if (current.source === "custom") return `${current.host} · chosen color`;
    return `${current.host} · automatic`;
  }

  function chosenColor() {
    const typed = Color.normalizeHex(els.hex.value);
    if (typed) return typed;
    if (draftColor) return draftColor;
    return state && state.color ? state.color : null;
  }

  function renderTabs() {
    const rows = openTabs.filter((tab) => hostOf(tab.url));
    if (rows.length === 0) {
      const empty = document.createElement("li");
      empty.className = "empty";
      empty.textContent = "No site tabs in this window.";
      els.tabList.replaceChildren(empty);
      return;
    }
    els.tabList.replaceChildren(...rows.map((tab) => {
      const item = document.createElement("li");
      const label = document.createElement("label");
      label.className = "tab-row";
      if (tab.active) label.classList.add("is-active");
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = selected.has(tab.id);
      box.addEventListener("change", () => {
        if (box.checked) selected.add(tab.id);
        else selected.delete(tab.id);
      });
      const dot = document.createElement("span");
      dot.className = "dot";
      const color = colorFor(tab, state);
      if (color) dot.style.background = color;
      const copy = document.createElement("span");
      copy.className = "tab-copy";
      const name = document.createElement("span");
      name.className = "tab-name";
      name.textContent = Color.stripTitlePrefix(tab.title || "") || hostOf(tab.url);
      const host = document.createElement("span");
      host.className = "tab-host";
      host.textContent = hostOf(tab.url);
      copy.append(name, host);
      label.append(box, dot, copy);
      item.append(label);
      return item;
    }));
  }

  function render() {
    const current = state;
    const off = !current || !current.enabled;
    const unsupported = !!(current && current.source === "unsupported");
    document.body.classList.toggle("is-off", off);
    document.body.classList.toggle("is-unsupported", unsupported && !off);

    els.enabled.checked = !!(current && current.enabled);
    els.showStrip.checked = !!(current && current.showStrip);
    els.showEmoji.checked = !!(current && current.showEmoji);
    els.showFavicon.checked = !!(current && current.showFavicon);
    els.tabOnly.checked = !!(current && current.tabColor);
    els.subdomains.checked = !!(current && current.hostSubdomains);
    els.subdomains.disabled = !current || current.hostMode === "auto";
    els.auto.setAttribute("aria-pressed", current && current.hostMode === "auto" && !current.tabColor ? "true" : "false");
    els.off.setAttribute("aria-pressed", current && current.hostMode === "off" && !current.tabColor ? "true" : "false");

    const color = draftColor || (current && current.color) || "#8e8e93";
    const ink = Color.textOn(color);
    const filled = !!(draftColor || (current && current.color));
    els.preview.style.background = filled ? color : "var(--fill)";
    els.preview.style.color = filled ? ink : "var(--text)";
    const rawTitle = current && current.tab && current.tab.title ? Color.stripTitlePrefix(current.tab.title) : "Tab";
    els.title.textContent = current && current.showEmoji && filled
      ? Color.applyTitlePrefix(rawTitle, Color.markerFor(color))
      : rawTitle;
    els.summary.textContent = current ? sourceLabel(current) : "";
    els.hex.value = draftColor || (current && current.color) || "";

    const pageIcon = current && current.tab ? current.tab.favIconUrl : "";
    const icon = current && current.showFavicon && filled ? Color.faviconDataUrl(color) : pageIcon;
    if (icon) {
      els.favicon.hidden = false;
      els.favicon.src = icon;
      els.monogram.hidden = true;
    } else {
      els.favicon.hidden = true;
      els.favicon.removeAttribute("src");
      els.monogram.hidden = false;
      els.monogram.textContent = ((current && current.host) || "?").slice(0, 1).toUpperCase();
      els.monogram.style.color = filled ? ink : "var(--text)";
    }

    const picked = draftColor || (current && (current.source === "custom" || current.source === "tab" || current.source === "subdomain") ? current.color : null);
    els.swatches.replaceChildren(...Color.PALETTE.map((swatch) => {
      const button = document.createElement("button");
      button.type = "button";
      button.style.background = swatch;
      button.setAttribute("role", "option");
      button.setAttribute("aria-label", swatch);
      button.setAttribute("aria-selected", picked === swatch ? "true" : "false");
      button.addEventListener("click", () => choose(swatch));
      return button;
    }));

    renderTabs();
    els.note.textContent = "Safari paints the tab bar from the tab you are looking at. The emoji stays at the front of the title, so it remains when the title is cut off. Safari may keep a site’s cached icon. On Safari 26 the strip needs Settings → Tabs → Show color in tab bar.";
  }

  function say(message) {
    els.status.textContent = message || "";
  }

  async function call(message) {
    if (standalone) {
      applyStandalone(message);
      return null;
    }
    const response = await api.runtime.sendMessage(message);
    if (response && response.error) throw new Error(response.error);
    return response;
  }

  function applyStandalone(message) {
    if (message.type === "setEnabled") model.enabled = !!message.enabled;
    if (message.type === "setShowStrip") model.showStrip = !!message.showStrip;
    if (message.type === "setShowEmoji") model.showEmoji = !!message.showEmoji;
    if (message.type === "setShowFavicon") model.showFavicon = !!message.showFavicon;
    if (message.type === "setHost") {
      const key = Color.hostKey(message.host);
      if (!key) throw new Error("Missing site");
      if (message.mode === "auto") delete model.hosts[key];
      else if (message.mode === "off") model.hosts[key] = { mode: "off", subdomains: !!message.subdomains };
      else if (message.mode === "custom") {
        const hex = Color.normalizeHex(message.color);
        if (!hex) throw new Error("Enter a color like #2f6fbe");
        model.hosts[key] = { mode: "custom", color: hex, subdomains: !!message.subdomains };
      }
    }
    if (message.type === "setTabColor" || message.type === "setTabsColor") {
      const ids = message.type === "setTabColor" ? [message.tabId] : message.tabIds || [];
      const tabs = ids.map((id) => model.windowTabs.find((item) => item.id === id)).filter(Boolean);
      const result = Color.applyTabColors(model.session, model.urls, tabs, message.color || null, Date.now());
      if (!result.ok) throw new Error(result.error);
      model.session = result.session;
      model.urls = result.urls;
    }
  }

  async function reload() {
    if (standalone) {
      state = derive(model);
      openTabs = model.windowTabs;
      render();
      return;
    }
    const [active] = await api.tabs.query({ active: true, currentWindow: true });
    state = await api.runtime.sendMessage({ type: "getState", tabId: active ? active.id : null });
    if (state && state.error) throw new Error(state.error);
    const tabs = await api.tabs.query({ currentWindow: true });
    openTabs = tabs.map((tab) => ({
      id: tab.id,
      title: tab.title || "",
      url: tab.url || "",
      active: !!tab.active,
    }));
    render();
  }

  async function choose(color) {
    say("");
    const hex = Color.normalizeHex(color);
    if (!hex) {
      say("Use a hex color, like #2f6fbe.");
      return;
    }
    if (!state || !state.host || state.source === "unsupported") {
      draftColor = hex;
      render();
      return;
    }
    draftColor = null;
    try {
      if (els.tabOnly.checked) {
        if (!state.tab || state.tab.id == null) throw new Error("This page has no tab to color.");
        await call({ type: "setTabColor", tabId: state.tab.id, color: hex });
      } else {
        await call({
          type: "setHost",
          host: state.host,
          mode: "custom",
          color: hex,
          subdomains: els.subdomains.checked,
        });
        if (state.tabColor && state.tab && state.tab.id != null) {
          await call({ type: "setTabColor", tabId: state.tab.id, color: null });
        }
      }
      await reload();
    } catch (error) {
      say(error.message);
    }
  }

  async function paintTabs(ids, color) {
    say("");
    if (!ids.length) {
      say("Select one or more tabs.");
      return;
    }
    if (color && !Color.normalizeHex(color)) {
      say("Pick a color first.");
      return;
    }
    try {
      await call({ type: "setTabsColor", tabIds: ids, color: color || null });
      draftColor = null;
      await reload();
    } catch (error) {
      say(error.message);
    }
  }

  function siteTabs() {
    return openTabs.filter((tab) => hostOf(tab.url));
  }

  els.enabled.addEventListener("change", async () => {
    say("");
    try {
      await call({ type: "setEnabled", enabled: els.enabled.checked });
      await reload();
    } catch (error) {
      say(error.message);
    }
  });

  async function setMarker(type, key, value) {
    say("");
    try {
      const message = { type };
      message[key] = value;
      await call(message);
      await reload();
    } catch (error) {
      say(error.message);
    }
  }

  els.showStrip.addEventListener("change", () => setMarker("setShowStrip", "showStrip", els.showStrip.checked));
  els.showEmoji.addEventListener("change", () => setMarker("setShowEmoji", "showEmoji", els.showEmoji.checked));
  els.showFavicon.addEventListener("change", () => setMarker("setShowFavicon", "showFavicon", els.showFavicon.checked));

  els.auto.addEventListener("click", async () => {
    say("");
    try {
      await call({ type: "setHost", host: state.host, mode: "auto" });
      if (state.tab && state.tab.id != null) await call({ type: "setTabColor", tabId: state.tab.id, color: null });
      draftColor = null;
      await reload();
    } catch (error) {
      say(error.message);
    }
  });

  els.off.addEventListener("click", async () => {
    say("");
    try {
      await call({
        type: "setHost",
        host: state.host,
        mode: "off",
        subdomains: els.subdomains.checked,
      });
      if (state.tab && state.tab.id != null) await call({ type: "setTabColor", tabId: state.tab.id, color: null });
      draftColor = null;
      await reload();
    } catch (error) {
      say(error.message);
    }
  });

  els.subdomains.addEventListener("change", async () => {
    say("");
    if (!state || state.hostMode === "auto" || !state.host) return;
    try {
      await call({
        type: "setHost",
        host: state.host,
        mode: state.hostMode,
        color: state.hostColor,
        subdomains: els.subdomains.checked,
      });
      await reload();
    } catch (error) {
      say(error.message);
    }
  });

  els.form.addEventListener("submit", (event) => {
    event.preventDefault();
    choose(els.hex.value);
  });

  els.tabOnly.addEventListener("change", async () => {
    say("");
    if (!state || !state.tab || state.tab.id == null || !state.host) return;
    try {
      if (els.tabOnly.checked) {
        const color = chosenColor() || Color.autoColor(state.host);
        await call({ type: "setTabColor", tabId: state.tab.id, color });
      } else {
        await call({ type: "setTabColor", tabId: state.tab.id, color: null });
      }
      draftColor = null;
      await reload();
    } catch (error) {
      say(error.message);
    }
  });

  els.windowColor.addEventListener("click", () => {
    const color = chosenColor();
    if (!color) {
      say("Pick a color first.");
      return;
    }
    paintTabs(siteTabs().map((tab) => tab.id), color);
  });

  els.windowClear.addEventListener("click", () => {
    paintTabs(siteTabs().map((tab) => tab.id), null);
  });

  els.selectedColor.addEventListener("click", () => {
    const color = chosenColor();
    if (!color) {
      say("Pick a color first.");
      return;
    }
    paintTabs([...selected], color);
  });

  els.selectedClear.addEventListener("click", () => {
    paintTabs([...selected], null);
  });

  els.favicon.addEventListener("error", () => {
    els.favicon.hidden = true;
    els.monogram.hidden = false;
  });

  reload().catch((error) => {
    say(error.message);
  });
})();
