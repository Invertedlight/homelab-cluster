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
    swatches: document.querySelector("#swatches"),
    form: document.querySelector("#hex-form"),
    hex: document.querySelector("#hex"),
    tabOnly: document.querySelector("#tab-only"),
    showStrip: document.querySelector("#show-strip"),
    note: document.querySelector("#note"),
  };

  let state = standalone ? previewState() : null;

  function previewState() {
    return {
      enabled: true,
      showStrip: true,
      tab: {
        id: 1,
        title: "GitHub",
        url: "https://github.com",
        favIconUrl: "",
      },
      host: "github.com",
      source: "auto",
      color: Color.autoColor("github.com"),
      hostMode: "auto",
      hostColor: null,
      tabColor: null,
    };
  }

  function sourceLabel(current) {
    if (current.source === "unsupported") return "This page stays on Safari’s own tab color.";
    if (current.source === "disabled") return "Tab Shade is off.";
    if (current.source === "off") return `${current.host} keeps the page’s own color.`;
    if (current.source === "tab") return `${current.host} · this tab only`;
    if (current.source === "custom") return `${current.host} · chosen color`;
    return `${current.host} · automatic`;
  }

  function render() {
    const current = state;
    const locked = !current || !current.enabled || current.source === "unsupported";
    document.body.classList.toggle("is-locked", locked);

    els.enabled.checked = !!(current && current.enabled);
    els.showStrip.checked = !!(current && current.showStrip);
    els.tabOnly.checked = !!(current && current.tabColor);
    els.auto.setAttribute("aria-pressed", current && current.hostMode === "auto" && !current.tabColor ? "true" : "false");
    els.off.setAttribute("aria-pressed", current && current.hostMode === "off" && !current.tabColor ? "true" : "false");

    const color = current && current.color ? current.color : "#8e8e93";
    const ink = Color.textOn(color);
    els.preview.style.background = color;
    els.preview.style.color = ink;
    els.title.textContent = current && current.tab && current.tab.title ? current.tab.title : "Tab";
    els.summary.textContent = current ? sourceLabel(current) : "";
    els.hex.value = current && current.color ? current.color : "";

    const icon = current && current.tab ? current.tab.favIconUrl : "";
    if (icon) {
      els.favicon.hidden = false;
      els.favicon.src = icon;
      els.monogram.hidden = true;
    } else {
      els.favicon.hidden = true;
      els.favicon.removeAttribute("src");
      els.monogram.hidden = false;
      els.monogram.textContent = ((current && current.host) || "?").slice(0, 1).toUpperCase();
      els.monogram.style.color = ink;
    }

    els.swatches.replaceChildren(...Color.PALETTE.map((swatch) => {
      const button = document.createElement("button");
      button.type = "button";
      button.style.background = swatch;
      button.setAttribute("role", "option");
      button.setAttribute("aria-label", swatch);
      button.setAttribute("aria-selected", current && current.color === swatch && (current.source === "custom" || current.source === "tab") ? "true" : "false");
      button.addEventListener("click", () => choose(swatch));
      return button;
    }));

    els.note.textContent = "Safari fills the tab bar with the active tab’s color and draws the site icon and title on top. Switching tabs switches the color. In Safari 26, turn on Settings → Tabs → Show color in tab bar. The top strip is how that version reads the color.";
  }

  function say(message) {
    els.status.textContent = message || "";
  }

  async function call(message) {
    if (standalone) return applyStandalone(message);
    const response = await api.runtime.sendMessage(message);
    if (response && response.error) throw new Error(response.error);
    return response;
  }

  function applyStandalone(message) {
    const next = { ...state };
    if (message.type === "setEnabled") next.enabled = !!message.enabled;
    if (message.type === "setShowStrip") next.showStrip = !!message.showStrip;
    if (message.type === "setTabColor") {
      next.tabColor = message.color ? Color.normalizeHex(message.color) : null;
    }
    if (message.type === "setHost") {
      if (message.mode === "auto") {
        next.hostMode = "auto";
        next.hostColor = null;
        next.tabColor = null;
      } else if (message.mode === "off") {
        next.hostMode = "off";
        next.hostColor = null;
        next.tabColor = null;
      } else if (message.mode === "custom") {
        const hex = Color.normalizeHex(message.color);
        if (!hex) throw new Error("Enter a color like #2f6fbe");
        next.hostMode = "custom";
        next.hostColor = hex;
      }
    }
    if (!next.enabled) next.source = "disabled";
    else if (next.tabColor) next.source = "tab";
    else if (next.hostMode === "off") next.source = "off";
    else if (next.hostMode === "custom") next.source = "custom";
    else next.source = "auto";
    if (next.source === "tab") next.color = next.tabColor;
    else if (next.source === "custom") next.color = next.hostColor;
    else if (next.source === "auto") next.color = Color.autoColor(next.host);
    else next.color = null;
    state = next;
    return next;
  }

  async function reload() {
    if (standalone) {
      render();
      return;
    }
    state = await api.runtime.sendMessage({ type: "getState" });
    if (state && state.error) throw new Error(state.error);
    render();
  }

  async function choose(color) {
    say("");
    try {
      if (els.tabOnly.checked) {
        if (!state.tab || state.tab.id == null) throw new Error("This page has no tab to color.");
        await call({ type: "setTabColor", tabId: state.tab.id, color });
      } else {
        await call({ type: "setHost", host: state.host, mode: "custom", color });
        if (state.tabColor) await call({ type: "setTabColor", tabId: state.tab.id, color: null });
      }
      if (!standalone) await reload();
      else render();
    } catch (error) {
      say(error.message);
    }
  }

  els.enabled.addEventListener("change", async () => {
    say("");
    try {
      await call({ type: "setEnabled", enabled: els.enabled.checked });
      if (!standalone) await reload();
      else render();
    } catch (error) {
      say(error.message);
    }
  });

  els.showStrip.addEventListener("change", async () => {
    say("");
    try {
      await call({ type: "setShowStrip", showStrip: els.showStrip.checked });
      if (!standalone) await reload();
      else render();
    } catch (error) {
      say(error.message);
    }
  });

  els.auto.addEventListener("click", async () => {
    say("");
    try {
      await call({ type: "setHost", host: state.host, mode: "auto" });
      if (state.tab && state.tab.id != null) await call({ type: "setTabColor", tabId: state.tab.id, color: null });
      if (!standalone) await reload();
      else render();
    } catch (error) {
      say(error.message);
    }
  });

  els.off.addEventListener("click", async () => {
    say("");
    try {
      await call({ type: "setHost", host: state.host, mode: "off" });
      if (state.tab && state.tab.id != null) await call({ type: "setTabColor", tabId: state.tab.id, color: null });
      if (!standalone) await reload();
      else render();
    } catch (error) {
      say(error.message);
    }
  });

  els.form.addEventListener("submit", (event) => {
    event.preventDefault();
    const hex = Color.normalizeHex(els.hex.value);
    if (!hex) {
      say("Use a hex color, like #2f6fbe.");
      return;
    }
    choose(hex);
  });

  els.tabOnly.addEventListener("change", async () => {
    say("");
    if (!state || !state.tab || state.tab.id == null || !state.host) return;
    try {
      if (els.tabOnly.checked) {
        const color = state.color || Color.autoColor(state.host);
        await call({ type: "setTabColor", tabId: state.tab.id, color });
      } else {
        await call({ type: "setTabColor", tabId: state.tab.id, color: null });
      }
      if (!standalone) await reload();
      else render();
    } catch (error) {
      say(error.message);
    }
  });

  els.favicon.addEventListener("error", () => {
    els.favicon.hidden = true;
    els.monogram.hidden = false;
  });

  reload().catch((error) => {
    say(error.message);
  });
})();
