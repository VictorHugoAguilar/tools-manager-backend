const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const sessions = require("../../src/services/authSessionService");
const original = sessions.resolveSession;
sessions.resolveSession = async (token) => token === "allowed"
    ? { profile: { id: "actor", permissions: ["monitoring:app"] } }
    : token === "denied" ? { profile: { id: "denied", permissions: [] } } : null;
const { createMonitoringRouter } = require("../../src/routes/monitoringRoutes");
test.after(() => { sessions.resolveSession = original; });

test("events endpoint authorizes and audits before querying", async () => {
    let auditFails = false;
    const calls = [];
    const db = { collection(name) {
        if (name === "auditEvents") return { doc: () => ({ create: async (data) => {
            calls.push(["audit", data]);
            if (auditFails) throw new Error("audit failure");
        } }) };
        assert.equal(name, "monitoringEvents");
        calls.push(["query"]);
        return {
            where() { return this; }, orderBy() { return this; }, limit() { return this; },
            async get() { return { docs: [] }; }
        };
    } };
    const app = express();
    app.use("/api/monitoring", createMonitoringRouter({
        manager: { enabled: true, environment: "test" }, getDatabase: () => db
    }));
    app.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({ message: err.message }));
    const server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    const end = new Date();
    const from = new Date(end.getTime() - 3600000);
    const url = `http://127.0.0.1:${server.address().port}/api/monitoring/events?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(end.toISOString())}`;
    try {
        assert.equal((await fetch(url)).status, 401);
        assert.equal((await fetch(url, { headers: { cookie: "tm_session=denied" } })).status, 403);
        assert.equal(calls.length, 0);
        const headers = { cookie: "tm_session=allowed" };
        const response = await fetch(url, { headers });
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("cache-control"), "no-store");
        assert.deepEqual(await response.json(), { events: [], nextCursor: null });
        assert.equal(calls[0][1].actorId, "actor");
        assert.deepEqual(calls.map((entry) => entry[0]), ["audit", "query"]);
        calls.length = 0;
        const trace = "4e4f00a6-139a-4db8-ae59-1b9ccdcaf120";
        const traceUrl = url.replace("/events?", `/traces/${trace}?`);
        assert.equal((await fetch(traceUrl, { headers })).status, 200);
        assert.equal(calls[0][1].action, "monitoring.trace.accessed");
        calls.length = 0;
        assert.equal((await fetch(`${traceUrl}&traceId=${trace}`, { headers })).status, 400);
        assert.equal(calls.length, 0);
        auditFails = true;
        assert.equal((await fetch(url, { headers })).status, 500);
        assert.deepEqual(calls.map((entry) => entry[0]), ["audit"]);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});
