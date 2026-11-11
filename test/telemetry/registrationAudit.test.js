const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { loadModuleWithMocks } = require("../helpers/loadModuleWithMocks");
const { transactAdminUser } = require("../../src/audit/businessOutbox");

function harness() {
    let root = {
        authRoles: { user: { name: "User" } },
        authUsers: { other: { email: "other@example.com", roleId: "user" } }
    };
    let retry;
    let fail = false;
    const database = { ref() { return { transaction: async (change) => {
        if (fail) throw new Error("offline");
        let next = change(structuredClone(root));
        if (retry) {
            retry(root);
            retry = null;
            next = change(structuredClone(root));
        }
        if (next === undefined) return { committed: false };
        root = next;
        return { committed: true };
    } }; } };
    const service = loadModuleWithMocks(path.resolve(__dirname, "../../src/services/userService.js"), {
        "../config/firebaseAdmin": { getAdminDatabase: () => database },
        "../audit/businessOutbox": {
            isRegistrationAuditEnabled: () => true,
            transactAdminUser: (args) => transactAdminUser({ ...args, database })
        }
    });
    return {
        service, get root() { return root; },
        retryWith(fn) { retry = fn; }, fail(value) { fail = value; }
    };
}

const registration = { registration: true, actorId: "new", sessionVersion: 0 };
const input = { firstName: "Private", lastName: "Name", email: "new@example.com" };

test("registration, avatar and rollback are recorded atomically without personal data", async () => {
    const h = harness();
    await h.service.createProfile("new", input, "user", "private-hash", registration);
    await h.service.updateProfile("new", { profileImage: "private-url" }, registration);
    assert.equal(await h.service.deleteProfileForRollback("new", registration), true);
    assert.equal(h.root.authUsers.new, undefined);
    const events = Object.values(h.root.auditOutbox);
    assert.deepEqual(events.map((event) => event.action), [
        "user.registered", "user.avatar.updated", "user.registration.rolled_back"
    ]);
    assert.ok(events.every((event) => event.actorId === "new" && event.targetId === "new"));
    assert.doesNotMatch(JSON.stringify(events), /private-hash|private-url|example\.com|Private/);
});

test("concurrent duplicate emails abort the registration and leave no audit", async () => {
    const h = harness();
    h.retryWith((root) => { root.authUsers.other.email = "new@example.com"; });
    await assert.rejects(h.service.createProfile("new", input, "user", "hash", registration), { statusCode: 409 });
    assert.equal(h.root.authUsers.new, undefined);
    assert.equal(h.root.auditOutbox, undefined);
});

test("failed rollback retains the user and registration audit", async () => {
    const h = harness();
    await h.service.createProfile("new", input, "user", "hash", registration);
    h.fail(true);
    await assert.rejects(h.service.deleteProfileForRollback("new", registration), /offline/);
    assert.ok(h.root.authUsers.new);
    assert.deepEqual(Object.values(h.root.auditOutbox).map((event) => event.action), ["user.registered"]);
});

test("public registration controller supplies identity to creation, avatar and rollback", async () => {
    const calls = [];
    const { controller } = loadModuleWithMocks(path.resolve(__dirname, "../../src/controllers/authController.js"), {
        "../services/userService": {
            createProfile: async (...args) => { calls.push(["create", args]); },
            deleteProfileForRollback: async (...args) => { calls.push(["rollback", args]); },
            getProfileWithPermissions: async () => { throw new Error("unavailable"); }
        },
        "../services/passwordService": { hashPassword: async () => "hash" },
        "../services/userAvatarService": { updateUserAvatar: async (...args) => { calls.push(["avatar", args]); } }
    });
    const previous = process.env.PUBLIC_REGISTRATION_ENABLED;
    process.env.PUBLIC_REGISTRATION_ENABLED = "true";
    let error;
    try {
        await controller.register({ body: { ...input, password: "Workshop1234" }, file: {} }, {}, (err) => { error = err; });
        assert.match(error.message, /unavailable/);
        assert.deepEqual(calls.map(([name]) => name), ["create", "avatar", "rollback"]);
        const id = calls[0][1][0];
        assert.deepEqual(calls[0][1][4], { registration: true, actorId: id });
        assert.deepEqual(calls[1][1][2], { registration: true, actorId: id, sessionVersion: 0 });
        assert.deepEqual(calls[2][1][1], { registration: true, actorId: id });
    } finally {
        if (previous === undefined) delete process.env.PUBLIC_REGISTRATION_ENABLED;
        else process.env.PUBLIC_REGISTRATION_ENABLED = previous;
    }
});
