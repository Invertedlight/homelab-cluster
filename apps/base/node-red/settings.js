// Node-RED settings for skynet (mounted read-only at /config/settings.js).
// Secrets come from env vars set by the node-red-admin Secret; nothing sensitive lives here.
module.exports = {
    flowFile: 'flows.json',
    flowFilePretty: true,
    uiPort: process.env.PORT || 1880,
    credentialSecret: process.env.NODE_RED_CREDENTIAL_SECRET,
    adminAuth: {
        type: "credentials",
        users: [{
            username: process.env.NODE_RED_ADMIN_USER,
            password: process.env.NODE_RED_ADMIN_HASH,
            permissions: "*"
        }]
    }
};
