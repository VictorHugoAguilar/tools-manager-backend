const test = require("node:test");
const assert = require("node:assert/strict");
const { planRolePermissionMigration, inspectRolePermissionMigration } = require("../../src/permissions/migration");

test("migration preserves existing access without granting administrative or monitoring permissions", () => {
    const roles = {
        user: { name: "Usuario", permissions: { "app:access": true, "module:inventory": false } },
        disabled: { name: "Sin acceso", permissions: { "app:access": false } },
        configured: { modulePermissionsConfigured: true, permissions: { "app:access": true } },
        super: { name: "Super", permissions: { "app:access": true, "monitoring:app": true } }
    };
    const original = structuredClone(roles);
    const plan = planRolePermissionMigration(roles);
    assert.equal(plan.user["module:dashboard"], true);
    assert.equal(plan.user["module:inventory"], undefined);
    assert.equal(plan.user["monitoring:app"], undefined);
    assert.equal(plan.user["users:manage"], undefined);
    assert.equal(plan.disabled, undefined);
    assert.equal(plan.configured, undefined);
    assert.equal(plan.super["monitoring:app"], undefined);
    assert.deepEqual(roles, original);

    for (const [id, additions] of Object.entries(plan)) Object.assign(roles[id].permissions, additions);
    assert.deepEqual(planRolePermissionMigration(roles), {});
});

test("migration rejects malformed roles instead of creating a partial plan", () => {
    assert.throws(() => planRolePermissionMigration({ user: { permissions: [] } }), /rol user/);
    assert.throws(() => planRolePermissionMigration(null), /roles/);
    const unusual = JSON.parse('{"__proto__":{"permissions":{"app:access":true}}}');
    const plan = planRolePermissionMigration(unusual);
    assert.equal(Object.hasOwn(plan, "__proto__"), true);
    assert.equal(plan.__proto__["module:dashboard"], true);
});

test("read-only inspection reports affected users and managers without personal data", () => {
    const roles = {
        admin: { permissions: { "app:access": true, "users:manage": true, "roles:manage": true } },
        user: { permissions: { "app:access": true } }
    };
    const profiles = {
        one: { roleId: "admin", email: "private@example.test" },
        two: { roleId: "user", isActive: false },
        three: { roleId: "deleted" },
        four: {}
    };
    const result = inspectRolePermissionMigration(roles, profiles);
    assert.equal(result.users, 4);
    assert.equal(result.activeUsers, 3);
    assert.equal(result.missingRoles, 1);
    assert.equal(result.activeManagers, 1);
    assert.equal(result.roles.find((role) => role.id === "user").assignedUsers, 2);
    assert.doesNotMatch(JSON.stringify(result), /private@example|one|two|three|four/);
    assert.throws(() => inspectRolePermissionMigration(roles, { invalid: null }), /usuario/);
});
