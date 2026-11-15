const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const express = require("express");
const { loadModuleWithMocks } = require("../helpers/loadModuleWithMocks");

async function serverFor(enabled) {
    const previous = process.env.SECURE_ADMIN_ENABLED;
    process.env.SECURE_ADMIN_ENABLED = String(enabled);
    const writes = [
        "create", "update", "updateRole", "updateStatus", "resetPassword",
        "uploadAvatar", "delete", "updatePermissions", "createRole", "updateRoleProfile",
        "deactivateRole", "getUserExceptions", "updateUserExceptions"
    ];
    const handlers = (mode) => Object.fromEntries(writes.map((name) =>
        [name, (_req, res) => res.json({ mode, name })]
    ));
    const noop = (_req, _res, next) => next();
    const reads = Object.fromEntries(["list", "getById", "roles", "permissions"].map((name) => [name, noop]));
    let router;
    try {
        ({ adminRouter: router } = loadModuleWithMocks(path.resolve(__dirname, "../../src/routes/adminRoutes.js"), {
            "../controllers/userController": { userController: { ...reads, ...handlers("legacy") } },
            "../controllers/secureAdminController": { secureAdminController: handlers("secure") },
            "../middleware/authMiddleware": {
                requireAuthenticated: noop,
                requirePermission: () => noop,
                requireCsrf: (req, res, next) => req.get("x-csrf-token") === "valid"
                    ? next() : res.status(403).send()
            },
            "../middleware/userAvatarUploadMiddleware": { uploadUserAvatar: noop }
        }));
    } finally {
        if (previous === undefined) delete process.env.SECURE_ADMIN_ENABLED;
        else process.env.SECURE_ADMIN_ENABLED = previous;
    }
    const app = express();
    app.use(router);
    const server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    return server;
}

for (const enabled of [false, true]) {
    test(`administrative write routes use ${enabled ? "secure" : "legacy"} handlers with CSRF`, async (t) => {
        const server = await serverFor(enabled);
        t.after(() => new Promise((resolve) => server.close(resolve)));
        const base = `http://127.0.0.1:${server.address().port}`;
        for (const [method, route, name] of [
            ["POST", "/users", "create"], ["PATCH", "/users/u", "update"],
            ["PATCH", "/users/u/role", "updateRole"], ["PATCH", "/users/u/status", "updateStatus"],
            ["PATCH", "/users/u/password", "resetPassword"], ["POST", "/users/u/avatar", "uploadAvatar"],
            ["DELETE", "/users/u", "delete"], ["PATCH", "/roles/r/permissions", "updatePermissions"]
        ]) {
            const denied = await fetch(base + route, { method });
            assert.equal(denied.status, 403);
            const response = await fetch(base + route, { method, headers: { "x-csrf-token": "valid" } });
            assert.deepEqual(await response.json(), { mode: enabled ? "secure" : "legacy", name });
        }

    });
}

test("module administration requires both flags and CSRF on writes", async (t) => {
    const previousModule = process.env.MODULE_PERMISSIONS_ENABLED;
    const previousSecure = process.env.SECURE_ADMIN_ENABLED;
    process.env.SECURE_ADMIN_ENABLED = "true";
    process.env.MODULE_PERMISSIONS_ENABLED = "true";
    t.after(() => {
        if (previousModule === undefined) delete process.env.MODULE_PERMISSIONS_ENABLED;
        else process.env.MODULE_PERMISSIONS_ENABLED = previousModule;
        if (previousSecure === undefined) delete process.env.SECURE_ADMIN_ENABLED;
        else process.env.SECURE_ADMIN_ENABLED = previousSecure;
    });
    const server = await serverFor(true);
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const [method, route, name] of [
        ["POST", "/roles", "createRole"], ["PATCH", "/roles/r", "updateRoleProfile"],
        ["POST", "/roles/r/deactivate", "deactivateRole"],
        ["GET", "/users/u/permissions", "getUserExceptions"],
        ["PATCH", "/users/u/permissions", "updateUserExceptions"]
    ]) {
        if (method !== "GET") assert.equal((await fetch(base + route, { method })).status, 403);
        const response = await fetch(base + route, { method, headers: { "x-csrf-token": "valid" } });
        assert.deepEqual(await response.json(), { mode: "secure", name });
        process.env.MODULE_PERMISSIONS_ENABLED = "false";
        assert.equal((await fetch(base + route, { method, headers: { "x-csrf-token": "valid" } })).status, 404);
        process.env.MODULE_PERMISSIONS_ENABLED = "true";
    }
});
