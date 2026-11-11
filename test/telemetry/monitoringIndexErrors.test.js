const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const sessions = require("../../src/services/authSessionService");
const originalResolveSession = sessions.resolveSession;
sessions.resolveSession = async (token) => token === "allowed"
    ? { profile: { id: "actor", permissions: ["monitoring:app"] } } : null;
const { createMonitoringRouter } = require("../../src/routes/monitoringRoutes");

test.after(() => { sessions.resolveSession = originalResolveSession; });

test("monitoring reports missing indexes safely after the audit, without masking other failures", async () => {
    let failure = Object.assign(new Error("9 FAILED_PRECONDITION: The query requires an index. https://private.example/index"), {
        code: 9, details: "The query requires an index. https://private.example/index"
    });
    const calls = [];
    const db = { collection(name) {
        if (name === "auditEvents") return { doc: () => ({ create: async () => { calls.push("audit"); } }) };
        return {
            where() { return this; }, orderBy() { return this; }, limit() { return this; },
            async get() { calls.push(name); throw failure; }
        };
    } };
    const app = express();
    app.use("/api/monitoring", createMonitoringRouter({
        manager: { enabled: true, environment: "test" }, getDatabase: () => db
    }));
    app.use((_error, _req, res, _next) => res.status(500).json({ message: "Internal server error" }));
    const server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    const base = `http://127.0.0.1:${server.address().port}/api/monitoring`;
    const end = new Date();
    const from = new Date(end.getTime() - 3600000);
    const dates = new URLSearchParams({ from: from.toISOString(), to: end.toISOString() });
    const metrics = new URLSearchParams(dates);
    metrics.set("service", "backend");
    metrics.set("metric", "http_requests");
    metrics.set("interval", "1m");
    const trace = "4e4f00a6-139a-4db8-ae59-1b9ccdcaf120";
    const originalError = console.error;
    const logged = [];
    console.error = (...args) => logged.push(args);
    try {
        for (const endpoint of [
            "/overview", `/events?${dates}`, `/traces/${trace}?${dates}`,
            `/metrics?${metrics}`, "/services"
        ]) {
            calls.length = 0;
            const response = await fetch(`${base}${endpoint}`, { headers: { cookie: "tm_session=allowed" } });
            assert.equal(response.status, 503, endpoint);
            assert.equal(response.headers.get("cache-control"), "no-store");
            const payload = await response.json();
            assert.equal(payload.code, "MONITORING_INDEX_UNAVAILABLE");
            assert.match(payload.message, /índices de Firestore/);
            assert.doesNotMatch(JSON.stringify(payload), /private\.example/);
            assert.equal(calls[0], "audit");
            assert.equal(calls.length, 2);
        }
        assert.equal(logged.length, 5);
        assert.equal(logged[0][1], failure);
        failure = Object.assign(new Error("9 FAILED_PRECONDITION: another failure"), { code: 9 });
        const unrelated = await fetch(`${base}/overview`, { headers: { cookie: "tm_session=allowed" } });
        assert.equal(unrelated.status, 500);
        assert.deepEqual(await unrelated.json(), { message: "Internal server error" });
    } finally {
        console.error = originalError;
        await new Promise((resolve) => server.close(resolve));
    }
});
