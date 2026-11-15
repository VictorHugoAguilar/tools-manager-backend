const test = require("node:test");
const assert = require("node:assert/strict");
const { applyRolePermissionMigration } = require("../../src/permissions/applyMigration");
const { MAX_ROOT_BYTES } = require("../../src/audit/businessOutbox");

function harness(initial) {
    let root = structuredClone(initial);
    let retry;
    const database = {
        ref() {
            return {
                async get() { return { val: () => structuredClone(root) }; },
                async transaction(change) {
                    let result = change(structuredClone(root));
                    if (retry) {
                        retry(root);
                        retry = null;
                        result = change(structuredClone(root));
                    }
                    if (result === undefined) return { committed: false };
                    root = result;
                    return { committed: true };
                }
            };
        }
    };
    return { database, get root() { return root; }, retryWith(callback) { retry = callback; } };
}

function initialRoot() {
    return {
        authRoles: {
            admin: { name: "Admin", permissions: { "app:access": true, "users:manage": true, "roles:manage": true } },
            user: { permissions: { "app:access": true, "module:inventory": false } }
        },
        authUsers: { one: { roleId: "admin", email: "private@example.test" }, two: { roleId: "user" } }
    };
}

test("migration preserves explicit decisions, audits each changed role and is idempotent", async () => {
    const h = harness(initialRoot());
    assert.deepEqual((await applyRolePermissionMigration(h.database)).updatedRoles, ["admin", "user"]);
    assert.equal(h.root.authRoles.user.permissions["module:inventory"], false);
    assert.equal(h.root.authRoles.user.permissions["module:storage"], true);
    assert.equal(h.root.authRoles.user.permissions["monitoring:app"], undefined);
    const events = Object.values(h.root.auditOutbox);
    assert.equal(events.length, 2);
    assert.ok(events.every((event) => event.action === "role.profile.updated"));
    assert.doesNotMatch(JSON.stringify(events), /private@example/);
    assert.deepEqual((await applyRolePermissionMigration(h.database)).updatedRoles, []);
    assert.equal(Object.keys(h.root.auditOutbox).length, 2);
});

test("migration rejects missing roles and missing effective managers before writing", async () => {
    const missingRole = initialRoot();
    missingRole.authUsers.two.roleId = "missing";
    const deniedManager = initialRoot();
    deniedManager.authUsers.one.permissionExceptions = { "users:manage": "deny" };
    for (const root of [missingRole, deniedManager]) {
        const h = harness(root);
        await assert.rejects(applyRolePermissionMigration(h.database), /roles inexistentes|administrador/);
        assert.equal(h.root.auditOutbox, undefined);
    }
});

test("transaction retries revalidate permissions and preserve concurrent role edits", async () => {
    const h = harness(initialRoot());
    h.retryWith((root) => {
        root.authRoles.admin.permissions["module:storage"] = false;
        root.authRoles.admin.modulePermissionsConfigured = true;
    });
    const result = await applyRolePermissionMigration(h.database);
    assert.deepEqual(result.updatedRoles, ["user"]);
    assert.equal(h.root.authRoles.admin.permissions["module:storage"], false);
    assert.equal(Object.keys(h.root.auditOutbox).length, 1);

    const revoked = harness(initialRoot());
    revoked.retryWith((root) => { root.authUsers.one.isActive = false; });
    await assert.rejects(applyRolePermissionMigration(revoked.database), /administrador/);
    assert.equal(revoked.root.auditOutbox, undefined);
});

test("migration checks the exact root size limit before any write", async () => {
    const root = initialRoot();
    for (const role of Object.values(root.authRoles)) role.modulePermissionsConfigured = true;
    root.padding = "";
    root.padding = "x".repeat(MAX_ROOT_BYTES - Buffer.byteLength(JSON.stringify(root), "utf8"));
    const boundary = harness(root);
    assert.deepEqual((await applyRolePermissionMigration(boundary.database)).updatedRoles, []);
    root.padding += "x";
    const oversized = harness(root);
    await assert.rejects(applyRolePermissionMigration(oversized.database), /límite seguro/);
    assert.equal(oversized.root.auditOutbox, undefined);
});
