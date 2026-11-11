const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { FieldValue } = require("firebase-admin/firestore");
const { activeUserWindowMinutes, recordInteraction, countActiveUsers } = require("../../src/telemetry/activeUsers");
const sessions = require("../../src/services/authSessionService");
const originalResolve = sessions.resolveSession;
sessions.resolveSession = async (token) => token === "valid"
    ? { profile: { id: "real-user", permissions: ["app:access"] } }
    : token === "denied" ? { profile: { id: "denied", permissions: [] } } : null;
const { createTelemetryRouter } = require("../../src/routes/telemetryRoutes");
test.after(() => { sessions.resolveSession = originalResolve; });

test("activity windows are configurable, bounded and reject invalid configuration", () => {
    assert.equal(activeUserWindowMinutes(""), 5);
    assert.equal(activeUserWindowMinutes("15"), 15);
    for (const value of ["0", "1441", "-1", "3.5", "abc"]) {
        assert.throws(() => activeUserWindowMinutes(value), /MONITORING_ACTIVE_USERS_WINDOW_MINUTES/);
    }
});

test("interactions use one opaque document per user and environment, without user data", async () => {
    const writes = [];
    const db = { collection: (name) => ({ doc: (id) => ({
        set: async (data) => writes.push({ name, id, data })
    }) }) };
    await recordInteraction(db, "test", "user");
    await recordInteraction(db, "test", "user");
    await recordInteraction(db, "production", "user");
    assert.equal(writes[0].id, writes[1].id);
    assert.notEqual(writes[0].id, writes[2].id);
    assert.match(writes[0].id, /^[0-9a-f]{64}$/);
    assert.deepEqual(Object.keys(writes[0].data).sort(), ["environment", "expiresAt", "lastInteractionAt"]);
    assert.ok(writes[0].data.lastInteractionAt.isEqual(FieldValue.serverTimestamp()));
    assert.ok(writes[0].data.expiresAt.toMillis() > Date.now());
});

test("count query scopes environment and exact time window and rejects invalid result", async () => {
    const calls = [];
    let result = 3;
    const query = {
        where(field, op, value) { calls.push([field, op, typeof value === "string" ? value : value.toMillis()]); return this; },
        count() { return { get: async () => ({ data: () => ({ count: result }) }) }; }
    };
    const db = { collection: () => query };
    assert.deepEqual(await countActiveUsers(db, "test", 1800000000000, 5),
        { count: 3, windowMinutes: 5, checkedAt: new Date(1800000000000).toISOString() });
    assert.deepEqual(calls, [
        ["environment", "==", "test"], ["lastInteractionAt", ">=", 1799999700000],
        ["lastInteractionAt", "<=", 1800000000000]
    ]);
    result = -1;
    await assert.rejects(countActiveUsers(db, "test", 1800000000000, 5), /no válido/);
});

test("interaction endpoint requires authenticated permission and CSRF and reports storage failure", async () => {
    let writes = 0;
    let fail = false;
    const manager = { enabled: true, environment: "test" };
    const db = { collection: () => ({ doc: () => ({ set: async () => {
        writes++;
        if (fail) throw new Error("offline");
    } }) }) };
    const app = express();
    app.use("/api/telemetry", createTelemetryRouter({ manager, getDatabase: () => db }));
    app.use((_error, _req, res, _next) => res.status(500).end());
    const server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    const url = `http://127.0.0.1:${server.address().port}/api/telemetry/interaction`;
    const request = (cookie, csrf) => fetch(url, { method: "POST", headers: { cookie, "x-csrf-token": csrf } });
    try {
        assert.equal((await request("", "")).status, 401);
        assert.equal((await request("tm_session=denied; tm_csrf=x", "x")).status, 403);
        assert.equal((await request("tm_session=valid; tm_csrf=x", "bad")).status, 403);
        assert.equal(writes, 0);
        assert.equal((await request("tm_session=valid; tm_csrf=x", "x")).status, 204);
        fail = true;
        assert.equal((await request("tm_session=valid; tm_csrf=x", "x")).status, 500);
        manager.enabled = false;
        assert.equal((await request("tm_session=valid; tm_csrf=x", "x")).status, 503);
        assert.equal(writes, 2);
    } finally { await new Promise((resolve) => server.close(resolve)); }
});
