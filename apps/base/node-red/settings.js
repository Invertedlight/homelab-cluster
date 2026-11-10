// Node-RED settings for skynet (mounted read-only at /config/settings.js).
// Secrets come from env vars set by the node-red-admin Secret; nothing sensitive lives here.
const dashboardGuard = require("./http-node-auth.js");

const adminUser = process.env.NODE_RED_ADMIN_USER || "";
const adminHash = process.env.NODE_RED_ADMIN_HASH || "";
const guard = dashboardGuard.createDashboardGuard({
    user: adminUser,
    hash: adminHash,
    uiPath: "ui",
});

module.exports = {
    // Runtime copy on the Longhorn volume. Git exports are mounted at /gitops
    // and copied here only when this file is absent. flows_cred.json stays on
    // the volume with the credential secret from the node-red-admin Secret.
    flowFile: 'flows.json',
    flowFilePretty: true,
    uiPort: process.env.PORT || 1880,
    credentialSecret: process.env.NODE_RED_CREDENTIAL_SECRET,
    adminAuth: {
        type: "credentials",
        users: [{
            username: adminUser,
            password: adminHash,
            permissions: "*"
        }]
    },
    // Function form, not {user, pass}. The object form is mounted on the shared
    // HTTP app, and node-red-dashboard 3.6 serves /ui from that app, so it would
    // challenge the graphs. Widget messages travel on socket.io, which engine.io
    // accepts before Express; ui.ioMiddleware filters those.
    httpNodeAuth: guard.httpNodeAuth,
    ui: {
        path: "ui",
        ioMiddleware: guard.dashboardIoMiddleware,
    },
};
