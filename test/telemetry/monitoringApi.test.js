const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { Timestamp } = require("firebase-admin/firestore");
const sessions = require("../../src/services/authSessionService");
const originalResolveSession = sessions.resolveSession;
sessions.resolveSession = async (token) => {
    if (token === "allowed") return { profile: { id: "real-user", permissions: ["monitoring:app"] } };
    if (token === "denied") return { profile: { id: "denied-user", permissions: [] } };
    return null;
};
const { createMonitoringRouter } = require("../../src/routes/monitoringRoutes");

test.after(() => { sessions.resolveSession = originalResolveSession; });

test("monitoring requires permission and a durable audit before reading bounded events", async () => {
    const calls = [];
    let auditFails = false;
    let activeCountFails = false;
    const query = {
        where(field, op, timestamp) {
            calls.push([field, op, typeof timestamp === "string" ? timestamp : timestamp.toMillis()]);
            return this;
        },
        orderBy(field, direction) { calls.push([field, direction]); return this; },
        limit(count) { calls.push(["limit", count]); return this; },
        async get() {
            calls.push(["read"]);
            return { docs: [{ id: "event-id", data: () => ({
                receivedAt: { toDate: () => new Date("2026-01-01T10:00:00Z") },
                service: "backend", level: "ERROR", eventName: "http.request.failed",
                actorId: "private-user", connectionId: "connection-id",
                http: { method: "GET", route: "/api/tools/:id", statusCode: 500 }
            }) }] };
        }
    };
    const database = {
        collection(name) {
            if (name === "monitoringEvents") return query;
            if (name === "monitoringMetricBuckets") return {
                where() { return this; },
                orderBy() { return this; },
                limit() { return this; },
                async get() { calls.push(["metrics"]); return { docs: [] }; }
            };
            if (name === "monitoringInstances") return {
                where() { return this; },
                orderBy() { return this; },
                limit() { return this; },
                async get() {
                    calls.push(["heartbeats"]);
                    const time = Date.now() - 1000;
                    return { docs: [{ id: "backend-instance", data: () => ({
                        service: "backend", environment: "test", heartbeatAt: Timestamp.fromMillis(time),
                        resources: {
                            process: { sampledAt: time, cpuPercent: 123, rssBytes: 1024 },
                            disk: { sampledAt: time, totalBytes: 100, usedBytes: 60, availableBytes: 35 }
                        }
                    }) }] };
                }
            };
            if (name === "monitoringActiveUsers") return {
                where() { return this; },
                count() { return { get: async () => {
                    if (activeCountFails) throw new Error("count unavailable");
                    return { data: () => ({ count: 2 }) };
                } }; }
            };
            assert.equal(name, "auditEvents");
            return { doc: (id) => ({
                async create(record) {
                    calls.push(["audit", id, record]);
                    if (auditFails) throw new Error("audit unavailable");
                }
            }) };
        }
    };
    const manager = { enabled: true, environment: "test", getHealth: () => ({ queuePending: 0 }) };
    const app = express();
    app.use("/api/monitoring", createMonitoringRouter({ manager, getDatabase: () => database }));
    app.use((_error, _req, res, _next) => res.status(500).json({ message: "Internal server error" }));
    const server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    const url = `http://127.0.0.1:${server.address().port}/api/monitoring/overview`;
    const options = (token) => ({ headers: { cookie: `tm_session=${token}` } });
    try {
        assert.equal((await fetch(url)).status, 401);
        assert.equal((await fetch(url, options("denied"))).status, 403);
        assert.equal((await fetch(`${url}?period=invalid`, options("allowed"))).status, 400);
        assert.equal(calls.length, 0);
        const response = await fetch(`${url}?period=24h`, options("allowed"));
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("cache-control"), "no-store");
        const payload = await response.json();
        assert.equal(payload.period, "24h");
        assert.equal(payload.activeUsers.count, 2);
        assert.equal(payload.activeUsers.windowMinutes, 5);
        assert.equal(payload.httpMetrics.count, 0);
        assert.deepEqual(payload.webSocketMetrics.points, []);
        assert.equal(payload.heartbeats.services.websocket.lastHeartbeatAt, null);
        assert.equal(payload.heartbeats.resources.backend[0].instanceId, "backend-instance");
        assert.equal(payload.heartbeats.resources.backend[0].process.cpuPercent, 123);
        assert.equal(payload.heartbeats.resources.backend[0].disk.availableBytes, 35);
        assert.equal(payload.events[0].eventId, "event-id");
        assert.equal(payload.events[0].actorId, undefined);
        assert.equal(payload.events[0].connectionId, "connection-id");
        assert.equal(calls[0][0], "audit");
        assert.equal(calls[0][2].actorId, "real-user");
        assert.equal(calls[0][2].action, "monitoring.dashboard.accessed");
        assert.deepEqual(calls[1], ["environment", "==", "test"]);
        assert.equal(calls[3][2] - calls[2][2], 86400000);
        assert.deepEqual(calls[5], ["limit", 25]);
        const servicesResponse = await fetch(url.replace("/overview", "/services"), options("allowed"));
        assert.equal(servicesResponse.status, 200);
        const services = await servicesResponse.json();
        assert.equal(services.resources.backend[0].instanceId, "backend-instance");
        assert.equal(services.resources.backend[0].disk.totalBytes, 100);
        activeCountFails = true;
        const previousError = console.error;
        console.error = () => {};
        try {
            const failedCount = await fetch(url, options("allowed"));
            assert.equal(failedCount.status, 200);
            assert.equal((await failedCount.json()).activeUsers, null);
        } finally { console.error = previousError; }
        calls.length = 0;
        auditFails = true;
        assert.equal((await fetch(url, options("allowed"))).status, 500);
        assert.deepEqual(calls.map((entry) => entry[0]), ["audit"]);
        manager.enabled = false;
        calls.length = 0;
        assert.equal((await fetch(url, options("allowed"))).status, 503);
        assert.equal(calls.length, 0);
    } finally {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
});
