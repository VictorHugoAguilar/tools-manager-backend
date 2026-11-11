const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const sessions = require("../../src/services/authSessionService");
const original = sessions.resolveSession;
sessions.resolveSession = async (token) => token === "allowed"
    ? { profile: { id: "actor", permissions: ["monitoring:app"] } }
    : token === "denied" ? { profile: { id: "actor", permissions: [] } } : null;
const { createMonitoringRouter } = require("../../src/routes/monitoringRoutes");
test.after(() => { sessions.resolveSession = original; });

test("storage history is protected, bounded and audited before reading", async () => {
    const calls = [];
    let auditFails = false;
    const query = {
        doc: () => ({ async create(value) {
            calls.push(["audit", value]);
            if (auditFails) throw new Error("audit unavailable");
        } }),
        where(...args) { calls.push(["where", ...args]); return this; },
        orderBy(...args) { calls.push(["orderBy", ...args]); return this; },
        limit(count) { calls.push(["limit", count]); return this; },
        async get() {
            calls.push(["read"]);
            return { docs: [{ id: "event", data: () => ({
                action: "box.product.updated", actorId: "user", targetId: "product",
                boxId: "box", occurredAt: "2026-01-01T00:00:00.000Z", privateField: "hidden"
            }) }] };
        }
    };
    const app = express();
    app.use("/api/monitoring", createMonitoringRouter({
        manager: { enabled: false }, getDatabase: () => ({ collection: () => query })
    }));
    app.use((_error, _req, res, _next) => res.status(500).end());
    const server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    const url = `http://127.0.0.1:${server.address().port}/api/monitoring/storage-history`;
    const headers = { cookie: "tm_session=allowed" };
    try {
        assert.equal((await fetch(`${url}/boxes`)).status, 401);
        assert.equal((await fetch(`${url}/boxes`, { headers: { cookie: "tm_session=denied" } })).status, 403);
        assert.equal((await fetch(`${url}/other`, { headers })).status, 400);
        assert.equal((await fetch(`${url}/boxes?q=private`, { headers })).status, 400);
        assert.equal(calls.length, 0);
        const response = await fetch(`${url}/boxes`, { headers });
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("cache-control"), "no-store");
        const body = await response.json();
        assert.equal(body.events[0].boxId, "box");
        assert.equal(body.events[0].privateField, undefined);
        assert.equal(calls[0][1].action, "monitoring.storage-history.accessed");
        assert.deepEqual(calls[1], ["where", "auditScope", "==", "boxes"]);
        assert.deepEqual(calls[2], ["orderBy", "occurredAt", "desc"]);
        assert.deepEqual(calls[3], ["limit", 25]);
        calls.length = 0;
        const workshop = await fetch(`${url}/workshop`, { headers });
        assert.equal(workshop.status, 200);
        assert.deepEqual(calls[1], ["where", "auditScope", "==", "workshop"]);
        assert.equal(calls[0][1].action, "monitoring.storage-history.accessed");
        calls.length = 0;
        auditFails = true;
        assert.equal((await fetch(`${url}/workshop`, { headers })).status, 500);
        assert.equal(calls.length, 1);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});

test("storage history reports index failures safely and does not disguise permission failures", async () => {
    const calls = [];
    let failure = Object.assign(new Error("The query requires an index: https://private.example"), {
        code: 9, details: "The query requires an index: https://private.example"
    });
    const query = {
        doc: () => ({ async create() { calls.push("audit"); } }),
        where() { return this; },
        orderBy() { return this; },
        limit() { return this; },
        async get() { calls.push("read"); throw failure; }
    };
    const app = express();
    app.use("/api/monitoring", createMonitoringRouter({
        manager: { enabled: false }, getDatabase: () => ({ collection: () => query })
    }));
    app.use((_error, _req, res, _next) => res.status(500).json({ message: "Internal server error" }));
    const server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    const url = `http://127.0.0.1:${server.address().port}/api/monitoring/storage-history`;
    const headers = { cookie: "tm_session=allowed" };
    const originalError = console.error;
    const logged = [];
    console.error = (...args) => logged.push(args);
    try {
        for (const scope of ["boxes", "workshop"]) {
            calls.length = 0;
            const response = await fetch(`${url}/${scope}`, { headers });
            assert.equal(response.status, 503);
            assert.equal(response.headers.get("cache-control"), "no-store");
            const body = await response.json();
            assert.equal(body.code, "MONITORING_INDEX_UNAVAILABLE");
            assert.doesNotMatch(JSON.stringify(body), /private\.example/);
            assert.deepEqual(calls, ["audit", "read"]);
        }
        assert.equal(logged.length, 2);
        assert.equal(logged[0][1], failure);
        failure = Object.assign(new Error("Firestore permission denied"), { code: 7 });
        calls.length = 0;
        const denied = await fetch(`${url}/boxes`, { headers });
        assert.equal(denied.status, 500);
        assert.deepEqual(await denied.json(), { message: "Internal server error" });
        assert.deepEqual(calls, ["audit", "read"]);
    } finally {
        console.error = originalError;
        await new Promise((resolve) => server.close(resolve));
    }
});
