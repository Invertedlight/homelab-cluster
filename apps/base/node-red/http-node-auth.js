// HTTP and dashboard-socket gate for the skynet Node-RED pod.
//
// node-red-dashboard 3.6 (the palette's node-red-dashboard@~3.6.0, not
// @flowfuse/node-red-dashboard) serves /ui on the same Express app as HTTP In
// nodes, and attaches socket.io to the raw HTTP server. engine.io takes
// /ui/socket.io before Express runs, so an httpNodeAuth {user, pass} object
// would challenge the graphs and still would not see widget messages.
//
// This module reuses the admin username and bcrypt (or legacy md5) hash.
// It does not read the environment itself; settings.js passes those values.
"use strict";

const crypto = require("crypto");

const LOGIN_PATH = "/node-red-http-login";
// ui-replay-state is the browser asking for the latest widget values. That is
// what draws the gauges and charts. Every other client event can enter a node:
// update-value sends the widget's message, ui-change makes charts receive,
// and collapse / audio / params / refresh write server state or feed ui_control.
const ANONYMOUS_CLIENT_EVENTS = new Set(["ui-replay-state"]);

const REALM = 'Basic realm="Node-RED"';

let bcryptImpl = undefined;

// settings.js is mounted at /config, outside the image's node_modules.
// Node-RED's own red.js resolves these packages from /usr/src/node-red.
// NODE_PATH on the official image also lists that directory; the absolute
// paths cover a pod where that variable is unset.
const BCRYPT_CANDIDATES = [
  "@node-rs/bcrypt",
  "bcryptjs",
  "/usr/src/node-red/node_modules/@node-rs/bcrypt",
  "/usr/src/node-red/node_modules/bcryptjs",
];

function loadBcrypt() {
  if (bcryptImpl !== undefined) {
    return bcryptImpl;
  }
  for (let i = 0; i < BCRYPT_CANDIDATES.length; i++) {
    try {
      const loaded = require(BCRYPT_CANDIDATES[i]);
      if (loaded && typeof loaded.compareSync === "function") {
        bcryptImpl = loaded;
        return bcryptImpl;
      }
    } catch (err) {
      // This candidate is not installed. Try the next one.
    }
  }
  bcryptImpl = null;
  return bcryptImpl;
}

function defaultCompare(password, hash) {
  if (typeof password !== "string" || typeof hash !== "string" || hash === "") {
    return false;
  }
  // Same split Node-RED uses for httpNodeAuth: a 32-char hex string is a legacy md5.
  if (hash.length === 32 && /^[a-fA-F0-9]{32}$/.test(hash)) {
    const digest = crypto.createHash("md5").update(password, "utf8").digest("hex");
    return digest.toLowerCase() === hash.toLowerCase();
  }
  const bcrypt = loadBcrypt();
  if (!bcrypt || typeof bcrypt.compareSync !== "function") {
    return false;
  }
  try {
    return bcrypt.compareSync(password, hash) === true;
  } catch (err) {
    return false;
  }
}

function requestPath(req) {
  const raw = String((req && (req.originalUrl || req.url)) || "/");
  const noQuery = raw.split("?")[0].split("#")[0];
  let decoded;
  try {
    decoded = decodeURIComponent(noQuery);
  } catch (err) {
    return null;
  }
  if (decoded.indexOf("\\") !== -1 || decoded.charAt(0) !== "/") {
    return null;
  }
  const parts = [];
  const segments = decoded.split("/");
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      return null;
    }
    parts.push(segment);
  }
  return "/" + parts.join("/");
}

function methodOf(req) {
  return String((req && req.method) || "").toUpperCase();
}

function publicDashboardPaths(uiPath) {
  const trimmed = String(uiPath || "ui").replace(/^\/+|\/+$/g, "");
  const root = "/" + trimmed;
  return {
    files: new Set([
      root,
      root + "/index.html",
      root + "/manifest.json",
      root + "/i18n.js",
      root + "/dashboard.appcache",
      root + "/icon64x64.png",
      root + "/icon120x120.png",
      root + "/icon192x192.png",
    ]),
    prefixes: [root + "/css/", root + "/js/", root + "/fonts/"],
  };
}

function isPublicDashboardRead(req, paths) {
  const method = methodOf(req);
  if (method !== "GET" && method !== "HEAD") {
    return false;
  }
  const path = requestPath(req);
  if (!path) {
    return false;
  }
  if (paths.files.has(path)) {
    return true;
  }
  for (let i = 0; i < paths.prefixes.length; i++) {
    const prefix = paths.prefixes[i];
    if (path.startsWith(prefix) && path.length > prefix.length) {
      return true;
    }
  }
  return false;
}

function headerValue(headers, name) {
  if (!headers) {
    return "";
  }
  const direct = headers[name] !== undefined ? headers[name] : headers[name.toLowerCase()];
  if (Array.isArray(direct)) {
    return direct.length ? String(direct[0]) : "";
  }
  return direct === undefined || direct === null ? "" : String(direct);
}

function parseBasic(header) {
  const match = /^Basic\s+([A-Za-z0-9+/]+=*)$/i.exec(String(header || "").trim());
  if (!match) {
    return null;
  }
  let decoded;
  try {
    decoded = Buffer.from(match[1], "base64").toString("utf8");
  } catch (err) {
    return null;
  }
  const split = decoded.indexOf(":");
  if (split < 0) {
    return null;
  }
  return { name: decoded.slice(0, split), pass: decoded.slice(split + 1) };
}

function connectionUrl(socket) {
  const conn = socket && socket.client && socket.client.conn;
  const fromConn = conn && conn.request && conn.request.url;
  if (typeof fromConn === "string") {
    return fromConn;
  }
  if (socket && socket.handshake && typeof socket.handshake.url === "string") {
    return socket.handshake.url;
  }
  if (socket && socket.request && typeof socket.request.url === "string") {
    return socket.request.url;
  }
  return null;
}

function socketHeaders(socket) {
  if (socket && socket.handshake && socket.handshake.headers) {
    return socket.handshake.headers;
  }
  if (socket && socket.request && socket.request.headers) {
    return socket.request.headers;
  }
  return {};
}

function createDashboardGuard(options) {
  const opts = options || {};
  const user = typeof opts.user === "string" ? opts.user : "";
  const hash = typeof opts.hash === "string" ? opts.hash : "";
  const compare = typeof opts.compare === "function" ? opts.compare : defaultCompare;
  const paths = publicDashboardPaths(opts.uiPath || "ui");
  let cachedPassword;

  function passwordOk(candidate) {
    if (!user || !hash || !candidate || candidate.name !== user) {
      return false;
    }
    if (cachedPassword !== undefined && cachedPassword === candidate.pass) {
      return true;
    }
    let ok = false;
    try {
      ok = compare(candidate.pass, hash) === true;
    } catch (err) {
      ok = false;
    }
    if (ok) {
      cachedPassword = candidate.pass;
    }
    return ok;
  }

  function authorized(headers) {
    return passwordOk(parseBasic(headerValue(headers, "authorization")));
  }

  function unauthorized(res) {
    res.set("WWW-Authenticate", REALM);
    res.sendStatus(401);
  }

  function httpNodeAuth(req, res, next) {
    const method = methodOf(req);
    if (method === "OPTIONS") {
      return next();
    }
    if (isPublicDashboardRead(req, paths)) {
      return next();
    }
    const path = requestPath(req);
    if (path === LOGIN_PATH && (method === "GET" || method === "HEAD")) {
      if (!authorized(req.headers)) {
        return unauthorized(res);
      }
      res.status(200);
      if (method === "HEAD") {
        return res.end();
      }
      res.type("text/plain");
      return res.send(
        "Authenticated.\n" +
          "Reload /ui. This browser can operate dashboard controls.\n" +
          "Graphs on /ui stay visible without this login.\n"
      );
    }
    if (!authorized(req.headers)) {
      return unauthorized(res);
    }
    return next();
  }

  function dashboardIoMiddleware(socket, next) {
    const url = connectionUrl(socket);
    if (url === null) {
      return next(new Error("dashboard socket url unavailable"));
    }
    if (url.indexOf("transport=websocket") !== -1) {
      const conn = socket && socket.client && socket.client.conn;
      if (conn && typeof conn.close === "function") {
        conn.close();
      }
      return;
    }
    const handshake = socket && socket.handshake;
    if (!handshake || handshake.xdomain !== false) {
      if (socket && typeof socket.disconnect === "function") {
        socket.disconnect(true);
      }
      return;
    }
    if (!authorized(socketHeaders(socket))) {
      if (!socket || typeof socket.onevent !== "function") {
        return next(new Error("dashboard input filter unavailable"));
      }
      const original = socket.onevent;
      socket.onevent = function (packet) {
        const data = packet && packet.data;
        const eventName = Array.isArray(data) ? data[0] : undefined;
        if (!ANONYMOUS_CLIENT_EVENTS.has(eventName)) {
          return;
        }
        return original.call(socket, packet);
      };
    }
    return next();
  }

  return {
    httpNodeAuth: httpNodeAuth,
    dashboardIoMiddleware: dashboardIoMiddleware,
    authorized: authorized,
  };
}

module.exports = {
  LOGIN_PATH: LOGIN_PATH,
  ANONYMOUS_CLIENT_EVENTS: ANONYMOUS_CLIENT_EVENTS,
  createDashboardGuard: createDashboardGuard,
  requestPath: requestPath,
  defaultCompare: defaultCompare,
  parseBasic: parseBasic,
};
