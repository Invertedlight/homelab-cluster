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

  // WebKit's tab-bar sampler hit-tests about 4px below the top of the viewport and
  // ignores a fixed box whose border-box is 10px or shorter. The strip has to cover
  // that point and be taller than 10px. See LocalFrameView::fixedContainerEdges.
  const STRIP = {
    top: 0,
    height: 12,
    samplePoint: 4,
    minBox: 11,
  };

  function hostKey(hostname) {
    if (typeof hostname !== "string") return "";
    let host = hostname.trim().toLowerCase();
    if (host.endsWith(".")) host = host.slice(0, -1);
    if (host.startsWith("www.")) host = host.slice(4);
    return host;
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

  function textOn(hex) {
    const color = normalizeHex(hex);
    if (!color) return "#ffffff";
    const value = Number.parseInt(color.slice(1), 16);
    const red = (value >> 16) & 255;
    const green = (value >> 8) & 255;
    const blue = value & 255;
    const luminance = (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;
    return luminance > 0.62 ? "#1c1c1e" : "#ffffff";
  }

  function resolveChoice({ enabled, showStrip, host, hostEntry, tabColor }) {
    const key = hostKey(host);
    const strip = showStrip !== false;
    if (!key) return { color: null, host: null, source: "unsupported", showStrip: strip };
    if (!enabled) return { color: null, host: key, source: "disabled", showStrip: strip };
    const override = normalizeHex(tabColor);
    if (override) return { color: override, host: key, source: "tab", showStrip: strip };
    if (hostEntry && hostEntry.mode === "off") {
      return { color: null, host: key, source: "off", showStrip: strip };
    }
    if (hostEntry && hostEntry.mode === "custom") {
      const custom = normalizeHex(hostEntry.color);
      if (custom) return { color: custom, host: key, source: "custom", showStrip: strip };
    }
    return { color: autoColor(key), host: key, source: "auto", showStrip: strip };
  }

  root.TabShadeColor = {
    PALETTE,
    STRIP,
    hostKey,
    autoColor,
    normalizeHex,
    textOn,
    resolveChoice,
  };
})(globalThis);
