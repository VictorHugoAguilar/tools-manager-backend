const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { loadModuleWithMocks } = require("../helpers/loadModuleWithMocks");

function harness(user, role) {
    const values = { authUsers: { one: user }, authRoles: { user: role } };
    const reads = [];
    const database = {
        ref(collection) {
            return { child(id) {
                return { async get() {
                    reads.push(`${collection}/${id}`);
                    return { val: () => structuredClone(values[collection][id] || null) };
                } };
            } };
        }
    };
    const service = loadModuleWithMocks(path.resolve(__dirname, "../../src/services/userService.js"), {
        "../config/firebaseAdmin": { getAdminDatabase: () => database }
    });
    return { service, reads };
}

test("session profiles apply individual module exceptions without extra database reads", async () => {
    const h = harness({
        firstName: "Ada", roleId: "user", passwordHash: "secret",
        permissionExceptions: { "module:inventory": "deny", "module:storage": "allow" }
    }, { name: "Usuario", permissions: { "app:access": true, "module:inventory": true } });
    const profile = await h.service.getProfileWithPermissions("one");
    assert.deepEqual(profile.permissions, ["app:access", "module:storage"]);
    assert.equal(profile.passwordHash, undefined);
    assert.equal(profile.permissionExceptions, undefined);
    assert.deepEqual(h.reads, ["authUsers/one", "authRoles/user"]);
});

test("profiles with missing or inactive roles cannot authenticate", async () => {
    for (const role of [null, { active: false, permissions: { "app:access": true } }]) {
        const h = harness({ roleId: "user" }, role);
        assert.equal(await h.service.getProfileWithPermissions("one"), null);
    }
});

test("invalid individual exceptions fail closed instead of being ignored", async () => {
    for (const exceptions of [{ "roles:manage": "allow" }, false]) {
        const h = harness({ roleId: "user", permissionExceptions: exceptions },
            { permissions: { "app:access": true } });
        await assert.rejects(h.service.getProfileWithPermissions("one"), /Excepción|no válidos/);
    }
});
