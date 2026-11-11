const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { loadModuleWithMocks } = require("../helpers/loadModuleWithMocks");
const { transactRolePermissions } = require("../../src/audit/businessOutbox");
const { AuditOutboxWorker } = require("../../src/audit/outboxWorker");

function harness(initialRoles) {
    let root = { authRoles: structuredClone(initialRoles), unrelated: { keep: true } };
    let fail = false;
    let concurrentRole = null;
    const database = {
        ref(pathname) {
            if (!pathname) return { transaction: async (change) => {
                if (fail) throw new Error("RTDB unavailable");
                let updated = change(structuredClone(root));
                if (concurrentRole) {
                    root.authRoles.editor = concurrentRole;
                    concurrentRole = null;
                    updated = change(structuredClone(root));
                }
                if (updated === undefined) return { committed: false };
                root = updated;
                return { committed: true };
            } };
            assert.equal(pathname, "auditOutbox");
            return {
                orderByKey() { return this; },
                limitToFirst() { return this; },
                async get() { return { val: () => structuredClone(root.auditOutbox || {}) }; },
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
            isRoleAuditEnabled: () => true,
            transactRolePermissions: (input) => transactRolePermissions({ ...input, database })
        }
    });
    return {
        service, database,
        get root() { return root; },
        fail(value) { fail = value; },
        retryWith(role) { concurrentRole = role; }
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
