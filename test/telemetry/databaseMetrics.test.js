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

test("el catálogo acepta las medidas de rendimiento del navegador solo con durationMs", () => {
    const { normalizeFrontendEvent } = require("../../src/telemetry/telemetry");
    const base = { schemaVersion: 1, eventId: "5b0a4f1e-2a6c-4c52-9a43-3f0f7d7f9a10", occurredAt: new Date().toISOString() };
    const context = { environment: "test", actorId: "u1", instanceId: "i" };
    for (const name of ["page.loaded", "first_contentful_paint", "largest_contentful_paint", "long_task", "route_transition"]) {
        const event = normalizeFrontendEvent({ ...base, eventName: `frontend.performance.${name}`, durationMs: 123 }, context);
        assert.equal(event.level, "INFO");
        assert.equal(event.durationMs, 123);
    }
    assert.equal(normalizeFrontendEvent({ ...base, eventName: "frontend.performance.long_task", url: "/x" }, context), null);
});

test("failed browser requests carry only a normalized route, method, status and page", () => {
    const { normalizeFrontendEvent } = require("../../src/telemetry/telemetry");
    const context = { environment: "test", actorId: "user-1", instanceId: "i-1" };
    const base = {
        schemaVersion: 1, eventId: "6f1c1f5e-0f0a-4a5e-8d2b-1b2c3d4e5f60",
        occurredAt: "2026-11-12T10:00:00.000Z", eventName: "frontend.api.request.failed"
    };
    const event = normalizeFrontendEvent({
        ...base, http: { method: "POST", route: "/api/tools/:id/assign", statusCode: 500 }, page: "/inventario/:id"
    }, context);
    assert.deepEqual(event.http, { method: "POST", route: "/api/tools/:id/assign", statusCode: 500 });
    assert.equal(event.page, "/inventario/:id");
    assert.equal(event.actorId, "user-1");
    for (const bad of [
        { http: { method: "GET", route: "/api/tools/abc123?x=1", statusCode: 500 } },
        { http: { method: "GET", route: "/api/tools/Ab9", statusCode: 500 } },
        { http: { method: "TRACE", route: "/api/tools", statusCode: 500 } },
        { http: { method: "GET", route: "/api/tools", statusCode: 700 } },
        { http: { method: "GET", route: "/api/tools", statusCode: 500, body: "x" } },
        { page: "/inventario/9f8e7d" },
        { page: "/a?token=1" }
    ]) assert.equal(normalizeFrontendEvent({ ...base, ...bad }, context), null);
});
