// Exercises the dashboard HTTP and socket gate. No cluster and no secret file.
"use strict";

const crypto = require("crypto");
const assert = require("assert");
const auth = require("./http-node-auth.js");

function fail(message) {
  console.error("FAIL: " + message);
  process.exit(1);
}

function ok(message) {
  console.log("ok: " + message);
}

function basic(user, pass) {
  return "Basic " + Buffer.from(user + ":" + pass, "utf8").toString("base64");
}

function invokeHttp(guard, method, url, headers) {
  const req = { method: method, originalUrl: url, headers: headers || {} };
  const sent = { status: undefined, body: undefined, ended: false, www: undefined, next: false };
  const res = {
    set: function (name, value) {
      if (String(name).toLowerCase() === "www-authenticate") {
        sent.www = value;
      }
      return this;
    },
    status: function (code) {
      sent.status = code;
      return this;
    },
    sendStatus: function (code) {
      sent.status = code;
      sent.ended = true;
      return this;
    },
    type: function () {
      return this;
    },
    send: function (body) {
      sent.body = body;
      sent.ended = true;
      return this;
    },
    end: function () {
      sent.ended = true;
      return this;
    },
  };
  guard.httpNodeAuth(req, res, function () {
    sent.next = true;
  });
  return sent;
}

function fakeSocket(options) {
  const opts = options || {};
  const received = [];
  const socket = {
    handshake: {
      xdomain: opts.xdomain === undefined ? false : opts.xdomain,
      headers: opts.headers || {},
      url: opts.url || "",
    },
    request: { url: opts.url || "", headers: opts.headers || {} },
    client: {
      conn: {
        request: { url: opts.url || "" },
        close: function () {
          socket.closed = true;
        },
      },
    },
    closed: false,
    disconnected: false,
    disconnect: function () {
      socket.disconnected = true;
    },
    onevent: function (packet) {
      received.push(packet);
    },
    received: received,
  };
  return socket;
}

const guard = auth.createDashboardGuard({
  user: "ada",
  hash: "stored-hash",
  compare: function (password, hash) {
    return password === "correct" && hash === "stored-hash";
  },
});

const publicGets = [
  "/ui",
  "/ui/",
  "/ui/index.html",
  "/ui/css/app.min.css",
  "/ui/js/app.min.js",
  "/ui/fonts/MaterialIcons-Regular.woff2",
  "/ui/manifest.json",
  "/ui/icon192x192.png?cache=1",
  "/ui/./js/app.min.js",
];
publicGets.forEach(function (url) {
  const result = invokeHttp(guard, "GET", url, {});
  if (!result.next || result.status !== undefined) {
    fail("public dashboard read was challenged: " + url + " " + JSON.stringify(result));
  }
});
const head = invokeHttp(guard, "HEAD", "/ui/css/app.min.css", {});
if (!head.next) {
  fail("HEAD of a dashboard asset was challenged");
}
ok("anonymous GET and HEAD of dashboard assets pass");

const denied = [
  ["GET", "/weather"],
  ["POST", "/weather"],
  ["PUT", "/hook"],
  ["DELETE", "/hook"],
  ["PATCH", "/hook"],
  ["GET", "/flows"],
  ["POST", "/ui"],
  ["POST", "/ui/index.html"],
  ["GET", "/ui/secret"],
  ["GET", "/ui/css/"],
  ["GET", "/ui/../weather"],
  ["GET", "/ui/%2e%2e/weather"],
  ["GET", "/ui/js/%2e%2e/%2e%2e/weather"],
  ["GET", "/UI"],
  ["GET", "/ui-extra"],
];
denied.forEach(function (pair) {
  const result = invokeHttp(guard, pair[0], pair[1], {});
  if (result.next || result.status !== 401 || !result.www) {
    fail("expected 401 for " + pair[0] + " " + pair[1] + " got " + JSON.stringify(result));
  }
});
ok("HTTP routes outside the dashboard assets require authentication");

const options = invokeHttp(guard, "OPTIONS", "/weather", {});
if (!options.next) {
  fail("OPTIONS did not pass through");
}
ok("OPTIONS reaches the HTTP In node so a preflight is not a 401");

const badLogin = invokeHttp(guard, "GET", "/node-red-http-login", {
  authorization: basic("ada", "nope"),
});
if (badLogin.next || badLogin.status !== 401) {
  fail("bad login was accepted");
}
const goodLogin = invokeHttp(guard, "GET", auth.LOGIN_PATH, {
  authorization: basic("ada", "correct"),
});
if (goodLogin.status !== 200 || goodLogin.next || String(goodLogin.body).indexOf("Reload /ui") === -1) {
  fail("good login did not answer on its own: " + JSON.stringify(goodLogin));
}
const goodHead = invokeHttp(guard, "HEAD", auth.LOGIN_PATH + "?from=bookmark", {
  authorization: basic("ada", "correct"),
});
if (goodHead.status !== 200 || goodHead.body) {
  fail("HEAD login returned a body");
}
ok("login URL challenges, then confirms the existing admin user");

const authed = invokeHttp(guard, "POST", "/weather", {
  authorization: basic("ada", "correct"),
});
if (!authed.next) {
  fail("authenticated HTTP In request was blocked");
}
const wrongUser = invokeHttp(guard, "POST", "/weather", {
  authorization: basic("eve", "correct"),
});
if (wrongUser.next || wrongUser.status !== 401) {
  fail("wrong user with the right password was accepted");
}
ok("authenticated HTTP In requests continue, other users do not");

let comparisons = 0;
const caching = auth.createDashboardGuard({
  user: "ada",
  hash: "stored-hash",
  compare: function (password, hash) {
    comparisons += 1;
    return password === "correct" && hash === "stored-hash";
  },
});
invokeHttp(caching, "POST", "/a", { authorization: basic("ada", "correct") });
invokeHttp(caching, "POST", "/b", { authorization: basic("ada", "correct") });
if (comparisons !== 1) {
  fail("password compare ran " + comparisons + " times");
}
ok("a matching password is compared once per process");

function runSocket(socket) {
  let called = false;
  let err = null;
  guard.dashboardIoMiddleware(socket, function (error) {
    called = true;
    err = error || null;
  });
  return { called: called, err: err };
}

const anon = fakeSocket({ url: "/ui/socket.io/?EIO=4&transport=polling" });
const anonResult = runSocket(anon);
if (!anonResult.called || anonResult.err || anon.disconnected) {
  fail("anonymous dashboard socket was rejected: " + JSON.stringify(anonResult));
}
["update-value", "ui-change", "ui-collapse", "ui-audio", "ui-params", "ui-refresh", "custom-event"].forEach(function (name) {
  anon.onevent({ data: [name, { id: "switch", value: true }] });
});
anon.onevent({ data: ["ui-replay-state"] });
anon.onevent({ data: "update-value" });
if (anon.received.length !== 1 || anon.received[0].data[0] !== "ui-replay-state") {
  fail("anonymous socket delivered client input: " + JSON.stringify(anon.received));
}
ok("anonymous sockets stay connected and only replay dashboard state");

const signedIn = fakeSocket({
  url: "/ui/socket.io/?EIO=4&transport=polling",
  headers: { authorization: basic("ada", "correct") },
});
const signedResult = runSocket(signedIn);
if (!signedResult.called || signedResult.err) {
  fail("authenticated socket was rejected");
}
signedIn.onevent({ data: ["update-value", { id: "switch", value: false }] });
if (signedIn.received.length !== 1 || signedIn.received[0].data[0] !== "update-value") {
  fail("authenticated widget event was dropped");
}
ok("a socket with the admin basic credentials can send widget input");

const wrong = fakeSocket({
  url: "/ui/socket.io/?transport=polling",
  headers: { authorization: basic("ada", "nope") },
});
runSocket(wrong);
wrong.onevent({ data: ["update-value", { value: true }] });
wrong.onevent({ data: ["ui-replay-state"] });
if (wrong.disconnected || wrong.received.length !== 1) {
  fail("a bad password closed the view or allowed input");
}
ok("a bad password still allows viewing and drops widget input");

const directWs = fakeSocket({ url: "/ui/socket.io/?transport=websocket" });
const wsResult = runSocket(directWs);
if (wsResult.called || !directWs.closed) {
  fail("direct websocket transport was allowed");
}
const cross = fakeSocket({ url: "/ui/socket.io/?transport=polling", xdomain: true });
const crossResult = runSocket(cross);
if (crossResult.called || !cross.disconnected) {
  fail("cross-origin dashboard socket was allowed");
}
ok("stock dashboard origin and transport checks still reject");

const md5 = crypto.createHash("md5").update("legacy", "utf8").digest("hex");
if (!auth.defaultCompare("legacy", md5) || auth.defaultCompare("other", md5)) {
  fail("legacy md5 compare failed");
}
if (auth.defaultCompare("legacy", "not-a-real-bcrypt-hash")) {
  fail("invalid hash compared as success");
}
ok("legacy md5 hashes compare, and an unusable hash does not");

process.env.NODE_RED_ADMIN_USER = "ada";
process.env.NODE_RED_ADMIN_HASH = md5;
process.env.NODE_RED_CREDENTIAL_SECRET = "not-used";
delete require.cache[require.resolve("./settings.js")];
const settings = require("./settings.js");
if (typeof settings.httpNodeAuth !== "function") {
  fail("settings.js httpNodeAuth is not a middleware function");
}
if (!settings.ui || settings.ui.path !== "ui" || typeof settings.ui.ioMiddleware !== "function") {
  fail("settings.js did not install dashboard ioMiddleware");
}
if (!settings.adminAuth || settings.adminAuth.users[0].username !== "ada" || settings.adminAuth.users[0].password !== md5) {
  fail("editor adminAuth no longer uses the admin env");
}
const fromSettings = invokeHttp(settings, "GET", "/ui", {});
if (!fromSettings.next) {
  fail("settings.js challenged a public dashboard read");
}
const settingsPost = invokeHttp(settings, "POST", "/ingest", {
  authorization: basic("ada", "legacy"),
});
if (!settingsPost.next) {
  fail("settings.js rejected the admin md5 password");
}
const settingsAnon = invokeHttp(settings, "POST", "/ingest", {});
if (settingsAnon.status !== 401) {
  fail("settings.js left an HTTP route open");
}
ok("settings.js reuses the admin env for editor auth, HTTP routes, and the dashboard socket");

if (auth.LOGIN_PATH !== "/node-red-http-login") {
  fail("login path drifted");
}
if (!auth.ANONYMOUS_CLIENT_EVENTS.has("ui-replay-state") || auth.ANONYMOUS_CLIENT_EVENTS.size !== 1) {
  fail("anonymous socket allowlist drifted");
}

let bcrypt = null;
try {
  bcrypt = require("@node-rs/bcrypt");
} catch (err) {
  try {
    bcrypt = require("bcryptjs");
  } catch (err2) {
    bcrypt = null;
  }
}
if (bcrypt && typeof bcrypt.hashSync === "function") {
  const hash = bcrypt.hashSync("s3cret-value", 8);
  if (!auth.defaultCompare("s3cret-value", hash) || auth.defaultCompare("other", hash)) {
    fail("bcrypt compare failed");
  }
  ok("installed bcrypt accepts the admin-style hash");
} else {
  ok("bcrypt library is not installed in this shell; the image provides it");
}

console.log("dashboard auth checks passed");
