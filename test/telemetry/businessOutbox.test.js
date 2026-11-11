const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { loadModuleWithMocks } = require("../helpers/loadModuleWithMocks");
const { transactTool, MAX_ROOT_BYTES } = require("../../src/audit/businessOutbox");
const { AuditOutboxWorker } = require("../../src/audit/outboxWorker");

function database(initial = {}) {
    let data = structuredClone(initial);
    let failRoot = false;
    let failDelete = false;
    return {
        get data() { return data; },
        failRoot(value) { failRoot = value; },
        failDelete(value) { failDelete = value; },
        ref(pathname) {
            if (!pathname) return { transaction: async (change) => {
                if (failRoot) throw new Error("RTDB unavailable");
                const next = change(structuredClone(data));
                if (next === undefined) return { committed: false };
                data = next;
                return { committed: true };
            } };
            assert.equal(pathname, "auditOutbox");
            return {
                orderByKey() { return this; },
                limitToFirst() { return this; },
                async get() { return { forEach: (callback) => {
                    for (const [key, value] of Object.entries(structuredClone(data.auditOutbox || {}))) {
                        callback({ key, val: () => value });
                    }
                } }; },
                child(id) { return { transaction: async (change) => {
                    if (failDelete) throw new Error("RTDB delete unavailable");
                    const next = change(structuredClone(data.auditOutbox?.[id] || null));
                    if (next === undefined) return { committed: false };
                    if (next === null) delete data.auditOutbox[id];
                    else data.auditOutbox[id] = next;
                    return { committed: true };
                } }; }
            };
        }
    };
}

function firestore() {
    const records = new Map();
    let fail = false;
    return {
        records,
        fail(value) { fail = value; },
        collection(name) {
            assert.equal(name, "auditEvents");
            return { doc: (id) => ({
                async create(value) {
                    if (fail) throw new Error("Firestore unavailable");
                    if (records.has(id)) throw Object.assign(new Error("exists"), { code: 6 });
                    records.set(id, structuredClone(value));
                },
                async get() { return { exists: records.has(id), data: () => records.get(id) }; }
            }) };
        }
    };
}

test("tool operations commit business data and sanitized audit events together", async () => {
    const db = database({ tools: {}, unrelated: { keep: true } });
    const service = loadModuleWithMocks(path.resolve(__dirname, "../../src/services/toolService.js"), {
        "firebase/database": { ref: () => ({}), push: () => ({ key: "tool-1" }) },
        "../config/database": { getDatabaseInstance: () => ({}) },
        "../audit/businessOutbox": {
            isToolAuditEnabled: () => true,
            transactTool: (input) => transactTool({ ...input, database: db })
        },
        "./toolImageStorageService": { deleteImageByUrl: async () => true }
    });
    const created = await service.create({ name: "private-name", urlSrc: "" }, "actor");
    assert.equal(created.id, "tool-1");
    await service.updateState("tool-1", "Prestada", "actor");
    await service.updateImageUrl("tool-1", "private-url", "actor");
    await service.update("tool-1", { name: "new-name", urlSrc: "" }, "actor");
    assert.equal(await service.remove("tool-1", "actor"), true);
    assert.equal(db.data.tools["tool-1"], undefined);
    assert.deepEqual(db.data.unrelated, { keep: true });
    const events = Object.values(db.data.auditOutbox);
    assert.deepEqual(events.map((event) => event.action), [
        "tool.created", "tool.state.updated", "tool.image.updated", "tool.updated", "tool.deleted"
    ]);
    assert.ok(events.every((event) => event.actorId === "actor" && event.targetId === "tool-1"));
    assert.doesNotMatch(JSON.stringify(events), /private-name|new-name|private-url/);
    assert.equal(await service.updateState("missing", "X", "actor"), null);
    assert.equal(Object.keys(db.data.auditOutbox).length, 5);
    await assert.rejects(service.create({ name: "x" }), /no válidos/);
});

test("failed root transaction and size limit do not commit a business change", async () => {
    const db = database({ tools: { t: { name: "before" } } });
    const options = {
        database: db, id: "t", actorId: "actor", action: "tool.updated",
        change: () => ({ value: { name: "after" }, result: true })
    };
    db.failRoot(true);
    await assert.rejects(transactTool(options), /RTDB unavailable/);
    assert.equal(db.data.tools.t.name, "before");
    assert.equal(db.data.auditOutbox, undefined);
    const large = database({ tools: { t: { name: "before" } }, data: "x".repeat(MAX_ROOT_BYTES) });
    await assert.rejects(transactTool({ ...options, database: large }), { statusCode: 503 });
    assert.equal(large.data.tools.t.name, "before");
    assert.equal(large.data.auditOutbox, undefined);
});

test("root transaction retries preserve concurrent changes and a single audit id", async () => {
    let firstEventId;
    let committed;
    const db = { ref: () => ({ transaction: async (change) => {
        const first = change({ tools: { t: { state: "old" } }, unrelated: { count: 1 } });
        firstEventId = Object.keys(first.auditOutbox)[0];
        const second = change({ tools: { t: { state: "concurrent", extra: true } }, unrelated: { count: 2 } });
        committed = second;
        return { committed: true };
    } }) };
    const result = await transactTool({
        database: db, id: "t", actorId: "actor", action: "tool.state.updated",
        change: (current) => {
            const updated = { ...current, state: "new" };
            return { value: updated, result: updated };
        }
    });
    assert.deepEqual(result, { state: "new", extra: true });
    assert.equal(committed.unrelated.count, 2);
    assert.deepEqual(Object.keys(committed.auditOutbox), [firstEventId]);
});

test("root transaction handles an initially uncached null without losing a later value", async () => {
    let committed;
    const db = { ref: () => ({ transaction: async (change) => {
        assert.equal(change(null), null);
        committed = change({ tools: { t: { state: "old" } } });
        return { committed: true };
    } }) };
    const result = await transactTool({
        database: db, id: "t", actorId: "actor", action: "tool.state.updated",
        change: (current) => ({ value: { ...current, state: "new" }, result: true })
    });
    assert.equal(result, true);
    assert.equal(committed.tools.t.state, "new");
    assert.equal(Object.keys(committed.auditOutbox).length, 1);
});

test("outbox recovers after Firestore or acknowledgement failures without duplicates", async () => {
    const db = database({ tools: { t: { name: "old" } } });
    await transactTool({
        database: db, id: "t", actorId: "actor", action: "tool.updated",
        change: () => ({ value: { name: "new" }, result: true })
    });
    const cloud = firestore();
    const worker = new AuditOutboxWorker({ getRealtimeDatabase: () => db, getFirestoreDatabase: () => cloud });
    cloud.fail(true);
    await assert.rejects(worker.flush(), /Firestore unavailable/);
    assert.equal(Object.keys(db.data.auditOutbox).length, 1);
    assert.equal(db.data.tools.t.name, "new");
    cloud.fail(false);
    db.failDelete(true);
    await assert.rejects(worker.flush(), /RTDB delete unavailable/);
    assert.equal(cloud.records.size, 1);
    assert.equal(Object.keys(db.data.auditOutbox).length, 1);
    db.failDelete(false);
    await worker.flush();
    assert.equal(cloud.records.size, 1);
    assert.equal(Object.keys(db.data.auditOutbox).length, 0);
});

test("outbox retains conflicting existing Firestore records instead of discarding audit", async () => {
    const db = database({ tools: { t: {} } });
    await transactTool({
        database: db, id: "t", actorId: "actor", action: "tool.deleted",
        change: (current) => ({ value: null, result: current })
    });

    const cloud = firestore();
    const id = Object.keys(db.data.auditOutbox)[0];
    cloud.records.set(id, { action: "unexpected" });
    const worker = new AuditOutboxWorker({ getRealtimeDatabase: () => db, getFirestoreDatabase: () => cloud });
    await assert.rejects(worker.flush(), /Conflicto/);
    assert.ok(db.data.auditOutbox[id]);
});

test("outbox acknowledgement retries an initially uncached null before deleting", async () => {
    const event = {
        schemaVersion: 1, eventId: "event", action: "tool.deleted", actorId: "actor",
        targetId: "tool", occurredAt: "2026-01-01T00:00:00.000Z"
    };
    let deleted = false;
    const db = { ref: () => ({
        orderByKey() { return this; },
        limitToFirst() { return this; },
        async get() { return { forEach: (callback) => callback({ key: "event", val: () => event }) }; },
        child: () => ({ transaction: async (change) => {
            assert.equal(change(null), null);
            assert.equal(change(event), null);
            deleted = true;
            return { committed: true };
        } })
    }) };
    const cloud = firestore();
    const worker = new AuditOutboxWorker({ getRealtimeDatabase: () => db, getFirestoreDatabase: () => cloud });
    await worker.flush();
    assert.equal(deleted, true);
    assert.equal(cloud.records.size, 1);
});
