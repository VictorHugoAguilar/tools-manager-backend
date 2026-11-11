const test = require("node:test");
const assert = require("node:assert/strict");
const { Timestamp } = require("firebase-admin/firestore");
const { Heartbeat, loadHeartbeatSummary, FRESHNESS_MS, MAX_INSTANCES } = require("../../src/telemetry/heartbeat");
const { TelemetryManager } = require("../../src/telemetry/telemetry");

function document(service, environment, timestamp) {
    return { data: () => ({ service, environment, heartbeatAt: Timestamp.fromMillis(timestamp) }) };
}

function queryDatabase(docs, calls = []) {
    return { collection(name) {
        assert.equal(name, "monitoringInstances");
        return {
            where(field, op, value) { calls.push([field, op, typeof value === "string" ? value : value.toMillis()]); return this; },
            orderBy(field, direction) { calls.push([field, direction]); return this; },
            limit(value) { calls.push(["limit", value]); return this; },
            async get() { return { docs }; }
        };
    } };
}

test("heartbeat writes once per instance using server timestamp and expiry", async () => {
    const writes = [];
    const heartbeat = new Heartbeat({
        instanceId: "instance", service: "websocket", environment: "test",
        getDatabase: () => ({ collection: (collection) => ({
            doc: (id) => ({ set: async (data) => writes.push({ collection, id, data }) })
        }) })
    });
    await heartbeat.write();
    assert.equal(writes.length, 1);
    assert.equal(writes[0].collection, "monitoringInstances");
    assert.equal(writes[0].id, "instance");
    assert.equal(writes[0].data.service, "websocket");
    assert.equal(writes[0].data.heartbeatAt.isEqual(require("firebase-admin/firestore").FieldValue.serverTimestamp()), true);
    assert.ok(writes[0].data.expiresAt.toMillis() > Date.now());
    assert.ok(heartbeat.lastSuccess);
});

test("WebSocket heartbeat publishes only bounded counters without connection payloads", async () => {
    let written;
    const heartbeat = new Heartbeat({
        instanceId: "instance", service: "websocket", environment: "test",
        getDatabase: () => ({ collection: () => ({ doc: () => ({
            set: async (data) => { written = data; }
        }) }) })
    });
    heartbeat.setWebSocketStatsProvider(() => ({
        activeConnections: 2, openedConnections: 3, closedConnections: 1, receivedUpdates: 7
    }));
    await heartbeat.write();
    assert.deepEqual(written.webSocketStats, {
        activeConnections: 2, openedConnections: 3, closedConnections: 1, receivedUpdates: 7
    });
});

test("heartbeat prevents overlapping writes and records failures", async () => {
    let reject;
    let count = 0;
    const heartbeat = new Heartbeat({
        instanceId: "instance", service: "backend", environment: "test",
        getDatabase: () => ({ collection: () => ({ doc: () => ({
            set: () => { count++; return new Promise((_resolve, fail) => { reject = fail; }); }
        }) }) })
    });
    const original = console.error;
    console.error = () => {};
    try {
        const first = heartbeat.write();
        const second = heartbeat.write();
        await Promise.resolve();
        assert.equal(count, 1);
        assert.equal(first, second);
        reject(new Error("offline"));
        await first;
        assert.equal(heartbeat.failures, 1);
        assert.equal(heartbeat.lastSuccess, null);
    } finally { console.error = original; }
});

test("telemetry lifecycle starts heartbeats only when enabled and stops the timer", () => {
    let starts = 0;
    let stops = 0;
    const heartbeat = { start: () => { starts++; }, stop: () => { stops++; } };
    const disabled = new TelemetryManager({ enabled: false, heartbeat });
    disabled.start();
    assert.equal(starts, 0);
    const enabled = new TelemetryManager({ enabled: true, heartbeat });
    enabled.start();
    enabled.start();
    assert.equal(starts, 1);
    enabled.stop();
    assert.equal(stops, 1);
});

test("heartbeat summary separates stale, absent and recent instances by environment", async () => {
    const now = 1800000000000;
    const calls = [];
    const docs = [
        document("backend", "test", now - 1000),
        document("backend", "test", now - FRESHNESS_MS),
        document("websocket", "test", now - FRESHNESS_MS - 1),
        document("websocket", "production", now - 1000)
    ];
    const result = await loadHeartbeatSummary(queryDatabase(docs, calls), { now, environment: "test" });
    assert.equal(result.services.backend.recentInstances, 2);
    assert.equal(result.services.websocket.recentInstances, 0);
    assert.equal(result.services.websocket.lastHeartbeatAt, new Date(now - FRESHNESS_MS - 1).toISOString());
    assert.deepEqual(calls[0], ["environment", "==", "test"]);
    assert.deepEqual(calls.at(-1), ["limit", MAX_INSTANCES + 1]);
    const empty = await loadHeartbeatSummary(queryDatabase([]), { now, environment: "test" });
    assert.equal(empty.services.websocket.lastHeartbeatAt, null);
});

test("active connections include only recent instances and are unknown when data is missing", async () => {
    const now = 1800000000000;
    const ws = (time, active) => ({ data: () => ({
        service: "websocket", environment: "test", heartbeatAt: Timestamp.fromMillis(time),
        ...(active === undefined ? {} : { webSocketStats: { activeConnections: active } })
    }) });
    let result = await loadHeartbeatSummary(queryDatabase([
        ws(now - 1000, 3), ws(now - 2000, 0), ws(now - FRESHNESS_MS - 1, 100)
    ]), { now, environment: "test" });
    assert.equal(result.services.websocket.recentInstances, 2);
    assert.equal(result.services.websocket.activeConnections, 3);
    result = await loadHeartbeatSummary(queryDatabase([ws(now - 1000, 3), ws(now - 2000)]), { now, environment: "test" });
    assert.equal(result.services.websocket.activeConnections, null);
    result = await loadHeartbeatSummary(queryDatabase([]), { now, environment: "test" });
    assert.equal(result.services.websocket.activeConnections, null);
});

test("WebSocket metric health reports only complete recent instance data", async () => {
    const now = 1800000000000;
    const health = { pending: 1, activeIntervals: 1, dropped: 2, droppedSamples: 3, failed: 4, consecutiveFailures: 1 };
    const ws = (offset, metricHealth) => ({ data: () => ({
        service: "websocket", environment: "test", heartbeatAt: Timestamp.fromMillis(now - offset),
        webSocketStats: { activeConnections: 1 },
        ...(metricHealth ? { webSocketMetricHealth: metricHealth } : {})
    }) });
    const result = await loadHeartbeatSummary(queryDatabase([
        ws(1000, health), ws(2000, health), ws(FRESHNESS_MS + 1, health)
    ]), { now, environment: "test" });
    assert.deepEqual(result.services.websocket.metricHealth, {
        pending: 2, activeIntervals: 2, dropped: 4, droppedSamples: 6, failed: 8, consecutiveFailures: 2
    });
    const incomplete = await loadHeartbeatSummary(queryDatabase([ws(1000, health), ws(2000)]),
        { now, environment: "test" });
    assert.equal(incomplete.services.websocket.metricHealth, null);
});

test("heartbeat validates and writes WebSocket metric health", async () => {
    let written;
    const heartbeat = new Heartbeat({
        instanceId: "instance", service: "websocket", environment: "test",
        getDatabase: () => ({ collection: () => ({ doc: () => ({ set: async (data) => { written = data; } }) }) })
    });
    const health = { pending: 1, activeIntervals: 0, dropped: 2, droppedSamples: 0, failed: 0, consecutiveFailures: 1 };
    heartbeat.setWebSocketMetricHealthProvider(() => ({ ...health, privateValue: "must-not-be-saved" }));
    await heartbeat.write();
    assert.deepEqual(written.webSocketMetricHealth, health);
    heartbeat.setWebSocketMetricHealthProvider(() => ({ ...health, failed: -1 }));
    const previousError = console.error;
    console.error = () => {};
    try {
        await heartbeat.write();
        assert.equal(heartbeat.failures, 1);
    } finally { console.error = previousError; }
});

test("heartbeat summary rejects excessive or malformed results", async () => {
    const now = 1800000000000;
    await assert.rejects(loadHeartbeatSummary(queryDatabase(Array(MAX_INSTANCES + 1).fill({})), { now, environment: "test" }), { statusCode: 503 });
    await assert.rejects(loadHeartbeatSummary(queryDatabase([{ data: () => ({ service: "backend", environment: "test" }) }]), { now, environment: "test" }), /no válido/);
});
