const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const express = require("express");
const { loadModuleWithMocks } = require("../helpers/loadModuleWithMocks");

test("the secure role endpoint revalidates delegation and audits the committed HTTP change", async (t) => {
    const tokenHash = "c".repeat(64);
    let root = {
        authRoles: {
            admin: { name: "Admin", permissions: { "app:access": true, "users:manage": true, "roles:manage": true } },
            user: { name: "User", permissions: { "app:access": true } },
            inventory: { name: "Inventory", permissions: { "app:access": true, "module:inventory": true } }
        },
        authUsers: { actor: { roleId: "admin", sessionVersion: 1 }, target: { roleId: "user", sessionVersion: 0 } },
        authSessions: { [tokenHash]: { uid: "actor", sessionVersion: 1, expiresAt: Date.now() + 60000 } }
    };
    const database = { ref: () => ({ transaction: async (change) => {
        const next = change(structuredClone(root));
        if (next === undefined) return { committed: false };
        root = next;
        return { committed: true };
    } }) };
    const manager = loadModuleWithMocks(path.resolve(__dirname, "../../src/permissions/permissionManagement.js"), {
        "../services/authSessionService": { clearAuthenticationCache() {} }
    });
    const { secureAdminController } = loadModuleWithMocks(path.resolve(__dirname, "../../src/controllers/secureAdminController.js"), {
        "./authController": { getPublicUser: (user) => user },
        "../services/userService": { getProfileWithPermissions: async (id) => ({ id, ...root.authUsers[id] }) },
        "../permissions/permissionManagement": {
            ...manager, assignUserRole: (input) => manager.assignUserRole({ ...input, database })
        }
    });
    const noop = (_req, _res, next) => next();
    const previous = process.env.SECURE_ADMIN_ENABLED;
    process.env.SECURE_ADMIN_ENABLED = "true";
    let adminRouter;
    try {
        ({ adminRouter } = loadModuleWithMocks(path.resolve(__dirname, "../../src/routes/adminRoutes.js"), {
            "../controllers/secureAdminController": { secureAdminController },
            "../middleware/authMiddleware": {
                requireAuthenticated: (req, _res, next) => {
                    req.authUser = { id: "actor", sessionVersion: 1 };
                    req.authSession = { tokenHash };
                    next();
                },
                requirePermission: () => noop,
                requireCsrf: noop
            }
        }));
    } finally {
        if (previous === undefined) delete process.env.SECURE_ADMIN_ENABLED;
        else process.env.SECURE_ADMIN_ENABLED = previous;
    }
    const app = express();
    app.use(express.json(), adminRouter);
    app.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ message: error.message }));
    const server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const url = `http://127.0.0.1:${server.address().port}/users/target/role`;
    const request = () => fetch(url, {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ roleId: "inventory" })
    });

    assert.equal((await request()).status, 403);
    assert.equal(root.authUsers.target.roleId, "user");
    assert.equal(root.auditOutbox, undefined);
    root.authRoles.admin.permissions["module:inventory"] = true;
    assert.equal((await request()).status, 200);
    assert.equal(root.authUsers.target.roleId, "inventory");
    const [event] = Object.values(root.auditOutbox);
    assert.equal(event.action, "user.role.updated");
    assert.equal(event.actorId, "actor");
    assert.equal(event.roleBefore, "user");
    assert.equal(event.roleAfter, "inventory");
});
