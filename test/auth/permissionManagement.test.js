const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { loadModuleWithMocks } = require("../helpers/loadModuleWithMocks");
const { AuditOutboxWorker } = require("../../src/audit/outboxWorker");

const tokenHash = "a".repeat(64);

function harness() {
    let root = {
        authRoles: {
            admin: { permissions: { "app:access": true, "users:manage": true, "roles:manage": true, "module:storage": true } },
            user: { permissions: { "app:access": true } }
        },
        authUsers: {
            admin: { roleId: "admin", isActive: true, sessionVersion: 1 },
            user: { roleId: "user", isActive: true, email: "private@example.test", passwordHash: "private-hash" }
        },
        authSessions: { [tokenHash]: { uid: "admin", sessionVersion: 1, expiresAt: Date.now() + 60000 } }
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
    const service = loadModuleWithMocks(path.resolve(__dirname, "../../src/permissions/permissionManagement.js"), {
        "../services/authSessionService": { clearAuthenticationCache: () => { invalidations++; } },
        "../services/passwordService": { hashPassword: async () => "derived-hash" }
    });
    const update = (overrides = {}) => service.updateUserModuleExceptions({
        actorId: "admin", actorTokenHash: tokenHash, actorSessionVersion: 1, userId: "user",
        exceptions: { "module:storage": "allow", "module:inventory": "deny" }, database,
        ...overrides
    });
    const assign = (overrides = {}) => service.assignUserRole({
        actorId: "admin", actorTokenHash: tokenHash, actorSessionVersion: 1, userId: "user",
        roleId: "admin", database, ...overrides
    });
    const create = (overrides = {}) => service.createManagedUser({
        actorId: "admin", actorTokenHash: tokenHash, actorSessionVersion: 1, userId: "new",
        firstName: "Ada", lastName: "Lovelace", email: "NEW@example.test", password: "Password123",
        roleId: "user", database, ...overrides
    });
    const reset = (overrides = {}) => service.resetManagedUserPassword({
        actorId: "admin", actorTokenHash: tokenHash, actorSessionVersion: 1, userId: "user",
        password: "Password123", database, ...overrides
    });
    const edit = (overrides = {}) => service.updateManagedUser({
        actorId: "admin", actorTokenHash: tokenHash, actorSessionVersion: 1, userId: "user",
        changes: { firstName: "Ada", email: "NEW@example.test" }, database, ...overrides
    });
    const setStatus = (overrides = {}) => service.setManagedUserStatus({
        actorId: "admin", actorTokenHash: tokenHash, actorSessionVersion: 1, userId: "user",
        isActive: false, database, ...overrides
    });
    const remove = (overrides = {}) => service.deleteManagedUser({
        actorId: "admin", actorTokenHash: tokenHash, actorSessionVersion: 1, userId: "user",
        database, ...overrides
    });
    const avatar = (overrides = {}) => service.setManagedUserAvatar({
        actorId: "admin", actorTokenHash: tokenHash, actorSessionVersion: 1, userId: "user",
        profileImage: "https://example.test/new", database, ...overrides
    });
    return {
        database, update, assign, create, reset, edit, setStatus, remove, avatar,
        get root() { return root; }, invalidations: () => invalidations,
        fail() { failure = true; }, retryWith(change) { retry = change; }
    };
}

test("managed avatar changes revalidate delegation and audit the image update atomically", async () => {
    const h = harness();
    h.root.authUsers.user.profileImage = "https://example.test/old";
    h.retryWith((root) => { root.authUsers.user.profileImage = "https://example.test/concurrent"; });
    const result = await h.avatar();
    assert.equal(result.previousImage, "https://example.test/concurrent");
    assert.equal(h.root.authUsers.user.profileImage, "https://example.test/new");
    const [event] = Object.values(h.root.auditOutbox);
    assert.equal(event.action, "user.avatar.updated");
    assert.doesNotMatch(JSON.stringify(event), /example\.test/);
    assert.equal(h.invalidations(), 1);

    const revoked = harness();
    revoked.retryWith((root) => { root.authUsers.admin.isActive = false; });
    await assert.rejects(revoked.avatar(), { statusCode: 401 });
    assert.equal(revoked.root.auditOutbox, undefined);
});

test("exceptions and sanitized audit are committed atomically and can be published after retry", async () => {
    const h = harness();
    const result = await h.update();
    assert.deepEqual(result.exceptions, { "module:inventory": "deny", "module:storage": "allow" });
    assert.deepEqual(h.root.authUsers.user.permissionExceptions, result.exceptions);
    assert.equal(h.root.authUsers.user.passwordHash, "private-hash");
    const [event] = Object.values(h.root.auditOutbox);
    assert.equal(event.action, "user.permissions.updated");
    assert.deepEqual(JSON.parse(event.permissionsBefore), {});
    assert.deepEqual(JSON.parse(event.permissionsAfter), result.exceptions);
    assert.doesNotMatch(JSON.stringify(event), /private-hash|example\.test/);
    assert.equal(h.invalidations(), 1);

    const written = new Map();
    let lostResponse = true;
    const firestore = { collection: () => ({ doc: (id) => ({
        async create(value) {
            if (written.has(id)) throw Object.assign(new Error("exists"), { code: 6 });
            written.set(id, structuredClone(value));
            if (lostResponse) throw new Error("response lost");
        },
        async get() { return { exists: written.has(id), data: () => written.get(id) }; }
    }) }) };
    const worker = new AuditOutboxWorker({ getRealtimeDatabase: () => h.database, getFirestoreDatabase: () => firestore });
    await assert.rejects(worker.flush(), /response lost/);
    lostResponse = false;
    await worker.flush();
    assert.equal(written.size, 1);
    assert.equal(Object.keys(h.root.auditOutbox).length, 0);
});

test("self changes, invalid exceptions and missing or expired sessions are rejected", async () => {
    const h = harness();
    await assert.rejects(h.update({ userId: "admin" }), { statusCode: 409 });
    await assert.rejects(h.update({ exceptions: { "roles:manage": "allow" } }), { statusCode: 400 });
    await assert.rejects(h.update({ exceptions: undefined }), { statusCode: 400 });
    await assert.rejects(h.update({ actorTokenHash: "bad" }), { statusCode: 401 });
    h.root.authSessions[tokenHash].expiresAt = Date.now() - 1;
    await assert.rejects(h.update(), { statusCode: 401 });
    assert.equal(h.root.auditOutbox, undefined);
    assert.equal(h.root.authUsers.user.permissionExceptions, undefined);
});

test("transaction retries revalidate permissions and sessions without writing a false audit", async () => {
    for (const [change, statusCode] of [
        [(root) => { root.authRoles.admin.permissions["roles:manage"] = false; }, 403],
        [(root) => { delete root.authSessions[tokenHash]; }, 401],
        [(root) => { root.authUsers.admin.sessionVersion++; }, 401]
    ]) {
        const h = harness();
        h.retryWith(change);
        await assert.rejects(h.update(), { statusCode });
        assert.equal(h.root.auditOutbox, undefined);
        assert.equal(h.root.authUsers.user.permissionExceptions, undefined);
        assert.equal(h.invalidations(), 1);
    }
});

test("resetting exceptions is audited, but an unchanged update is not", async () => {
    const h = harness();
    h.root.authUsers.user.permissionExceptions = { "module:storage": "allow" };
    await h.update({ exceptions: {} });
    const [event] = Object.values(h.root.auditOutbox);
    assert.deepEqual(JSON.parse(event.permissionsBefore), { "module:storage": "allow" });
    assert.deepEqual(JSON.parse(event.permissionsAfter), {});
    await h.update({ exceptions: {} });
    assert.equal(Object.keys(h.root.auditOutbox).length, 1);
});

test("database failure is propagated and invalidates local cached authentication", async () => {
    const h = harness();
    h.fail();
    await assert.rejects(h.update(), /database offline/);
    assert.equal(h.root.auditOutbox, undefined);
    assert.equal(h.invalidations(), 1);
});

test("role assignment and its sanitized audit are committed atomically", async () => {
    const h = harness();
    assert.deepEqual(await h.assign(), { userId: "user", roleId: "admin" });
    assert.equal(h.root.authUsers.user.roleId, "admin");
    assert.equal(h.root.authUsers.user.passwordHash, "private-hash");
    const [event] = Object.values(h.root.auditOutbox);
    assert.equal(event.action, "user.role.updated");
    assert.equal(event.roleBefore, "user");
    assert.equal(event.roleAfter, "admin");
    assert.doesNotMatch(JSON.stringify(event), /private-hash|example\.test/);
    await h.assign();
    assert.equal(Object.keys(h.root.auditOutbox).length, 1);
    assert.equal(h.invalidations(), 2);
});

test("role assignment rejects self changes, invalid roles and the last default administrator", async () => {
    const h = harness();
    await assert.rejects(h.assign({ userId: "admin" }), { statusCode: 409 });
    await assert.rejects(h.assign({ roleId: "invalid.id" }), { statusCode: 400 });
    h.root.authRoles.admin.active = false;
    await assert.rejects(h.assign(), { statusCode: 403 });
    h.root.authRoles.admin.active = true;
    h.root.authRoles.disabled = { active: false, permissions: {} };
    await assert.rejects(h.assign({ roleId: "disabled" }), { statusCode: 400 });
    h.root.authRoles.super = { permissions: { ...h.root.authRoles.admin.permissions } };
    h.root.authUsers.otherManager = { roleId: "super", isActive: true, sessionVersion: 1 };
    h.root.authSessions[tokenHash].uid = "otherManager";
    await assert.rejects(h.assign({ actorId: "otherManager", userId: "admin", roleId: "user" }), { statusCode: 409 });
    assert.equal(h.root.authUsers.admin.roleId, "admin");
    assert.equal(h.root.auditOutbox, undefined);
});

test("role assignment rechecks the manager, session and destination on transaction retries", async () => {
    for (const [change, statusCode] of [
        [(root) => { root.authRoles.admin.permissions["roles:manage"] = false; }, 403],
        [(root) => { delete root.authSessions[tokenHash]; }, 401],
        [(root) => { root.authRoles.editor.active = false; }, 400],
        [(root) => { delete root.authRoles.editor; }, 400]
    ]) {
        const h = harness();
        h.root.authRoles.editor = { permissions: { "app:access": true } };
        h.retryWith(change);
        await assert.rejects(h.assign({ roleId: "editor" }), { statusCode });
        assert.equal(h.root.authUsers.user.roleId, "user");
        assert.equal(h.root.auditOutbox, undefined);
        assert.equal(h.invalidations(), 1);
    }
});

test("role assignment surfaces database errors and invalidates local authentication", async () => {
    const h = harness();
    h.fail();
    await assert.rejects(h.assign(), /database offline/);
    assert.equal(h.root.authUsers.user.roleId, "user");
    assert.equal(h.root.auditOutbox, undefined);
    assert.equal(h.invalidations(), 1);
});

test("managed account creation and password reset atomically audit without secrets", async () => {
    const h = harness();
    assert.deepEqual(await h.create(), { userId: "new" });
    assert.equal(h.root.authUsers.new.email, "new@example.test");
    assert.equal(h.root.authUsers.new.passwordHash, "derived-hash");
    assert.deepEqual(await h.reset(), { userId: "user" });
    assert.equal(h.root.authUsers.user.sessionVersion, 1);
    assert.equal(h.root.authUsers.user.passwordHash, "derived-hash");
    const events = Object.values(h.root.auditOutbox);
    assert.deepEqual(events.map((event) => event.action), ["user.created", "user.password.reset"]);
    assert.doesNotMatch(JSON.stringify(events), /Password123|derived-hash|example\.test|Lovelace/);
    assert.equal(h.invalidations(), 2);
});

test("delegation rejects permissions the manager lacks, including inactive users", async () => {
    const h = harness();
    h.root.authRoles.super = { permissions: { "app:access": true, "monitoring:app": true } };
    h.root.authUsers.privileged = { roleId: "super", isActive: false };
    await assert.rejects(h.create({ roleId: "super" }), { statusCode: 403 });
    await assert.rejects(h.reset({ userId: "privileged" }), { statusCode: 403 });
    await assert.rejects(h.assign({ roleId: "super" }), { statusCode: 403 });
    await assert.rejects(h.assign({ userId: "privileged", roleId: "user" }), { statusCode: 403 });
    await assert.rejects(h.update({ exceptions: { "monitoring:app": "allow" } }), { statusCode: 403 });
    assert.equal(h.root.authUsers.new, undefined);
    assert.equal(h.root.authUsers.user.roleId, "user");
    assert.equal(h.root.authUsers.privileged.roleId, "super");
    assert.equal(h.root.auditOutbox, undefined);
});

test("delegation uses the manager's effective permissions after individual exceptions", async () => {
    const h = harness();
    h.root.authRoles.storage = { permissions: { "app:access": true, "module:storage": true } };
    h.root.authUsers.admin.permissionExceptions = { "module:storage": "deny" };
    await assert.rejects(h.create({ roleId: "storage" }), { statusCode: 403 });
    h.root.authRoles.monitor = { permissions: { "app:access": true, "monitoring:app": true } };
    h.root.authUsers.admin.permissionExceptions = { "monitoring:app": "allow" };
    assert.deepEqual(await h.create({ roleId: "monitor" }), { userId: "new" });
});

test("account operations revalidate delegation, session and email on retry", async () => {
    for (const [action, change, statusCode] of [
        ["create", (root) => { root.authRoles.user.permissions["monitoring:app"] = true; }, 403],
        ["create", (root) => { root.authUsers.other = { email: "new@example.test" }; }, 409],
        ["reset", (root) => { root.authUsers.user.permissionExceptions = { "monitoring:app": "allow" }; }, 403],
        ["reset", (root) => { delete root.authSessions[tokenHash]; }, 401]
    ]) {
        const h = harness();
        h.retryWith(change);
        await assert.rejects(h[action](), { statusCode });
        assert.equal(h.root.authUsers.new, undefined);
        assert.equal(h.root.authUsers.user.passwordHash, "private-hash");
        assert.equal(h.root.auditOutbox, undefined);
    }
});

test("account operations reject invalid input and propagate database failures", async () => {
    const h = harness();
    await assert.rejects(h.reset({ userId: "admin" }), { statusCode: 409 });
    await assert.rejects(h.create({ password: "weak" }), { statusCode: 400 });
    await assert.rejects(h.create({ email: "invalid" }), { statusCode: 400 });
    h.fail();
    await assert.rejects(h.reset(), /database offline/);
    assert.equal(h.root.authUsers.user.passwordHash, "private-hash");
    assert.equal(h.root.auditOutbox, undefined);
    assert.equal(h.invalidations(), 1);
});

test("managed profile edits, status changes and deletion are atomically audited without personal data", async () => {
    const h = harness();
    h.root.authUsers.user.profileImage = "private-image-token";
    assert.deepEqual(await h.edit(), { userId: "user" });
    assert.equal(h.root.authUsers.user.firstName, "Ada");
    assert.equal(h.root.authUsers.user.email, "new@example.test");
    assert.equal(h.root.authUsers.user.passwordHash, "private-hash");
    await h.edit();
    assert.deepEqual(await h.setStatus(), { userId: "user" });
    assert.equal(h.root.authUsers.user.sessionVersion, 1);
    await h.setStatus();
    await h.setStatus({ isActive: true });
    assert.equal(h.root.authUsers.user.sessionVersion, 2);
    assert.deepEqual(await h.remove(), { userId: "user", profileImage: "private-image-token" });
    assert.equal(h.root.authUsers.user, undefined);
    const events = Object.values(h.root.auditOutbox);
    assert.deepEqual(events.map((event) => event.action), [
        "user.updated", "user.status.updated", "user.status.updated", "user.deleted"
    ]);
    assert.deepEqual([events[1].activeBefore, events[1].activeAfter], [true, false]);
    assert.deepEqual([events[2].activeBefore, events[2].activeAfter], [false, true]);
    assert.doesNotMatch(JSON.stringify(events), /Ada|example\.test|private-hash|private-image-token/);
});

test("profile operations reject self changes, invalid inputs and more privileged accounts", async () => {
    const h = harness();
    for (const action of ["edit", "setStatus", "remove"]) {
        await assert.rejects(h[action]({ userId: "admin" }), { statusCode: 409 });
    }
    await assert.rejects(h.edit({ changes: { roleId: "admin" } }), { statusCode: 400 });
    await assert.rejects(h.edit({ changes: {} }), { statusCode: 400 });
    await assert.rejects(h.setStatus({ isActive: "false" }), { statusCode: 400 });
    h.root.authUsers.user.permissionExceptions = { "monitoring:app": "allow" };
    h.root.authUsers.user.isActive = false;
    for (const action of ["edit", "setStatus", "remove"]) {
        await assert.rejects(h[action](), { statusCode: 403 });
    }
    assert.equal(h.root.authUsers.user.email, "private@example.test");
    assert.equal(h.root.auditOutbox, undefined);
});

test("profile operations recheck sessions, permissions, email and image on transaction retry", async () => {
    for (const [action, change, statusCode] of [
        ["edit", (root) => { root.authUsers.other = { email: "new@example.test" }; }, 409],
        ["setStatus", (root) => { root.authUsers.user.permissionExceptions = { "monitoring:app": "allow" }; }, 403],
        ["remove", (root) => { delete root.authSessions[tokenHash]; }, 401]
    ]) {
        const h = harness();
        h.retryWith(change);
        await assert.rejects(h[action](), { statusCode });
        assert.ok(h.root.authUsers.user);
        assert.equal(h.root.auditOutbox, undefined);
        assert.equal(h.invalidations(), 1);
    }
    const h = harness();
    h.root.authUsers.user.profileImage = "old-image";
    h.retryWith((root) => { root.authUsers.user.profileImage = "latest-image"; });
    assert.equal((await h.remove()).profileImage, "latest-image");
    assert.doesNotMatch(JSON.stringify(h.root.auditOutbox), /old-image|latest-image/);
});

test("status and deletion preserve the last administrator under concurrent changes", async () => {
    for (const action of ["setStatus", "remove"]) {
        const h = harness();
        h.root.authRoles.super = { permissions: { ...h.root.authRoles.admin.permissions } };
        h.root.authUsers.manager = { roleId: "super", isActive: true, sessionVersion: 1 };
        h.root.authUsers.secondAdmin = { roleId: "admin", isActive: true };
        h.root.authSessions[tokenHash].uid = "manager";
        h.retryWith((root) => { root.authUsers.secondAdmin.isActive = false; });
        await assert.rejects(h[action]({ actorId: "manager", userId: "admin" }), { statusCode: 409 });
        assert.equal(h.root.authUsers.admin.isActive, true);
        assert.equal(h.root.auditOutbox, undefined);
    }
});

test("profile operation failures invalidate local authentication without writing audit", async () => {
    const h = harness();
    h.fail();
    await assert.rejects(h.remove(), /database offline/);
    assert.ok(h.root.authUsers.user);
    assert.equal(h.root.auditOutbox, undefined);
    assert.equal(h.invalidations(), 1);
});
