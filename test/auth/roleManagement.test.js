const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { loadModuleWithMocks } = require("../helpers/loadModuleWithMocks");
const { AuditOutboxWorker } = require("../../src/audit/outboxWorker");
const { planRolePermissionMigration } = require("../../src/permissions/migration");

const tokenHash = "b".repeat(64);

function harness() {
    let root = {
        authRoles: {
            admin: { name: "Administrador", permissions: {
                "app:access": true, "users:manage": true, "roles:manage": true,
                "module:inventory": true, "module:storage": true
            } },
            user: { name: "Usuario", permissions: { "app:access": true } },
            editor: { name: "Editor", permissions: { "app:access": true, "module:inventory": true }, extra: "kept" }
        },
        authUsers: { actor: { roleId: "admin", isActive: true, sessionVersion: 1 } },
        authSessions: { [tokenHash]: { uid: "actor", sessionVersion: 1, expiresAt: Date.now() + 60000 } }
    };
    let retry;
    let failure = false;
    let invalidations = 0;
    const database = {
        ref(name) {
            if (!name) return { transaction: async (change) => {
                if (failure) throw new Error("database offline");
                let result = change(structuredClone(root));
                if (retry) {
                    retry(root);
                    retry = null;
                    result = change(structuredClone(root));
                }
                if (result === undefined) return { committed: false };
                root = result;
                return { committed: true };
            } };
            assert.equal(name, "auditOutbox");
            return {
                orderByKey() { return this; },
                limitToFirst() { return this; },
                async get() { return { forEach: (callback) => {
                    for (const [key, value] of Object.entries(structuredClone(root.auditOutbox || {}))) {
                        callback({ key, val: () => value });
                    }
                } }; },
                child: (id) => ({ transaction: async (change) => {
                    const result = change(structuredClone(root.auditOutbox[id] || null));
                    if (result === undefined) return { committed: false };
                    if (result === null) delete root.auditOutbox[id];
                    return { committed: true };
                } })
            };
        }
    };
    const service = loadModuleWithMocks(path.resolve(__dirname, "../../src/permissions/roleManagement.js"), {
        "../services/authSessionService": { clearAuthenticationCache: () => { invalidations++; } }
    });
    const context = { actorId: "actor", actorTokenHash: tokenHash, actorSessionVersion: 1, database };
    return {
        service, database, context, get root() { return root; },
        invalidations: () => invalidations, fail() { failure = true; }, retryWith(change) { retry = change; }
    };
}

test("creating and duplicating profiles commits sanitized audit and preserves the source", async () => {
    const h = harness();
    const created = await h.service.createPermissionRole({
        ...h.context, roleId: "store", name: "Almacén", description: "Inventario",
        permissions: ["module:storage", "app:access"]
    });
    assert.deepEqual(created.permissions, { "app:access": true, "module:storage": true });
    assert.equal(created.createdBy, "actor");
    assert.equal(created.modulePermissionsConfigured, true);
    assert.equal(planRolePermissionMigration({ store: created }).store, undefined);
    const duplicate = await h.service.createPermissionRole({
        ...h.context, roleId: "copy", name: "Copia", sourceRoleId: "editor"
    });
    assert.deepEqual(duplicate.permissions, h.root.authRoles.editor.permissions);
    assert.equal(h.root.authRoles.editor.extra, "kept");
    const events = Object.values(h.root.auditOutbox);
    assert.deepEqual(events.map((event) => event.action), ["role.profile.created", "role.profile.created"]);
    assert.deepEqual(JSON.parse(events[0].permissionsAfter), ["app:access", "module:storage"]);
    assert.equal(events[0].activeBefore, false);
    assert.equal(events[0].activeAfter, true);
    assert.doesNotMatch(JSON.stringify(events), /Almacén|Inventario/);
    assert.equal(h.invalidations(), 2);
});

test("editing preserves unrelated fields and refuses self-privilege or protected-admin changes", async () => {
    const h = harness();
    h.root.authRoles.editor.permissions["module:reports"] = false;
    const updated = await h.service.updatePermissionRole({
        ...h.context, roleId: "editor", name: "Editado", description: "Nuevo",
        permissions: ["app:access", "module:storage"]
    });
    assert.equal(updated.extra, "kept");
    assert.equal(updated.permissions["module:reports"], false);
    assert.equal(updated.modulePermissionsConfigured, true);
    assert.equal(updated.updatedBy, "actor");
    const [event] = Object.values(h.root.auditOutbox);
    assert.deepEqual(JSON.parse(event.permissionsBefore), ["app:access", "module:inventory"]);
    assert.deepEqual(JSON.parse(event.permissionsAfter), ["app:access", "module:storage"]);
    assert.equal(planRolePermissionMigration({ editor: h.root.authRoles.editor }).editor, undefined);
    await assert.rejects(h.service.updatePermissionRole({
        ...h.context, roleId: "admin", name: "Admin", description: "", permissions: ["app:access"]
    }), { statusCode: 409 });
    h.root.authRoles.super = { permissions: { ...h.root.authRoles.admin.permissions } };
    h.root.authUsers.actor.roleId = "super";
    await assert.rejects(h.service.updatePermissionRole({
        ...h.context, roleId: "admin", name: "Admin", description: "", permissions: ["app:access"]
    }), { statusCode: 409 });
    assert.equal(Object.keys(h.root.auditOutbox).length, 1);
});

test("deactivation requires no assigned users and preserves built-in profiles", async () => {
    const h = harness();
    h.root.authUsers.assigned = { roleId: "editor", isActive: false };
    await assert.rejects(h.service.deactivatePermissionRole({ ...h.context, roleId: "editor" }), { statusCode: 409 });
    await assert.rejects(h.service.deactivatePermissionRole({ ...h.context, roleId: "user" }), { statusCode: 409 });
    delete h.root.authUsers.assigned;
    const result = await h.service.deactivatePermissionRole({ ...h.context, roleId: "editor" });
    assert.equal(result.active, false);
    const [event] = Object.values(h.root.auditOutbox);
    assert.equal(event.action, "role.profile.deactivated");
    assert.equal(event.activeBefore, true);
    assert.equal(event.activeAfter, false);
    await h.service.deactivatePermissionRole({ ...h.context, roleId: "editor" });
    assert.equal(Object.keys(h.root.auditOutbox).length, 1);
});

test("retries recheck the actor and duplicate the latest source without false audits", async () => {
    const h = harness();
    h.retryWith((root) => { root.authRoles.editor.permissions = { "module:storage": true }; });
    const result = await h.service.createPermissionRole({
        ...h.context, roleId: "copy", name: "Copia", sourceRoleId: "editor"
    });
    assert.deepEqual(result.permissions, { "module:storage": true });
    h.retryWith((root) => { delete root.authSessions[tokenHash]; });
    await assert.rejects(h.service.deactivatePermissionRole({ ...h.context, roleId: "editor" }), { statusCode: 401 });
    assert.notEqual(h.root.authRoles.editor.active, false);
    assert.equal(Object.keys(h.root.auditOutbox).length, 1);
});

test("a concurrent assignment prevents deactivation on retry", async () => {
    const h = harness();
    h.retryWith((root) => { root.authUsers.assigned = { roleId: "editor" }; });
    await assert.rejects(h.service.deactivatePermissionRole({ ...h.context, roleId: "editor" }), { statusCode: 409 });
    assert.notEqual(h.root.authRoles.editor.active, false);
    assert.equal(h.root.auditOutbox, undefined);
});

test("a concurrent permission revocation rejects the transaction and invalidates the cache", async () => {
    const h = harness();
    h.retryWith((root) => { root.authRoles.admin.permissions["roles:manage"] = false; });
    await assert.rejects(h.service.createPermissionRole({
        ...h.context, roleId: "new", name: "Nuevo", permissions: []
    }), { statusCode: 403 });
    assert.equal(h.root.authRoles.new, undefined);
    assert.equal(h.root.auditOutbox, undefined);
    assert.equal(h.invalidations(), 1);
});

test("profile management refuses roles and assigned users with higher permissions", async () => {
    const h = harness();
    h.root.authRoles.privileged = { name: "Privilegiado", permissions: { "monitoring:app": true } };
    await assert.rejects(h.service.createPermissionRole({
        ...h.context, roleId: "new", name: "Nuevo", permissions: ["monitoring:app"]
    }), { statusCode: 403 });
    await assert.rejects(h.service.createPermissionRole({
        ...h.context, roleId: "new", name: "Nuevo", sourceRoleId: "privileged"
    }), { statusCode: 403 });
    await assert.rejects(h.service.deactivatePermissionRole({ ...h.context, roleId: "privileged" }), { statusCode: 403 });
    h.root.authUsers.assigned = { roleId: "editor", permissionExceptions: { "monitoring:app": "allow" } };
    await assert.rejects(h.service.updatePermissionRole({
        ...h.context, roleId: "editor", name: "Nuevo", description: "", permissions: ["app:access"]
    }), { statusCode: 403 });
    assert.equal(h.root.auditOutbox, undefined);
});

test("legacy permission changes preserve module permissions and audit the latest concurrent state", async () => {
    const h = harness();
    h.root.authRoles.admin.permissions["monitoring:app"] = true;
    h.retryWith((root) => {
        root.authRoles.editor.permissions["module:storage"] = true;
        root.authRoles.editor.permissions["module:reports"] = false;
        root.authRoles.editor.extra = "concurrent";
    });
    const result = await h.service.updateLegacyRolePermissions({
        ...h.context, roleId: "editor", permissions: ["app:access", "monitoring:app"]
    });
    assert.deepEqual(result.permissions, ["app:access", "module:inventory", "module:storage", "monitoring:app"]);
    assert.equal(h.root.authRoles.editor.permissions["module:reports"], false);
    assert.equal(h.root.authRoles.editor.extra, "concurrent");
    const [event] = Object.values(h.root.auditOutbox);
    assert.equal(event.action, "role.permissions.updated");
    assert.deepEqual(JSON.parse(event.permissionsBefore), ["app:access", "module:inventory", "module:storage"]);
    assert.deepEqual(JSON.parse(event.permissionsAfter), result.permissions);
});

test("legacy permission changes reject self-escalation and users with higher effective permissions", async () => {
    const h = harness();
    await assert.rejects(h.service.updateLegacyRolePermissions({
        ...h.context, roleId: "admin", permissions: ["app:access", "users:manage", "roles:manage"]
    }), { statusCode: 409 });
    await assert.rejects(h.service.updateLegacyRolePermissions({
        ...h.context, roleId: "editor", permissions: ["monitoring:app"]
    }), { statusCode: 403 });
    await assert.rejects(h.service.updateLegacyRolePermissions({
        ...h.context, roleId: "editor", permissions: ["module:inventory"]
    }), { statusCode: 400 });
    h.root.authUsers.assigned = { roleId: "editor", isActive: false, permissionExceptions: { "monitoring:app": "allow" } };
    await assert.rejects(h.service.updateLegacyRolePermissions({
        ...h.context, roleId: "editor", permissions: ["app:access"]
    }), { statusCode: 403 });
    assert.equal(h.root.auditOutbox, undefined);
});

test("legacy permission changes revalidate the session and delegation on retry", async () => {
    for (const [change, statusCode] of [
        [(root) => { delete root.authSessions[tokenHash]; }, 401],
        [(root) => { root.authRoles.admin.permissions["module:inventory"] = false; }, 403]
    ]) {
        const h = harness();
        h.retryWith(change);
        await assert.rejects(h.service.updateLegacyRolePermissions({
            ...h.context, roleId: "editor", permissions: ["app:access"]
        }), { statusCode });
        assert.equal(h.root.authRoles.editor.permissions["module:inventory"], true);
        assert.equal(h.root.auditOutbox, undefined);
        assert.equal(h.invalidations(), 1);
    }
});

test("invalid inputs and database failures cannot create a profile", async () => {
    const h = harness();
    await assert.rejects(h.service.createPermissionRole({
        ...h.context, roleId: "new", name: "Nuevo", permissions: ["unknown"]
    }), { statusCode: 400 });
    await assert.rejects(h.service.createPermissionRole({
        ...h.context, roleId: "editor", name: "Nuevo", permissions: []
    }), { statusCode: 409 });
    h.fail();
    await assert.rejects(h.service.createPermissionRole({
        ...h.context, roleId: "new", name: "Nuevo", permissions: []
    }), /database offline/);
    assert.equal(h.root.authRoles.new, undefined);
    assert.equal(h.root.auditOutbox, undefined);
    assert.equal(h.invalidations(), 2);
});

test("profile audit publication retries idempotently after an ambiguous failure", async () => {
    const h = harness();
    await h.service.createPermissionRole({
        ...h.context, roleId: "new", name: "Nuevo", permissions: ["app:access"]
    });
    const events = new Map();
    let fail = true;
    const firestore = { collection: () => ({ doc: (id) => ({
        async create(event) {
            if (events.has(id)) throw Object.assign(new Error("exists"), { code: 6 });
            events.set(id, structuredClone(event));
            if (fail) throw new Error("acknowledgement lost");
        },
        async get() { return { exists: events.has(id), data: () => events.get(id) }; }
    }) }) };
    const worker = new AuditOutboxWorker({ getRealtimeDatabase: () => h.database, getFirestoreDatabase: () => firestore });
    await assert.rejects(worker.flush(), /acknowledgement lost/);
    assert.equal(Object.keys(h.root.auditOutbox).length, 1);
    fail = false;
    await worker.flush();
    assert.equal([...events.values()][0].action, "role.profile.created");
    assert.equal(events.size, 1);
    assert.equal(Object.keys(h.root.auditOutbox).length, 0);
});
