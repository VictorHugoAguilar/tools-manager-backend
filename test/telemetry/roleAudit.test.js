const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { loadModuleWithMocks } = require("../helpers/loadModuleWithMocks");
const { transactRolePermissions } = require("../../src/audit/businessOutbox");
const { AuditOutboxWorker } = require("../../src/audit/outboxWorker");

function harness(initialRoles, { auditEnabled = true } = {}) {
    let root = { authRoles: structuredClone(initialRoles), unrelated: { keep: true } };
    let fail = false;
    let concurrentRole = null;
    const database = {
        ref(pathname) {
            if (!pathname) return { transaction: async (change) => {
                if (fail) throw new Error("RTDB unavailable");
                let updated = change(structuredClone(root));
                if (concurrentRole) {
                    root.authRoles.editor = concurrentRole.value;
                    concurrentRole = null;
                    updated = change(structuredClone(root));
                }
                if (updated === undefined) return { committed: false };
                root = updated;
                return { committed: true };
            } };
            if (pathname === "authRoles") return { child: (id) => ({
                async get() {
                    if (fail) throw new Error("RTDB unavailable");
                    return { exists: () => Boolean(root.authRoles[id]), val: () => root.authRoles[id] || null };
                },
                async transaction(change) {
                    if (fail) throw new Error("RTDB unavailable");
                    let updated = change(structuredClone(root.authRoles[id] || null));
                    if (concurrentRole) {
                        root.authRoles[id] = concurrentRole.value;
                        concurrentRole = null;
                        updated = change(structuredClone(root.authRoles[id] || null));
                    }
                    root.authRoles[id] = updated;
                    return { committed: true, snapshot: { val: () => updated } };
                }
            }) };
            assert.equal(pathname, "auditOutbox");
            return {
                orderByKey() { return this; },
                limitToFirst() { return this; },
                async get() { return { forEach: (callback) => {
                    for (const [key, value] of Object.entries(structuredClone(root.auditOutbox || {}))) {
                        callback({ key, val: () => value });
                    }
                } }; },
                child(id) { return { transaction: async (change) => {
                    const updated = change(structuredClone(root.auditOutbox[id] || null));
                    if (updated === undefined) return { committed: false };
                    if (updated === null) delete root.auditOutbox[id];
                    return { committed: true };
                } }; }
            };
        }
    };
    const service = loadModuleWithMocks(path.resolve(__dirname, "../../src/services/userService.js"), {
        "../config/firebaseAdmin": { getAdminDatabase: () => database },
        "../audit/businessOutbox": {
            isRoleAuditEnabled: () => auditEnabled,
            transactRolePermissions: (input) => transactRolePermissions({ ...input, database })
        }
    });
    return {
        service, database,
        get root() { return root; },
        fail(value) { fail = value; },
        retryWith(role) { concurrentRole = { value: role }; }
    };
}

test("role changes atomically record actor and previous and new permissions", async () => {
    const h = harness({
        editor: { name: "Editor", permissions: { "app:access": true, "users:manage": true } }
    });
    const result = await h.service.updateRolePermissions("editor", ["monitoring:app"], "actor");
    assert.deepEqual(result, { id: "editor", name: "Editor", permissions: ["monitoring:app"] });
    assert.deepEqual(h.root.authRoles.editor.permissions, { "monitoring:app": true });
    assert.deepEqual(h.root.unrelated, { keep: true });
    const [event] = Object.values(h.root.auditOutbox);
    assert.equal(event.action, "role.permissions.updated");
    assert.equal(event.actorId, "actor");
    assert.equal(event.targetId, "editor");
    assert.deepEqual(JSON.parse(event.permissionsBefore), ["app:access", "users:manage"]);
    assert.deepEqual(JSON.parse(event.permissionsAfter), ["monitoring:app"]);
});

test("transaction retries audit the latest permissions and preserve concurrent fields", async () => {
    const h = harness({ editor: { name: "Editor", permissions: { "app:access": true } } });
    h.retryWith({ name: "Changed", permissions: { "roles:manage": true }, extra: "kept" });
    await h.service.updateRolePermissions("editor", [], "actor");
    const [event] = Object.values(h.root.auditOutbox);
    assert.deepEqual(JSON.parse(event.permissionsBefore), ["roles:manage"]);
    assert.deepEqual(JSON.parse(event.permissionsAfter), []);
    assert.equal(h.root.authRoles.editor.extra, "kept");
    assert.equal(Object.keys(h.root.auditOutbox).length, 1);
});

test("audited updates preserve non-legacy permissions and include them in the response and audit", async () => {
    const h = harness({ editor: { name: "Editor", permissions: {
        "app:access": true, "module:inventory": true, "module:storage": false
    } } });
    h.retryWith({ name: "Editor", permissions: {
        "app:access": true, "module:inventory": true, "module:storage": false, "module:reports": true
    } });
    const result = await h.service.updateRolePermissions("editor", ["monitoring:app"], "actor");
    assert.deepEqual(h.root.authRoles.editor.permissions, {
        "module:inventory": true, "module:storage": false, "module:reports": true, "monitoring:app": true
    });
    assert.deepEqual(result.permissions, ["module:inventory", "module:reports", "monitoring:app"]);
    const [event] = Object.values(h.root.auditOutbox);
    assert.deepEqual(JSON.parse(event.permissionsBefore), ["app:access", "module:inventory", "module:reports"]);
    assert.deepEqual(JSON.parse(event.permissionsAfter), ["module:inventory", "module:reports", "monitoring:app"]);
});

test("non-audited updates preserve concurrent module permissions and do not recreate deleted roles", async () => {
    const h = harness({ editor: { name: "Editor", permissions: { "app:access": true } } }, { auditEnabled: false });
    h.retryWith({ name: "Changed", permissions: { "app:access": true, "module:storage": true }, extra: "kept" });
    const result = await h.service.updateRolePermissions("editor", ["tracing:app"], "actor");
    assert.deepEqual(result, { id: "editor", name: "Changed", permissions: ["module:storage", "tracing:app"] });
    assert.equal(h.root.authRoles.editor.extra, "kept");
    assert.equal(h.root.auditOutbox, undefined);
    h.retryWith(null);
    assert.equal(await h.service.updateRolePermissions("editor", [], "actor"), null);
});

test("invalid roles, admin guard and database failures cannot create audit records", async () => {
    const h = harness({
        admin: { name: "Administrador", permissions: {
            "app:access": true, "users:manage": true, "roles:manage": true
        } }
    });
    assert.equal(await h.service.updateRolePermissions("missing", [], "actor"), null);
    await assert.rejects(h.service.updateRolePermissions("admin", [], "actor"), { statusCode: 409 });
    await assert.rejects(h.service.updateRolePermissions("admin", ["toString"], "actor"), { statusCode: 400 });
    await assert.rejects(h.service.updateRolePermissions("admin", ["app:access", "users:manage", "roles:manage"]),
        /auditoría no válidos/);
    h.fail(true);
    await assert.rejects(h.service.updateRolePermissions("admin", [
        "app:access", "users:manage", "roles:manage"
    ], "actor"), /RTDB unavailable/);
    assert.equal(h.root.auditOutbox, undefined);
    assert.equal(h.root.authRoles.admin.permissions["roles:manage"], true);
});

test("role audit publication retries an existing event without losing details", async () => {
    const h = harness({ editor: { name: "Editor", permissions: { "app:access": true } } });
    await h.service.updateRolePermissions("editor", [], "actor");
    const events = new Map();
    let failDelete = true;
    const firestore = { collection: () => ({ doc: (id) => ({
        async create(event) {
            if (events.has(id)) throw Object.assign(new Error("exists"), { code: 6 });
            events.set(id, structuredClone(event));
            if (failDelete) throw new Error("acknowledgement lost");
        },
        async get() { return { exists: events.has(id), data: () => events.get(id) }; }
    }) }) };
    const worker = new AuditOutboxWorker({
        getRealtimeDatabase: () => h.database, getFirestoreDatabase: () => firestore
    });
    await assert.rejects(worker.flush(), /acknowledgement lost/);
    assert.equal(Object.keys(h.root.auditOutbox).length, 1);
    failDelete = false;
    await worker.flush();
    assert.equal(Object.keys(h.root.auditOutbox).length, 0);
    assert.equal(events.size, 1);
    assert.equal([...events.values()][0].permissionsAfter, "[]");
});

test("role audit rejects conflicting permission details without acknowledging the outbox", async () => {
    const h = harness({ editor: { name: "Editor", permissions: { "app:access": true } } });
    await h.service.updateRolePermissions("editor", [], "actor");
    const [id, event] = Object.entries(h.root.auditOutbox)[0];
    const firestore = { collection: () => ({ doc: () => ({
        async create() { throw Object.assign(new Error("exists"), { code: 6 }); },
        async get() { return { exists: true, data: () => ({ ...event, permissionsAfter: "[\"users:manage\"]" }) }; }
    }) }) };
    const worker = new AuditOutboxWorker({
        getRealtimeDatabase: () => h.database, getFirestoreDatabase: () => firestore
    });
    await assert.rejects(worker.flush(), /Conflicto/);
    assert.ok(h.root.auditOutbox[id]);
});

test("role permissions controller passes the authenticated actor to the service", async () => {
    let argumentsReceived;
    const { userController } = loadModuleWithMocks(path.resolve(__dirname, "../../src/controllers/userController.js"), {
        "../services/userService": { updateRolePermissions: async (...args) => {
            argumentsReceived = args;
            return { id: args[0], name: "Editor", permissions: args[1] };
        } }
    });

    let payload;
    const req = { authUser: { id: "actor" }, params: { roleId: "editor" }, body: { permissions: ["app:access"] } };
    await userController.updatePermissions(req, { json(value) { payload = value; } }, assert.fail);
    assert.deepEqual(argumentsReceived, ["editor", ["app:access"], "actor"]);
    assert.equal(payload.role.id, "editor");
});

test("role permissions controller rejects modification of the caller's role", async () => {
    let called = false;
    const { userController } = loadModuleWithMocks(path.resolve(__dirname, "../../src/controllers/userController.js"), {
        "../services/userService": { updateRolePermissions: async () => { called = true; } }
    });
    let received;
    await userController.updatePermissions(
        { authUser: { id: "actor", roleId: "editor" }, params: { roleId: "editor" }, body: { permissions: [] } },
        {}, (error) => { received = error; }
    );
    assert.equal(received?.statusCode, 409);
    assert.equal(called, false);
});

test("role permission changes invalidate authentication even on ambiguous failures", async () => {
    let invalidations = 0;
    let fail = false;
    const { userController } = loadModuleWithMocks(path.resolve(__dirname, "../../src/controllers/userController.js"), {
        "../services/userService": { updateRolePermissions: async () => {
            if (fail) throw new Error("response lost");
            return { id: "editor", permissions: [] };
        } },
        "../services/authSessionService": { clearAuthenticationCache: () => { invalidations++; } }
    });
    const req = { authUser: { id: "actor", roleId: "admin" }, params: { roleId: "editor" }, body: { permissions: [] } };
    await userController.updatePermissions(req, { json() {} }, assert.fail);
    fail = true;
    let received;
    await userController.updatePermissions(req, {}, (error) => { received = error; });
    assert.match(received.message, /response lost/);
    assert.equal(invalidations, 2);
});
