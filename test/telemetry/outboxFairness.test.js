const test = require("node:test");
const assert = require("node:assert/strict");
const { AuditOutboxWorker, BATCH_SIZE } = require("../../src/audit/outboxWorker");

function harness(initial) {
    const pending = new Map(Object.entries(structuredClone(initial)));
    const written = new Map();
    let firestoreDown = false;
    const outbox = {
        orderByKey() {
            let after = null;
            let limit = 0;
            const query = {
                startAfter(value) { after = value; return this; },
                limitToFirst(value) { limit = value; return this; },
                async get() {
                    const entries = [...pending.entries()].sort(([a], [b]) => a.localeCompare(b))
                        .filter(([key]) => after === null || key > after).slice(0, limit);
                    return { forEach(callback) {
                        for (const [key, value] of entries) callback({ key, val: () => structuredClone(value) });
                    } };
                }
            };
            return query;
        },
        child(id) { return { async transaction(change) {
            const value = change(structuredClone(pending.get(id) ?? null));
            if (value === undefined) return { committed: false };
            if (value === null) pending.delete(id);
            return { committed: true };
        } }; }
    };
    const worker = new AuditOutboxWorker({
        getRealtimeDatabase: () => ({ ref: () => outbox }),
        getFirestoreDatabase: () => ({ collection: () => ({ doc: (id) => ({
            async create(value) {
                if (firestoreDown) throw new Error("Firestore unavailable");
                if (written.has(id)) throw Object.assign(new Error("exists"), { code: 6 });
                written.set(id, structuredClone(value));
            },
            async get() { return { exists: written.has(id), data: () => written.get(id) }; }
        }) }) })
    });
    return { worker, pending, written, fail(value) { firestoreDown = value; } };
}

function event(id) {
    return { schemaVersion: 1, eventId: id, action: "tool.updated", actorId: "actor",
        targetId: "tool", occurredAt: "2026-01-01T00:00:00.000Z" };
}

test("damaged and conflicting entries do not starve valid records beyond the batch", async () => {
    const initial = {};
    for (let i = 0; i < BATCH_SIZE + 5; i++) {
        const id = `key${String(i).padStart(3, "0")}`;
        initial[id] = event(id);
    }
    initial.key000 = { invalid: true };
    const h = harness(initial);
    h.written.set("key001", { different: true });
    await assert.rejects(h.worker.flush(), AggregateError);
    assert.equal(h.pending.has("key000"), true);
    assert.equal(h.pending.has("key001"), true);
    assert.equal(h.pending.has("key002"), false);
    assert.equal(h.pending.has("key050"), true);
    await h.worker.flush();
    assert.equal(h.pending.has("key050"), false);
    assert.equal(h.pending.size, 2);
    await assert.rejects(h.worker.flush(), AggregateError);
    h.pending.set("key000", event("key000"));
    h.written.delete("key001");
    await h.worker.flush();
    assert.equal(h.pending.size, 0);
    assert.equal(h.written.size, BATCH_SIZE + 5);
});

test("transport failure aborts the scan and retries pending records without losing them", async () => {
    const h = harness({ key000: { invalid: true }, key001: event("key001"), key002: event("key002") });
    h.fail(true);
    await assert.rejects(h.worker.flush(), (error) =>
        error instanceof AggregateError && error.errors.length === 2 && /Firestore unavailable/.test(error.message));
    assert.equal(h.pending.size, 3);
    h.fail(false);
    await assert.rejects(h.worker.flush(), /no válido/);
    assert.equal(h.pending.size, 1);
    assert.equal(h.written.size, 2);
});
