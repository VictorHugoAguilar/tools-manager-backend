const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const sessions = require("../../src/services/authSessionService");
const originalResolveSession = sessions.resolveSession;
sessions.resolveSession = async (token) => {
    if (token === "allowed") return { profile: { id: "real-user", permissions: ["monitoring:app"] } };
    if (token === "denied") return { profile: { id: "denied-user", permissions: [] } };
    return null;
};
const { createMonitoringRouter } = require("../../src/routes/monitoringRoutes");
const { BaselineStats } = require("../../src/telemetry/baselineStats");

test.after(() => { sessions.resolveSession = originalResolveSession; });

test("baseline requires permission, is audited first and exposes counters, cache and memory without sensitive data", async () => {
    const audits = [];
    let auditFails = false;
    const database = { collection(name) {
        assert.equal(name, "auditEvents");
        return { doc: (id) => ({ async create(record) {
            if (auditFails) throw new Error("audit unavailable");
            audits.push([id, record]);
        } }) };
    } };
    const baseline = new BaselineStats();
    baseline.recordOperation({ source: "rtdb", kind: "read", resource: "tools", scope: "collection" }, 5, false);
    const manager = { enabled: true, instanceId: "instance-1", baseline };
    const app = express();
    app.use("/api/monitoring", createMonitoringRouter({ manager, getDatabase: () => database }));
    app.use((_error, _req, res, _next) => res.status(500).json({ message: "Internal server error" }));
    const server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    const url = `http://127.0.0.1:${server.address().port}/api/monitoring/baseline`;
    const options = (token) => ({ headers: { cookie: `tm_session=${token}` } });
    try {
        assert.equal((await fetch(url)).status, 401);
        assert.equal((await fetch(url, options("denied"))).status, 403);
        assert.equal(audits.length, 0);

        const response = await fetch(url, options("allowed"));
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("cache-control"), "no-store");
        const payload = await response.json();
        assert.equal(payload.operations[0].resource, "tools");
        assert.equal(typeof payload.cache.hits, "number");
        assert.ok("hitRatio" in payload.cache);
        assert.ok(payload.process.rssMb > 0);
        assert.equal(audits[0][1].action, "monitoring.baseline.accessed");
        assert.equal(audits[0][1].actorId, "real-user");

        auditFails = true;
        assert.equal((await fetch(url, options("allowed"))).status, 500);
        auditFails = false;
        manager.enabled = false;
        assert.equal((await fetch(url, options("allowed"))).status, 503);
    } finally {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
});
