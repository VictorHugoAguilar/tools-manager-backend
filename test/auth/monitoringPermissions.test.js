const test = require("node:test");
const assert = require("node:assert/strict");
const firebaseAdmin = require("../../src/config/firebaseAdmin");
const originalGetAdminDatabase = firebaseAdmin.getAdminDatabase;
const stored = {
    authRoles: { admin: { name: "Administrador", permissions: { "app:access": true } } },
    authPermissions: { "app:access": { description: "Existente" }, "monitoring:app": { description: "Personalizado" } }
};
firebaseAdmin.getAdminDatabase = () => ({
    ref(path = "") {
        return {
            child: (child) => this.ref(`${path}/${child}`),
            get: async () => ({ exists: () => Boolean(stored[path]) }),
            update: async (updates) => Object.assign(stored, updates),
            transaction: async (update) => {
                const [parent, key] = path.split("/");
                const next = update(stored[parent][key] ?? null);
                if (next !== undefined) stored[parent][key] = next;
                return { committed: next !== undefined };
            },
            ref(childPath) {
                return firebaseAdmin.getAdminDatabase().ref(childPath);
            }
        };
    }
});
const { initializeAuthData } = require("../../src/services/userService");
test.after(() => { firebaseAdmin.getAdminDatabase = originalGetAdminDatabase; });

test("existing permission catalogs gain missing monitoring permissions without changing roles or entries", async () => {
    await initializeAuthData();
    assert.equal(stored.authPermissions["monitoring:app"].description, "Personalizado");
    assert.equal(stored.authPermissions["tracing:app"].description, "Acceder a las funciones de trazabilidad");
    assert.deepEqual(stored.authRoles.admin.permissions, { "app:access": true });
    await initializeAuthData();
    assert.equal(stored.authPermissions["monitoring:app"].description, "Personalizado");
});
