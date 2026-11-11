const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { loadModuleWithMocks } = require("../helpers/loadModuleWithMocks");
const { transactAdminUser } = require("../../src/audit/businessOutbox");
const { AuditOutboxWorker } = require("../../src/audit/outboxWorker");

function harness() {
    let root = {
        authRoles: { admin: { name: "Admin" }, user: { name: "User" } },
        authUsers: {
            admin: { email: "admin@example.com", roleId: "admin", isActive: true, sessionVersion: 0 },
            other: { email: "other@example.com", roleId: "user", isActive: true, sessionVersion: 1 }
        },
        unrelated: { preserved: true }
    };
    let retry;
    let fail = false;
    const database = { ref(pathname) {
        if (!pathname) return { transaction: async (change) => {
            if (fail) throw new Error("offline");
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
        assert.equal(pathname, "auditOutbox");
        return {
            orderByKey() { return this; },
            limitToFirst() { return this; },
            async get() { return { val: () => structuredClone(root.auditOutbox || {}) }; },
            child: (id) => ({ transaction: async (change) => {
                const result = change(structuredClone(root.auditOutbox[id] || null));
                if (result === undefined) return { committed: false };
                if (result === null) delete root.auditOutbox[id];
                return { committed: true };
            } })
        };
    } };
    const service = loadModuleWithMocks(path.resolve(__dirname, "../../src/services/userService.js"), {
        "../config/firebaseAdmin": { getAdminDatabase: () => database },
        "../audit/businessOutbox": {
            isUserAuditEnabled: () => true,
            transactAdminUser: (args) => transactAdminUser({ ...args, database })
        }
    });
    return {
        service, database, get root() { return root; },
        retryWith(fn) { retry = fn; }, fail(value) { fail = value; }
    };
}

const admin = { admin: true, actorId: "actor" };
const input = { firstName: "Private", lastName: "Name", email: "new@example.com" };

test("admin create, edit, role, status, password, avatar and delete are atomically audited", async () => {
    const h = harness();
    const created = await h.service.createProfile("new", input, "user", "private-hash", admin);
    assert.equal(created.id, "new");
    await h.service.updateProfileGuarded("new", { firstName: "Other", email: "changed@example.com" }, admin);
    await h.service.updateProfileGuarded("new", { roleId: "admin" }, admin);
    await h.service.updateProfileGuarded("new", { isActive: false }, admin);
    await h.service.updatePasswordHash("new", "replacement-hash", undefined, admin);
    assert.equal(h.root.authUsers.new.sessionVersion, 2);
    await h.service.updateProfile("new", { profileImage: "private-avatar-token" }, admin);
    assert.equal(await h.service.updateProfileGuarded("new", {}, { ...admin, delete: true }), true);
    assert.equal(h.root.authUsers.new, undefined);
    assert.equal(h.root.unrelated.preserved, true);
    const events = Object.values(h.root.auditOutbox);
    assert.deepEqual(events.map((event) => event.action), [
        "user.created", "user.updated", "user.role.updated", "user.status.updated",
        "user.password.reset", "user.avatar.updated", "user.deleted"
    ]);
    assert.ok(events.every((event) => event.actorId === "actor" && event.targetId === "new"));
    assert.deepEqual([events[2].roleBefore, events[2].roleAfter], ["user", "admin"]);
    assert.deepEqual([events[3].activeBefore, events[3].activeAfter], [true, false]);
    assert.doesNotMatch(JSON.stringify(events), /private-hash|replacement-hash|private-avatar-token|example\.com|Private/);
});

test("concurrent email or last-admin changes abort without a false success or audit", async () => {
    const h = harness();
    h.retryWith((root) => { root.authUsers.other.email = "new@example.com"; });
    await assert.rejects(h.service.createProfile("new", input, "user", "hash", admin), { statusCode: 409 });
    assert.equal(h.root.authUsers.new, undefined);
    assert.equal(h.root.auditOutbox, undefined);
    h.retryWith((root) => { root.authUsers.other.roleId = "user"; });
    h.root.authUsers.other.roleId = "admin";
    await assert.rejects(h.service.updateProfileGuarded("admin", { roleId: "user" }, admin), { statusCode: 409 });
    assert.equal(h.root.authUsers.admin.roleId, "admin");
    assert.equal(h.root.auditOutbox, undefined);
});

test("role deletion, duplicate email, missing actor and failed database leave no audit", async () => {
    const h = harness();
    h.retryWith((root) => { delete root.authRoles.user; });
    await assert.rejects(h.service.updateProfileGuarded("other", { roleId: "user" }, admin), { statusCode: 400 });
    await assert.rejects(h.service.updateProfileGuarded("other", { email: "admin@example.com" }, admin), { statusCode: 409 });
    await assert.rejects(h.service.updateProfileGuarded("other", { firstName: "test" }, { admin: true }), /auditoría no válidos/);
    h.fail(true);
    await assert.rejects(h.service.updatePasswordHash("other", "hash", undefined, admin), /offline/);
    assert.equal(h.root.auditOutbox, undefined);
    assert.equal(h.root.authUsers.other.sessionVersion, 1);
});

test("missing and stale users do not produce an audit; unchanged status does not revoke sessions", async () => {
    const h = harness();
    assert.equal(await h.service.updateProfileGuarded("missing", {}, admin), null);
    assert.equal(await h.service.updatePasswordHash("other", "hash", 0, admin), null);
    assert.equal(h.root.auditOutbox, undefined);
    await h.service.updateProfileGuarded("other", { isActive: true }, admin);
    assert.equal(h.root.authUsers.other.sessionVersion, 1);
});

test("user audit details survive an idempotent retry to Firestore", async () => {
    const h = harness();
    await h.service.updateProfileGuarded("other", { isActive: false }, admin);
    const records = new Map();
    let fail = true;
    const cloud = { collection: () => ({ doc: (id) => ({
        async create(event) {
            if (records.has(id)) throw Object.assign(new Error("exists"), { code: 6 });
            records.set(id, structuredClone(event));
            if (fail) throw new Error("response lost");
        },
        async get() { return { exists: records.has(id), data: () => records.get(id) }; }
    }) }) };
    const worker = new AuditOutboxWorker({ getRealtimeDatabase: () => h.database, getFirestoreDatabase: () => cloud });
    await assert.rejects(worker.flush(), /response lost/);
    assert.equal(Object.keys(h.root.auditOutbox).length, 1);
    fail = false;
    await worker.flush();
    assert.equal(Object.keys(h.root.auditOutbox).length, 0);
    assert.equal([...records.values()][0].activeAfter, false);
});

test("administrative controllers pass the authenticated actor through each user change", async () => {
    const calls = [];
    const profile = { id: "target", roleId: "user", profileImage: "" };
    const service = {
        getRole: async () => ({ name: "User" }),
        getProfile: async () => profile,
        getProfileWithPermissions: async () => profile,
        createProfile: async (...args) => { calls.push(["create", args]); return profile; },
        updateProfileGuarded: async (...args) => { calls.push(["update", args]); return profile; },
        updatePasswordHash: async (...args) => { calls.push(["password", args]); return profile; }
    };
    const { userController } = loadModuleWithMocks(path.resolve(__dirname, "../../src/controllers/userController.js"), {
        "../services/userService": service,
        "./authController": { getPublicUser: (user) => user, validateNewPassword: (password) => password },
        "../services/passwordService": { hashPassword: async () => "hash" },
        "../services/userAvatarService": { updateUserAvatar: async (...args) => {
            calls.push(["avatar", args]); return profile;
        } }
    });
    const res = {
        status() { return this; },
        json() { return this; },
        send() { return this; }
    };
    const req = { authUser: { id: "actor" }, params: { id: "target" }, body: {} };
    await userController.create({ ...req, body: { ...input, password: "pass", roleId: "user" } }, res, assert.fail);
    await userController.update({ ...req, body: { firstName: "Valid" } }, res, assert.fail);
    await userController.updateRole({ ...req, body: { roleId: "user" } }, res, assert.fail);
    await userController.updateStatus({ ...req, body: { isActive: false } }, res, assert.fail);
    await userController.resetPassword({ ...req, body: { newPassword: "pass" } }, res, assert.fail);
    await userController.uploadAvatar({ ...req, file: { test: true } }, res, assert.fail);
    await userController.delete(req, res, assert.fail);
    assert.deepEqual(calls.map(([name]) => name), ["create", "update", "update", "update", "password", "avatar", "update"]);
    for (const [, args] of calls) {
        assert.deepEqual(args.at(-1), args.at(-1).delete ? { ...admin, delete: true } : admin);
    }
});
