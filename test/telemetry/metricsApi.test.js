const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { Timestamp } = require("firebase-admin/firestore");
const sessions = require("../../src/services/authSessionService");
const originalResolveSession = sessions.resolveSession;
sessions.resolveSession = async (token) => {
    if (token === "allowed") return { profile: { id: "actor", permissions: ["monitoring:app"] } };
    if (token === "denied") return { profile: { id: "denied", permissions: [] } };
    return null;
};
const { createMonitoringRouter } = require("../../src/routes/monitoringRoutes");
test.after(() => { sessions.resolveSession = originalResolveSession; });

test("metrics and services enforce authorization, validate filters and audit before reading", async () => {
    const calls = [];
    let auditFails = false;
    const start = Math.floor(Date.now() / 3600000) * 3600000 - 7200000;
    const db = { collection(name) {
        if (name === "auditEvents") return { doc: () => ({ create: async (record) => {
            calls.push(["audit", record]);
            if (auditFails) throw new Error("audit unavailable");
        } }) };
        assert.ok(["monitoringMetricBuckets", "monitoringInstances"].includes(name));
        calls.push(["collection", name]);
        const conditions = [];
        return {
            where(field, op, value) { conditions.push([field, op, value]); return this; },
            orderBy() { return this; },
            limit() { return this; },
            async get() {
                calls.push(["read", conditions]);
                if (name === "monitoringInstances") return { docs: [] };
                const service = conditions.find(([field]) => field === "service")[2];
                assert.equal(conditions.find(([field]) => field === "environment")[2], "test");
                assert.equal(conditions.find(([field]) => field === "metricName")[2],
                    service === "backend" ? "http_requests" : "websocket_activity");
                const docs = [60000, 180000].map((offset) => ({ data: () => ({
                    service, environment: "test",
                    intervalStart: Timestamp.fromMillis(start + offset),
                    ...(service === "backend" ? {
                        metricName: "http_requests", count: 1, errors: 0, sum: 25,
                        histogram: { "0-50": 1, "50-100": 0, "100-250": 0, "250-500": 0,
                            "500-1000": 0, "1000-3000": 0, "3000+": 0 }
                    } : { metricName: "websocket_activity", opened: 1, closed: 0, updates: 2 })
                }) }));
                return { docs };
            }
        };
    } };
    const manager = { enabled: true, environment: "test" };
    const app = express();
    app.use("/api/monitoring", createMonitoringRouter({ manager, getDatabase: () => db }));
    app.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({ message: err.message }));
    const server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    const base = `http://127.0.0.1:${server.address().port}/api/monitoring`;
    const headers = { cookie: "tm_session=allowed" };
    const params = new URLSearchParams({
        from: new Date(start).toISOString(), to: new Date(start + 3600000).toISOString(),
        service: "backend", metric: "http_requests", interval: "1m"
    });
    const request = (query) => `${base}/metrics?${query}`;
    try {
        assert.equal((await fetch(request(params))).status, 401);
        assert.equal((await fetch(request(params), { headers: { cookie: "tm_session=denied" } })).status, 403);
        assert.equal((await fetch(`${base}/services`)).status, 401);
        assert.equal((await fetch(`${base}/services`, { headers: { cookie: "tm_session=denied" } })).status, 403);
        assert.equal(calls.length, 0);

        for (const [key, value] of [
            ["service", "frontend"], ["metric", "websocket_activity"], ["interval", "5m"],
            ["from", "not-a-date"], ["extra", "value"]
        ]) {
            const invalid = new URLSearchParams(params);
            invalid.set(key, value);
            assert.equal((await fetch(request(invalid), { headers })).status, 400, key);
        }
        const short = new URLSearchParams(params);
        short.set("to", new Date(start + 59999).toISOString());
        assert.equal((await fetch(request(short), { headers })).status, 400);
        const tooLong = new URLSearchParams(params);
        tooLong.set("from", new Date(start - 7 * 86400000).toISOString());
        assert.equal((await fetch(request(tooLong), { headers })).status, 400);
        assert.equal((await fetch(`${base}/services?service=backend`, { headers })).status, 400);
        assert.equal(calls.length, 0);

        const minute = await fetch(request(params), { headers });
        assert.equal(minute.status, 200);
        assert.equal(minute.headers.get("cache-control"), "no-store");
        const minuteData = await minute.json();
        assert.equal(minuteData.metric, "http_requests");
        assert.equal(minuteData.resolutionSeconds, 60);
        assert.equal(minuteData.count, 2);
        assert.equal(minuteData.p99Range, "0-50");
        assert.equal(minuteData.points.length, 2);
        assert.equal(calls[0][1].action, "monitoring.metrics.accessed");
        assert.equal(calls[0][1].actorId, "actor");
        assert.deepEqual(calls.map(([type]) => type), ["audit", "collection", "read"]);

        calls.length = 0;
        params.set("interval", "1h");
        const hourly = await (await fetch(request(params), { headers })).json();
        assert.equal(hourly.resolutionSeconds, 3600);
        assert.equal(hourly.points.length, 1);
        assert.equal(hourly.points[0].count, 2);
        params.set("service", "websocket");
        params.set("metric", "websocket_activity");
        calls.length = 0;
        const socket = await (await fetch(request(params), { headers })).json();
        assert.equal(socket.service, "websocket");
        assert.deepEqual(socket.points, [{ start: new Date(start).toISOString(), opened: 2, closed: 0, updates: 4 }]);
        assert.deepEqual(calls.map(([type]) => type), ["audit", "collection", "read"]);

        calls.length = 0;
        const services = await fetch(`${base}/services`, { headers });
        assert.equal(services.status, 200);
        assert.equal(services.headers.get("cache-control"), "no-store");
        const serviceData = await services.json();
        assert.equal(serviceData.services.frontend, null);
        assert.equal(serviceData.services.storage, null);
        assert.equal(serviceData.services.websocket.activeConnections, null);
        assert.equal(calls[0][1].action, "monitoring.services.accessed");
        assert.deepEqual(calls.map(([type]) => type), ["audit", "collection", "read"]);

        auditFails = true;
        for (const url of [request(params), `${base}/services`]) {
            calls.length = 0;
            assert.equal((await fetch(url, { headers })).status, 500);
            assert.deepEqual(calls.map(([type]) => type), ["audit"]);
        }
        manager.enabled = false;
        calls.length = 0;
        assert.equal((await fetch(request(params), { headers })).status, 503);
        assert.equal((await fetch(`${base}/services`, { headers })).status, 503);
        assert.equal(calls.length, 0);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});
