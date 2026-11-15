const test = require("node:test");
const assert = require("node:assert/strict");
const { calculateEffectivePermissions } = require("../../src/permissions/effectivePermissions");

test("individual exceptions override inherited module permissions without changing the role", () => {
    const role = { "app:access": true, "module:inventory": true, "module:storage": false };
    const exceptions = { "module:inventory": "deny", "module:storage": "allow" };
    assert.deepEqual(calculateEffectivePermissions(role, exceptions), ["app:access", "module:storage"]);
    assert.deepEqual(role, { "app:access": true, "module:inventory": true, "module:storage": false });
    assert.deepEqual(exceptions, { "module:inventory": "deny", "module:storage": "allow" });
});

test("absence of an exception preserves inherited permissions, including existing non-module permissions", () => {
    assert.deepEqual(calculateEffectivePermissions({
        "app:access": true, "tracing:app": true, "module:inventory": true, "module:storage": false
    }), ["app:access", "module:inventory", "tracing:app"]);
});

test("unknown permissions and invalid exception decisions fail closed", () => {
    for (const exceptions of [
        { "module:unknown": "allow" },
        { "roles:manage": "allow" },
        { "module:inventory": "inherit" },
        { "module:inventory": true }
    ]) {
        assert.throws(() => calculateEffectivePermissions({}, exceptions), /Excepción/);
    }
    assert.throws(() => calculateEffectivePermissions(null), /no válidos/);
});
