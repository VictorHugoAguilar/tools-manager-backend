const test = require("node:test");
const assert = require("node:assert/strict");
const { DatabaseMetrics } = require("../../src/telemetry/databaseMetrics");
const { instrumentClientSdk, instrumentAdminDatabase, setDatabaseRecorder } = require("../../src/telemetry/databaseInstrumentation");

test("DatabaseMetrics agrupa operaciones y errores sin rutas", () => {
    const metrics = new DatabaseMetrics({ instanceId: "i1", environment: "test", getDatabase: () => ({}) });
    metrics.recordOperation(10, false, 60000);
    metrics.recordOperation(120, true, 61000);
    const [bucket] = metrics.buckets.values();
    const document = metrics.createDocument(bucket);
    assert.equal(document.metricName, "database_operations");
    assert.equal(document.service, "backend");
    assert.equal(document.count, 2);
    assert.equal(document.errors, 1);
    assert.equal(metrics.documentId(bucket), "database_i1_60000");
});

test("el SDK cliente mide éxitos y fallos y no cuenta llamadas anidadas", async () => {
    const calls = [];
    setDatabaseRecorder((duration, failed) => calls.push({ duration, failed }));
    const sdk = require("@firebase/database");
    const original = { get: sdk.get, set: sdk.set };
    try {
        sdk.get = async () => "ok";
        sdk.set = async () => { throw new Error("denegado"); };
        instrumentClientSdk();
        assert.equal(await sdk.get({}), "ok");
        await assert.rejects(sdk.set({}, 1));
        await new Promise((resolve) => setImmediate(resolve));
        assert.deepEqual(calls.map((call) => call.failed), [false, true]);
        assert.ok(calls.every((call) => call.duration >= 0));
    } finally {
        setDatabaseRecorder(null);
        Object.assign(sdk, original);
    }
});

test("el Admin SDK mide get y set una sola vez por operación", async () => {
    const calls = [];
    class Query { async get() { return 1; } async once() { return this.get(); } }
    class Reference extends Query { async set() { return 1; } }
    setDatabaseRecorder((duration, failed) => calls.push(failed));
    instrumentAdminDatabase({ ref: () => new Reference() });
    const reference = new Reference();
    await reference.once();
    await reference.set();
    await new Promise((resolve) => setImmediate(resolve));
    setDatabaseRecorder(null);
    assert.deepEqual(calls, [false, false]);
});

test("el muestreo solo afecta a DEBUG/INFO y conserva trazas completas", () => {
    const { TelemetryQueue } = require("../../src/telemetry/telemetry");
    const event = (level, traceId) => ({ level, traceId });
    const none = new TelemetryQueue(100, { DEBUG: "0", INFO: "0" });
    assert.equal(none.enqueue(event("INFO", "t")), false);
    assert.equal(none.enqueue(event("DEBUG")), false);
    assert.equal(none.enqueue(event("WARN")), true);
    assert.equal(none.enqueue(event("ERROR")), true);
    assert.deepEqual(none.sampledOut, { DEBUG: 1, INFO: 1 });
    assert.equal(none.dropped.INFO, 0);
    const half = new TelemetryQueue(100, { INFO: "0.5" });
    for (let i = 0; i < 40; i += 1) {
        const trace = `trace-${i}`;
        const first = half.enqueue(event("INFO", trace));
        assert.equal(half.enqueue(event("INFO", trace)), first);
    }
    assert.ok(half.items.length > 0 && half.items.length < 80);
    assert.equal(new TelemetryQueue(1, { INFO: "abc" }).sampleRates.INFO, 1);
});
