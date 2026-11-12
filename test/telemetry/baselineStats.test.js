const test = require("node:test");
const assert = require("node:assert/strict");
const { BaselineStats } = require("../../src/telemetry/baselineStats");
const { instrumentAdminDatabase, setDatabaseRecorder } = require("../../src/telemetry/databaseInstrumentation");
const { instrumentFirestore, setFirestoreRecorder } = require("../../src/telemetry/firestoreInstrumentation");
const { createTelemetryMiddleware } = require("../../src/middleware/telemetryMiddleware");

test("operations are aggregated by source, resource, kind and scope with repeated reads", () => {
    let now = 1000;
    const stats = new BaselineStats({ now: () => now });
    const meta = { source: "rtdb", kind: "read", resource: "tools", scope: "collection" };
    stats.recordOperation(meta, 10, false);
    now += 1000;
    stats.recordOperation(meta, 30, true);
    now += 10000;
    stats.recordOperation(meta, 20, false);
    stats.recordOperation({ source: "firestore", kind: "read", resource: "monitoringEvents", scope: "collection", units: 25 }, 5, false);
    const { operations } = stats.snapshot();
    const tools = operations.find((operation) => operation.resource === "tools");
    assert.deepEqual([tools.count, tools.errors, tools.repeatedWithin5s, tools.maxMs, tools.averageMs], [3, 1, 1, 30, 20]);
    assert.equal(operations.find((operation) => operation.source === "firestore").units, 25);
});

test("database operations are attributed to the request that caused them", async () => {
    const stats = new BaselineStats();
    const context = stats.createContext();
    await stats.run(context, async () => {
        await Promise.resolve();
        stats.recordOperation({ source: "rtdb", kind: "read", resource: "tools", scope: "collection" }, 4, false);
        stats.recordOperation({ source: "rtdb", kind: "write", resource: "tools", scope: "item" }, 6, false);
        stats.recordOperation({ source: "firestore", kind: "read", resource: "auditEvents", scope: "collection", units: 3 }, 2, false);
    });
    stats.recordOperation({ source: "rtdb", kind: "read", resource: "tools", scope: "collection" }, 1, false);
    stats.recordRequest(context, { method: "GET", route: "/api/tools", statusCode: 200, durationMs: 20 });
    const [request] = stats.snapshot().requests;
    assert.deepEqual([request.rtdbReads, request.rtdbWrites, request.firestoreReads, request.databaseAverageMs], [1, 1, 3, 12]);
});

test("key cardinality is bounded and a disabled collector records nothing", () => {
    const stats = new BaselineStats();
    for (let i = 0; i < 400; i += 1) {
        stats.recordOperation({ source: "rtdb", kind: "read", resource: `r${i}`, scope: "item" }, 1, false);
    }
    assert.ok(stats.snapshot().operations.length <= 301);
    assert.ok(stats.snapshot().overflowedKeys > 0);
    const off = new BaselineStats({ enabled: false });
    off.recordOperation({ source: "rtdb", kind: "read", resource: "tools", scope: "item" }, 1, false);
    assert.equal(off.snapshot().operations.length, 0);
});

test("admin database operations report kind and collection but never identifiers or values", async () => {
    class Ref {
        constructor(url) { this.url = url; }
        toString() { return this.url; }
        async get() { return {}; }
        async set() {}
        async once() {}
    }
    const calls = [];
    const database = { ref: () => new Ref("https://x.firebaseio.com/instrumentation") };
    instrumentAdminDatabase(database);
    setDatabaseRecorder((durationMs, failed, meta) => calls.push({ failed, meta, durationMs }));
    try {
        await new Ref("https://x.firebaseio.com/tools/-Nsecret123?orderBy=x").get();
        await new Ref("https://x.firebaseio.com/workshopStorage/materials").get();
        await new Ref("https://x.firebaseio.com/authUsers/uid-1").set({ password: "x" });
    } finally {
        setDatabaseRecorder(null);
    }
    assert.deepEqual(calls.map((call) => call.meta), [
        { source: "rtdb", kind: "read", resource: "tools", scope: "item" },
        { source: "rtdb", kind: "read", resource: "workshopStorage/materials", scope: "collection" },
        { source: "rtdb", kind: "write", resource: "authUsers", scope: "item" }
    ]);
    assert.doesNotMatch(JSON.stringify(calls), /Nsecret|uid-1|password/);
});

test("firestore reads count returned documents, writes count documents and failures count none", async () => {
    class DocumentReference {
        constructor() { this.parent = { id: "auditEvents" }; }
        async get() { return { exists: true }; }
        async create() { throw new Error("boom"); }
    }
    class Query {
        constructor() { this._queryOptions = { collectionId: "monitoringEvents" }; }
        async get() { return { size: 25 }; }
    }
    class WriteBatch { async commit() { return [{}, {}, {}]; } }
    instrumentFirestore({ DocumentReference, Query, WriteBatch });
    instrumentFirestore({ DocumentReference, Query, WriteBatch });
    const calls = [];
    setFirestoreRecorder((durationMs, failed, meta) => calls.push({ failed, meta }));
    try {
        await new Query().get();
        await new DocumentReference().get();
        await new WriteBatch().commit();
        await assert.rejects(new DocumentReference().create());
    } finally {
        setFirestoreRecorder(null);
    }
    assert.deepEqual(calls.map((call) => [call.meta.kind, call.meta.resource, call.meta.units, call.failed]), [
        ["read", "monitoringEvents", 25, false],
        ["read", "auditEvents", 1, false],
        ["write", "other", 3, false],
        ["write", "auditEvents", 0, true]
    ]);
});

test("middleware records every request, including successful ones, with its database cost", async () => {
    const stats = new BaselineStats();
    const manager = { enabled: true, baseline: stats, recordHttpMetric() {}, recordHttpFailure() {} };
    const middleware = createTelemetryMiddleware(manager);
    const listeners = {};
    const req = { originalUrl: "/api/tools?x=1", method: "GET", get: () => undefined, route: { path: "/" } };
    const res = { statusCode: 200, setHeader() {}, once: (event, fn) => { listeners[event] = fn; } };
    await new Promise((resolve) => middleware(req, res, () => {
        stats.recordOperation({ source: "rtdb", kind: "read", resource: "tools", scope: "collection" }, 3, false);
        listeners.finish();
        resolve();
    }));
    const [request] = stats.snapshot().requests;
    assert.deepEqual([request.method, request.route, request.count, request.rtdbReads], ["GET", "/api/tools", 1, 1]);
});
