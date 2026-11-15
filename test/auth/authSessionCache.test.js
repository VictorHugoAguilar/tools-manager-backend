const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { loadModuleWithMocks } = require("../helpers/loadModuleWithMocks");

function harness(t, { enabled = true } = {}) {
    let now = 1000000;
    let profile = { id: "user", isActive: true, sessionVersion: 1, permissions: ["app:access"] };
    let fail = false;
    let readProfile = null;
    const sessions = new Map();
    const reads = { sessions: 0, profiles: 0 };
    t.mock.method(Date, "now", () => now);
    const hash = (token) => createHash("sha256").update(token).digest("hex");
    const database = {
        ref(name) {
            assert.equal(name, "authSessions");
            return { child: (key) => ({
                async get() {
                    reads.sessions++;
                    if (fail) throw new Error("database offline");
                    return { val: () => structuredClone(sessions.get(key) ?? null) };
                },
                async remove() { sessions.delete(key); }
            }) };
        }
    };
    const service = loadModuleWithMocks(path.resolve(__dirname, "../../src/services/authSessionService.js"), {
        "../config/firebaseAdmin": { getAdminDatabase: () => database },
        "../cache/sharedCache": { cacheConfig: { enabled } },
        "./userService": { getProfileWithPermissions: async () => {
            reads.profiles++;
            if (readProfile) return readProfile();
            return structuredClone(profile);
        } }
    });
    return {
        service, reads, hash,
        add(token, expiresAt = now + 120000) {
            sessions.set(hash(token), { uid: "user", sessionVersion: 1, expiresAt });
        },
        advance(ms) { now += ms; },
        setProfile(value) { profile = value; },
        setFailure(value) { fail = value; },
        setProfileReader(value) { readProfile = value; }
    };
}

test("valid sessions share concurrent reads and expire after 30 seconds without extending TTL", async (t) => {
    const h = harness(t);
    h.add("token");
    const [first, second] = await Promise.all([
        h.service.resolveSession("token"), h.service.resolveSession("token")
    ]);
    assert.deepEqual(h.reads, { sessions: 1, profiles: 1 });
    first.profile.permissions.length = 0;
    assert.deepEqual(second.profile.permissions, ["app:access"]);
    h.advance(29999);
    assert.deepEqual((await h.service.resolveSession("token")).profile.permissions, ["app:access"]);
    assert.deepEqual(h.reads, { sessions: 1, profiles: 1 });
    h.setProfile({ id: "user", isActive: true, sessionVersion: 1, permissions: [] });
    h.advance(1);
    assert.deepEqual((await h.service.resolveSession("token")).profile.permissions, []);
    assert.deepEqual(h.reads, { sessions: 2, profiles: 2 });
});

test("cached sessions never outlive their expiration", async (t) => {
    const h = harness(t);
    h.add("short", Date.now() + 1000);
    assert.ok(await h.service.resolveSession("short"));
    h.advance(999);
    assert.ok(await h.service.resolveSession("short"));
    h.advance(1);
    assert.equal(await h.service.resolveSession("short"), null);
    assert.deepEqual(h.reads, { sessions: 2, profiles: 1 });
});

test("invalid sessions and database failures are never cached", async (t) => {
    const h = harness(t);
    assert.equal(await h.service.resolveSession("missing"), null);
    assert.equal(await h.service.resolveSession("missing"), null);
    h.add("token");
    h.setFailure(true);
    await assert.rejects(h.service.resolveSession("token"), /database offline/);
    h.setFailure(false);
    assert.ok(await h.service.resolveSession("token"));
    h.advance(30000);
    h.setFailure(true);
    await assert.rejects(h.service.resolveSession("token"), /database offline/);
    assert.deepEqual(h.reads, { sessions: 5, profiles: 1 });
});

test("disabled or revoked profiles are not cached", async (t) => {
    const h = harness(t);
    for (const profile of [
        { id: "user", isActive: false, sessionVersion: 1, permissions: [] },
        { id: "user", isActive: true, sessionVersion: 2, permissions: [] }
    ]) {
        h.add("token");
        h.setProfile(profile);
        assert.equal(await h.service.resolveSession("token"), null);
    }
    h.add("token");
    h.setProfile({ id: "user", isActive: true, sessionVersion: 1, permissions: ["app:access"] });
    assert.ok(await h.service.resolveSession("token"));
    assert.deepEqual(h.reads, { sessions: 3, profiles: 3 });
});

test("logout invalidates cached sessions and prevents an in-flight load from restoring them", async (t) => {
    const h = harness(t);
    h.add("cached");
    assert.ok(await h.service.resolveSession("cached"));
    await h.service.deleteSession(h.hash("cached"));
    assert.equal(await h.service.resolveSession("cached"), null);

    h.add("pending");
    let release;
    h.setProfileReader(() => new Promise((resolve) => { release = resolve; }));
    const pending = h.service.resolveSession("pending");
    await new Promise((resolve) => setImmediate(resolve));
    await h.service.deleteSession(h.hash("pending"));
    release({ id: "user", isActive: true, sessionVersion: 1, permissions: ["app:access"] });
    assert.ok(await pending);
    assert.equal(await h.service.resolveSession("pending"), null);
});

test("a slow validation does not extend the 30-second cache window", async (t) => {
    const h = harness(t);
    h.add("token");
    let release;
    h.setProfileReader(() => new Promise((resolve) => { release = resolve; }));
    const pending = h.service.resolveSession("token");
    await new Promise((resolve) => setImmediate(resolve));
    h.advance(30000);
    h.setProfileReader(null);
    release({ id: "user", isActive: true, sessionVersion: 1, permissions: ["app:access"] });
    assert.ok(await pending);
    assert.ok(await h.service.resolveSession("token"));
    assert.deepEqual(h.reads, { sessions: 2, profiles: 2 });
});

test("a session that expires during validation is rejected", async (t) => {
    const h = harness(t);
    h.add("token", Date.now() + 1000);
    let release;
    h.setProfileReader(() => new Promise((resolve) => { release = resolve; }));
    const pending = h.service.resolveSession("token");
    await new Promise((resolve) => setImmediate(resolve));
    h.advance(1000);
    release({ id: "user", isActive: true, sessionVersion: 1, permissions: ["app:access"] });
    assert.equal(await pending, null);
});

test("the global cache switch disables storage and concurrent sharing", async (t) => {
    const h = harness(t, { enabled: false });
    h.add("token");
    await Promise.all([h.service.resolveSession("token"), h.service.resolveSession("token")]);
    await h.service.resolveSession("token");
    assert.deepEqual(h.reads, { sessions: 3, profiles: 3 });
});

test("authentication cache evicts least-recently-used sessions at its limit", async (t) => {
    const h = harness(t);
    for (let i = 0; i <= 500; i++) {
        const token = `token-${i}`;
        h.add(token);
        assert.ok(await h.service.resolveSession(token));
    }
    await h.service.resolveSession("token-0");
    assert.deepEqual(h.reads, { sessions: 502, profiles: 502 });
});
