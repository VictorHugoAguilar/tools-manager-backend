const test = require("node:test");
const assert = require("node:assert/strict");
const { Timestamp } = require("firebase-admin/firestore");
const { WebSocketMetrics } = require("../../src/telemetry/webSocketMetrics");
const { loadWebSocketMetrics, MAX_BUCKETS } = require("../../src/telemetry/metricsQuery");

function writer(write) {
    return { collection: () => ({ doc: (id) => ({ create: (data) => write(id, data) }) }) };
}

function query(docs, calls = []) {
    return { collection: () => ({
        where(field, op, value) {
            calls.push([field, op, typeof value === "string" ? value : value.toMillis()]);
            return this;
        },
        orderBy() { return this; },
        limit(count) { calls.push(["limit", count]); return this; },
        async get() { return { docs }; }
    }) };
}

test("WebSocket metrics aggregate by instance and interval without storing messages", async () => {
    const writes = [];
    const metrics = new WebSocketMetrics({
        instanceId: "ws", environment: "test",
        getDatabase: () => writer(async (id, value) => writes.push({ id, value }))
    });
    metrics.record("opened", 60001);
    metrics.record("updates", 60002);
    metrics.record("updates", 60003);
    metrics.record("closed", 60004);
    await metrics.flush(119999);
    assert.equal(writes.length, 0);
    await metrics.flush(120000);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].id, "websocket_ws_60000");
    assert.deepEqual(
        [writes[0].value.opened, writes[0].value.closed, writes[0].value.updates],
        [1, 1, 2]
    );
    assert.equal(writes[0].value.expiresAt.toMillis() - 60000, 90 * 86400000);
    assert.deepEqual(Object.keys(writes[0].value).sort(), [
        "closed", "environment", "expiresAt", "instanceId", "intervalSeconds", "intervalStart",
        "metricName", "opened", "schemaVersion", "service", "updates"
    ]);
    metrics.record("opened", 60005);
    assert.equal(metrics.getHealth().droppedSamples, 1);
    assert.throws(() => metrics.record("payload"), /no válida/);
});

test("WebSocket query combines instances and keeps missing intervals absent", async () => {
    const bucket = (start, opened, closed, updates, environment = "test") => ({ data: () => ({
        intervalStart: Timestamp.fromMillis(start), environment, service: "websocket",
        metricName: "websocket_activity", opened, closed, updates
    }) });
    const calls = [];
    const docs = [bucket(60000, 2, 1, 5), bucket(60000, 3, 0, 7), bucket(180000, 1, 1, 0),
        bucket(60000, 100, 100, 100, "production")];
    const result = await loadWebSocketMetrics(query(docs, calls), {
        now: 3600000, durationMs: 3600000, environment: "test"
    });
    assert.deepEqual(calls.slice(0, 3), [
        ["environment", "==", "test"], ["service", "==", "websocket"],
        ["metricName", "==", "websocket_activity"]
    ]);
    assert.deepEqual(result.points, [
        { start: new Date(60000).toISOString(), opened: 5, closed: 1, updates: 12 },
        { start: new Date(180000).toISOString(), opened: 1, closed: 1, updates: 0 }
    ]);
    assert.deepEqual(calls.at(-1), ["limit", MAX_BUCKETS + 1]);
});

test("WebSocket metrics use bounded retries and reject incomplete or invalid reads", async () => {
    let attempts = 0;
    const metrics = new WebSocketMetrics({
        instanceId: "ws", environment: "test", maxAttempts: 2,
        getDatabase: () => writer(async () => { attempts++; throw new Error("offline"); })
    });

    metrics.record("opened", 0);
    const previousError = console.error;
    console.error = () => {};
    try {
        await metrics.flush(60000);
        assert.equal(metrics.getHealth().pending, 1);
        metrics.nextRetryAt = 0;
        await metrics.flush(60000);
        assert.equal(attempts, 2);
        assert.equal(metrics.getHealth().failed, 1);
    } finally { console.error = previousError; }
    const filters = { now: 3600000, durationMs: 3600000, environment: "test" };
    await assert.rejects(loadWebSocketMetrics(query(Array(MAX_BUCKETS + 1).fill({})), filters), { statusCode: 503 });
    const bad = { data: () => ({
        environment: "test", service: "websocket", metricName: "websocket_activity",
        intervalStart: Timestamp.fromMillis(60000), opened: -1, closed: 0, updates: 0
    }) };
    await assert.rejects(loadWebSocketMetrics(query([bad]), filters), /no es válido/);
});

test("seven days of per-minute activity for one instance do not exceed the query limit", async () => {
    const docs = Array.from({ length: 7 * 24 * 60 }, (_, i) => ({ data: () => ({
        environment: "test", service: "websocket", metricName: "websocket_activity",
        intervalStart: Timestamp.fromMillis(i * 60000), opened: 0, closed: 0, updates: 1
    }) }));
    const result = await loadWebSocketMetrics(query(docs), {
        now: 7 * 86400000, durationMs: 7 * 86400000, environment: "test"
    });
    assert.equal(result.points.length, 168);
    assert.equal(result.points.reduce((sum, point) => sum + point.updates, 0), 10080);
});

test("already-written WebSocket metric retries are idempotent", async () => {
    const metrics = new WebSocketMetrics({
        instanceId: "ws", environment: "test",
        getDatabase: () => writer(async () => { throw Object.assign(new Error("exists"), { code: 6 }); })
    });
    metrics.record("updates", 0);
    await metrics.flush(60000);
    assert.equal(metrics.getHealth().failed, 0);
    assert.equal(metrics.getHealth().pending, 0);
});
