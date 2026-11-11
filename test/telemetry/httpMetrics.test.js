const test = require("node:test");
const assert = require("node:assert/strict");
const { Timestamp } = require("firebase-admin/firestore");
const { HttpMetrics, HISTOGRAM_KEYS } = require("../../src/telemetry/httpMetrics");
const { loadHttpMetrics, MAX_BUCKETS } = require("../../src/telemetry/metricsQuery");

function fakeDatabase(write) {
    return {
        collection(name) {
            assert.equal(name, "monitoringMetricBuckets");
            return { doc: (id) => ({ create: (data) => write(id, data) }) };
        }
    };
}

test("HTTP metrics aggregate response counts, 5xx and histogram without I/O per request", async () => {
    const writes = [];
    const metrics = new HttpMetrics({
        instanceId: "instance", environment: "test",
        getDatabase: () => fakeDatabase(async (id, data) => writes.push({ id, data }))
    });
    [0, 49.9, 50, 100, 250, 500, 1000, 3000].forEach((value, i) => metrics.record(value, i === 7 ? 500 : 200, 60005));
    assert.equal(writes.length, 0);
    await metrics.flush(119999);
    assert.equal(writes.length, 0);
    await metrics.flush(120000);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].id, "instance_60000");
    const bucket = writes[0].data;
    assert.equal(bucket.count, 8);
    assert.equal(bucket.errors, 1);
    assert.equal(bucket.sum, 4949.9);
    assert.deepEqual(Object.values(bucket.histogram), [2, 1, 1, 1, 1, 1, 1]);
    assert.equal(bucket.expiresAt.toMillis() - bucket.intervalStart.toMillis(), 90 * 86400000);
});

test("metrics retries are bounded, idempotent and report failures and overflow", async () => {
    let attempts = 0;
    const metrics = new HttpMetrics({
        instanceId: "instance", environment: "test", capacity: 1, maxAttempts: 2,
        getDatabase: () => fakeDatabase(async () => { attempts += 1; throw new Error("offline"); })
    });

    test("clock rollback cannot overwrite an already closed interval", async () => {
        const writes = [];
        const metrics = new HttpMetrics({
            instanceId: "instance", environment: "test",
            getDatabase: () => fakeDatabase(async (id) => writes.push(id))
        });
        metrics.record(5, 200, 60000);
        await metrics.flush(120000);
        metrics.record(5, 200, 60001);
        await metrics.flush(180000);
        assert.deepEqual(writes, ["instance_60000"]);
        assert.equal(metrics.getHealth().droppedSamples, 1);
    });
    metrics.record(5, 200, 0);
    const originalError = console.error;
    console.error = () => {};
    try {
        await metrics.flush(60000);
        assert.equal(metrics.getHealth().pending, 1);
        metrics.record(10, 500, 60000);
        metrics.rotate(120000);
        assert.equal(metrics.getHealth().dropped, 1);
        metrics.nextRetryAt = 0;
        await metrics.flush(120000);
        assert.equal(attempts, 2);
        assert.equal(metrics.getHealth().failed, 1);
        assert.equal(metrics.getHealth().pending, 0);
    } finally {
        console.error = originalError;
    }

    const duplicate = new HttpMetrics({
        instanceId: "instance", environment: "test",
        getDatabase: () => fakeDatabase(async () => { throw Object.assign(new Error("exists"), { code: 6 }); })
    });
    duplicate.record(5, 200, 0);
    await duplicate.flush(60000);
    assert.equal(duplicate.getHealth().failed, 0);
    assert.equal(duplicate.getHealth().consecutiveFailures, 0);
});

test("completed intervals from independent instances can be written and combined", async () => {
    const stored = new Map();
    const database = fakeDatabase(async (id, value) => {
        if (stored.has(id)) throw Object.assign(new Error("exists"), { code: 6 });
        stored.set(id, value);
    });
    const first = new HttpMetrics({ instanceId: "one", environment: "test", getDatabase: () => database });
    const second = new HttpMetrics({ instanceId: "two", environment: "test", getDatabase: () => database });
    first.record(20, 200, 60000);
    second.record(80, 503, 60000);
    await Promise.all([first.flush(120000), second.flush(120000)]);
    const docs = [...stored.values()].map((value) => ({ data: () => value }));
    const result = await loadHttpMetrics(queryDatabase(docs, []), {
        now: 120000, durationMs: 120000, environment: "test"
    });
    assert.equal(result.count, 2);
    assert.equal(result.errors, 1);
    assert.equal(result.averageMs, 50);
    assert.equal(result.points.length, 1);
});

function bucket(start, count, sum, errors, histogram, environment = "test") {
    return { data: () => ({
        intervalStart: Timestamp.fromMillis(start), service: "backend", environment,
        metricName: "http_requests", count, sum, errors,
        histogram: Object.fromEntries(HISTOGRAM_KEYS.map((key, index) => [key, histogram[index] || 0]))
    }) };
}

function queryDatabase(docs, calls) {
    return { collection: () => ({
        where(field, op, value) { calls.push([field, op, typeof value === "string" ? value : value.toMillis()]); return this; },
        orderBy(field, direction) { calls.push([field, direction]); return this; },
        limit(count) { calls.push(["limit", count]); return this; },
        async get() { return { docs }; }
    }) };
}

test("query combines instances and estimates p95 as a histogram range", async () => {
    const calls = [];
    const now = 3600000;
    const docs = [
        bucket(60000, 2, 100, 1, [1, 1]),
        bucket(60000, 1, 700, 0, [0, 0, 0, 0, 1]),
        bucket(120000, 1, 30, 0, [1]),
        bucket(120000, 1, 300, 0, [0, 0, 0, 1], "production")
    ];
    const result = await loadHttpMetrics(queryDatabase(docs, calls), { now, durationMs: 3600000, environment: "test" });
    assert.equal(result.count, 4);
    assert.equal(result.errors, 1);
    assert.equal(result.averageMs, 207.5);
    assert.equal(result.p95Range, "500-1000");
    assert.equal(result.p99Range, "500-1000");
    assert.equal(result.points.length, 2);
    assert.equal(result.points[0].count, 3);
    assert.deepEqual(calls.slice(0, 3), [
        ["environment", "==", "test"], ["service", "==", "backend"], ["metricName", "==", "http_requests"]
    ]);
    assert.deepEqual(calls[3], ["intervalStart", ">=", 0]);
    assert.deepEqual(calls[4], ["intervalStart", "<", 3600000]);
    assert.deepEqual(calls[6], ["limit", MAX_BUCKETS + 1]);
});

test("p95 and p99 use histogram thresholds across instances and stay unknown without samples", async () => {
    const docs = [
        bucket(60000, 50, 1000, 0, [50]),
        bucket(60000, 50, 3000, 0, [44, 4, 1, 0, 0, 0, 1])
    ];
    const filters = { now: 3600000, durationMs: 3600000, environment: "test" };
    const result = await loadHttpMetrics(queryDatabase(docs, []), filters);
    assert.equal(result.count, 100);
    assert.equal(result.p95Range, "50-100");
    assert.equal(result.p99Range, "100-250");
    const empty = await loadHttpMetrics(queryDatabase([], []), filters);
    assert.equal(empty.p95Range, null);
    assert.equal(empty.p99Range, null);
});

test("query refuses truncated or corrupt metrics instead of reporting partial results", async () => {
    const query = { now: 3600000, durationMs: 3600000, environment: "test" };
    await assert.rejects(loadHttpMetrics(queryDatabase(Array(MAX_BUCKETS + 1).fill({}), []), query), { statusCode: 503 });
    const invalid = bucket(60000, 2, 10, 0, [1]);
    await assert.rejects(loadHttpMetrics(queryDatabase([invalid], []), query), /no es válido/);
});
