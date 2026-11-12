const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const sessions = require("../../src/services/authSessionService");
const original = sessions.resolveSession;
sessions.resolveSession = async (token) => token === "monitoring"
    ? { profile: { id: "reader", permissions: ["monitoring:app"] } }
    : token === "tracing" ? { profile: { id: "reader", permissions: ["tracing:app"] } } : null;
const { createMonitoringRouter } = require("../../src/routes/monitoringRoutes");
test.after(() => { sessions.resolveSession = original; });

test("area histories authorize monitoring, audit before reading and merge bounded action batches", async () => {
    const calls = [];
    let fail = false;
    const db = { collection: () => ({
        doc: () => ({ create: async (record) => {
            calls.push(["audit", record]);
            if (fail) throw new Error("audit unavailable");
        } }),
        where(field, op, actions) {
            calls.push(["query", field, op, actions]);
            return {
                orderBy(field, dir) { assert.deepEqual([field, dir], ["occurredAt", "desc"]); return this; },
                limit(n) { assert.equal(n, 25); return this; },
                async get() {
                    return { docs: [{ id: actions[0], data: () => ({
                        action: actions[0], actorId: "actor", targetId: "private",
                        occurredAt: actions.length === 30 ? "2026-01-01T00:00:00.000Z" : "2026-02-01T00:00:00.000Z",
                        secret: "not returned"
                    }) }] };
                }
            };
        }
    }) };
    const app = express();
    app.use(createMonitoringRouter({ getDatabase: () => db }));
    app.use((_error, _req, res, _next) => res.status(500).end());
    const server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    const base = `http://127.0.0.1:${server.address().port}/audit-history`;
    const options = (token) => ({ headers: { cookie: `tm_session=${token}` } });
    try {
        assert.equal((await fetch(`${base}/todo`)).status, 401);
        assert.equal((await fetch(`${base}/todo`, options("tracing"))).status, 403);
        assert.equal((await fetch(`${base}/invalid`, options("monitoring"))).status, 400);
        assert.equal((await fetch(`${base}/todo?extra=1`, options("monitoring"))).status, 400);
        assert.equal(calls.length, 0);
        const response = await fetch(`${base}/todo`, options("monitoring"));
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("cache-control"), "no-store");
        const body = await response.json();
        assert.equal(body.events.length, 2);
        assert.ok(body.events[0].occurredAt > body.events[1].occurredAt);
        assert.equal(body.events[0].secret, undefined);
        assert.equal(calls[0][0], "audit");
        assert.equal(calls[0][1].scope, "todo");
        assert.ok(calls.slice(1).every((call) => call[1] === "action" && call[2] === "in" && call[3].length <= 30));
        calls.length = 0;
        fail = true;
        assert.equal((await fetch(`${base}/drawing`, options("monitoring"))).status, 500);
        assert.deepEqual(calls.map((call) => call[0]), ["audit"]);
    } finally { await new Promise((resolve) => server.close(resolve)); }
});
