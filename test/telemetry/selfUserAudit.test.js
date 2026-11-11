const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { loadModuleWithMocks } = require("../helpers/loadModuleWithMocks");
const { transactAdminUser } = require("../../src/audit/businessOutbox");
const { AuditOutboxWorker } = require("../../src/audit/outboxWorker");

function harness() {
    let root = {
        authUsers: { user: { firstName: "Private", email: "private@example.com", roleId: "user",
            passwordHash: "old-hash", isActive: true, sessionVersion: 4 } },
        unrelated: { keep: true }
    };
    let retry;
    let offline = false;
    const database = { ref(pathname) {
        if (!pathname) return { transaction: async (change) => {
            if (offline) throw new Error("offline");
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
            isSelfUserAuditEnabled: () => true,
            transactAdminUser: (args) => transactAdminUser({ ...args, database })
        }
    });
    return {
        service, database, get root() { return root; },
        retryWith(fn) { retry = fn; }, fail(value) { offline = value; }
    };
}

const self = { self: true, actorId: "user", sessionVersion: 4 };

test("own profile, avatar and password changes commit sanitized audit events", async () => {
    const h = harness();
    await h.service.updateProfile("user", { firstName: "Changed" }, self);
    await h.service.updateProfile("user", { profileImage: "private-url" }, self);
    await h.service.updatePasswordHash("user", "new-secret-hash", undefined, self);
    assert.equal(h.root.authUsers.user.sessionVersion, 5);
    assert.equal(h.root.authUsers.user.passwordHash, "new-secret-hash");
    assert.deepEqual(h.root.unrelated, { keep: true });
    const events = Object.values(h.root.auditOutbox);
    assert.deepEqual(events.map((event) => event.action), [
        "user.profile.updated", "user.avatar.updated", "user.password.changed"
    ]);
    assert.ok(events.every((event) => event.actorId === "user" && event.targetId === "user"));
    assert.doesNotMatch(JSON.stringify(events), /Private|Changed|example\.com|private-url|secret|hash/);
});

test("concurrent password reset or deactivation rejects the stale self-service transaction", async () => {
    for (const change of [
        (root) => { root.authUsers.user.sessionVersion++; root.authUsers.user.passwordHash = "concurrent"; },
        (root) => { root.authUsers.user.isActive = false; }
    ]) {
        const h = harness();
        h.retryWith(change);
        await assert.rejects(h.service.updatePasswordHash("user", "new-secret-hash", undefined, self),
            { statusCode: 401 });
        assert.equal(h.root.auditOutbox, undefined);
        assert.notEqual(h.root.authUsers.user.passwordHash, "new-secret-hash");
    }
});

test("self audit refuses wrong actor, session, forbidden fields and database failures", async () => {
    const h = harness();
    await assert.rejects(h.service.updateProfile("user", { firstName: "Changed" },
        { ...self, actorId: "other" }), /Contexto de auditoría/);
    await assert.rejects(h.service.updateProfile("user", { roleId: "admin" }, self), /no válidos/);
    await assert.rejects(h.service.updateProfile("user", { firstName: "Changed" },
        { ...self, sessionVersion: 3 }), { statusCode: 401 });
    h.fail(true);
    await assert.rejects(h.service.updateProfile("user", { firstName: "Changed" }, self), /offline/);
    assert.equal(h.root.authUsers.user.firstName, "Private");
    assert.equal(h.root.auditOutbox, undefined);
});

test("disabled self audit preserves existing profile and password update paths", async () => {
    let profile = { firstName: "Original", roleId: "user", passwordHash: "old", sessionVersion: 4 };
    const ref = {
        child: () => ref,
        async get() { return { exists: () => true, val: () => profile }; },
        async update(changes) { profile = { ...profile, ...changes }; },
        async transaction(change) {
            const result = change({ user: profile });
            profile = result.user;
            return { committed: true, snapshot: { child: () => ({ val: () => profile }) } };
        }
    };
    const service = loadModuleWithMocks(path.resolve(__dirname, "../../src/services/userService.js"), {
        "../config/firebaseAdmin": { getAdminDatabase: () => ({ ref: () => ref }) },
        "../audit/businessOutbox": {
            isSelfUserAuditEnabled: () => false,
            transactAdminUser: () => assert.fail("disabled audit must not transact at the root")
        }
    });
    const updated = await service.updateProfile("user", { firstName: "Changed" }, self);
    assert.equal(updated.firstName, "Changed");
    const password = await service.updatePasswordHash("user", "new", undefined, self);
    assert.equal(password.sessionVersion, 5);
    assert.equal(profile.passwordHash, "new");
});

test("own profile event survives an ambiguous Firestore response and retries idempotently", async () => {
    const h = harness();
    await h.service.updateProfile("user", { firstName: "Changed" }, self);
    const records = new Map();
    const cloud = { collection: () => ({ doc: (id) => ({
        async create(event) {
            if (records.has(id)) throw Object.assign(new Error("exists"), { code: 6 });
            records.set(id, structuredClone(event));
            throw new Error("response lost");
        },
        async get() { return { exists: records.has(id), data: () => records.get(id) }; }
    }) }) };
    const worker = new AuditOutboxWorker({ getRealtimeDatabase: () => h.database, getFirestoreDatabase: () => cloud });
    await assert.rejects(worker.flush(), /response lost/);
    assert.equal(Object.keys(h.root.auditOutbox).length, 1);
    await worker.flush();
    assert.equal(records.size, 1);
    assert.equal(Object.keys(h.root.auditOutbox).length, 0);
});

test("own profile controllers forward authenticated identity and session version", async () => {
    const calls = [];
    const profile = { id: "user", sessionVersion: 4 };
    const { userController } = loadModuleWithMocks(path.resolve(__dirname, "../../src/controllers/userController.js"), {
        "../services/userService": {
            updateProfile: async (...args) => { calls.push(["profile", args]); return profile; },
            getProfileWithPermissions: async () => profile,
            getPasswordHash: async () => "old-hash",
            updatePasswordHash: async (...args) => { calls.push(["password", args]); return profile; }
        },
        "./authController": { getPublicUser: (user) => user, validateNewPassword: (value) => value, issueSession: async () => {} },
        "../services/passwordService": { hashPassword: async () => "new-hash", verifyPassword: async () => true },
        "../services/userAvatarService": { updateUserAvatar: async (...args) => {
            calls.push(["avatar", args]); return profile;
        } }
    });
    const req = { authUser: profile, body: {}, file: { test: true } };
    const res = { json() { return this; } };
    await userController.updateMe({ ...req, body: { firstName: "Test" } }, res, assert.fail);
    await userController.changeMyPassword({ ...req, body: { currentPassword: "old", newPassword: "new" } }, res, assert.fail);
    await userController.uploadMyAvatar(req, res, assert.fail);
    assert.deepEqual(calls.map(([name]) => name), ["profile", "password", "avatar"]);
    for (const [, args] of calls) assert.deepEqual(args.at(-1), self);
});
