const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { TelemetryManager, TelemetryQueue, FirestoreTelemetrySink } = require("../../src/telemetry/telemetry");

function frontendEvent(overrides = {}) {
    return {
        schemaVersion: 1,
        eventId: randomUUID(),
        occurredAt: "2026-01-01T10:00:00.000Z",
        eventName: "frontend.runtime.error",
        ...overrides
    };
}

test("frontend events are normalized and sensitive or malformed fields are rejected", () => {
    const manager = new TelemetryManager({ enabled: true, environment: "test", instanceId: "instance" });
    assert.equal(manager.enqueueFrontend(frontendEvent(), "user-1"), true);
    const event = manager.queue.items[0];
    assert.equal(event.actorId, "user-1");
    assert.equal(event.level, "ERROR");
    assert.equal(event.service, "frontend");
    assert.equal(event.environment, "test");
    assert.ok(Date.parse(event.receivedAt));
    for (const input of [
        frontendEvent({ eventName: "__proto__" }),
        frontendEvent({ eventName: "constructor" }),
        frontendEvent({ actorId: "another-user" }),
        frontendEvent({ attributes: { password: "secret" } }),
        frontendEvent({ durationMs: -1 }),
        frontendEvent({ occurredAt: "2026-02-30T10:00:00.000Z" })
    ]) assert.equal(manager.enqueueFrontend(input, "user-1"), false);
    assert.equal(manager.queue.items.length, 1);
});

test("bounded queue prioritizes errors and counts evictions and rejections", () => {
    const queue = new TelemetryQueue(2);
    queue.enqueue({ level: "INFO", name: "first" });
    queue.enqueue({ level: "WARN", name: "second" });
    assert.equal(queue.enqueue({ level: "ERROR", name: "third" }), true);
    assert.equal(queue.enqueue({ level: "INFO", name: "fourth" }), false);
    assert.deepEqual(queue.dropped, { DEBUG: 0, INFO: 2, WARN: 0, ERROR: 0 });
    assert.deepEqual(queue.drain(2).map((event) => event.name), ["third", "second"]);
});

test("worker retries with backoff and eventually counts failed events", async () => {
    let attempts = 0;
    const manager = new TelemetryManager({
        enabled: true, maxAttempts: 2, retryBaseDelayMs: 10000,
        sink: { async writeEvents() { attempts += 1; throw new Error("test failure"); } }
    });
    manager.enqueueFrontend(frontendEvent(), "user-1");
    const originalError = console.error;
    console.error = () => {};
    try {
        await manager.flush();
        await manager.flush();
        assert.equal(attempts, 1);
        assert.equal(manager.getHealth().queuePending, 1);
        manager.nextRetryAt = 0;
        await manager.flush();
        assert.equal(attempts, 2);
        assert.equal(manager.getHealth().failedEvents, 1);
        assert.equal(manager.getHealth().queuePending, 0);
    } finally {
        console.error = originalError;
    }
});

test("Firestore sink creates idempotent documents with timestamps and retention", async () => {
    const documents = [];
    const db = {
        collection(name) {
            assert.equal(name, "monitoringEvents");
            return { doc: (id) => ({ id }) };
        },
        bulkWriter() {
            return {
                onWriteError() {},
                create(ref, value) {
                    documents.push({ ref, value });
                    return Promise.resolve();
                },
                async close() {}
            };
        }
    };
    const manager = new TelemetryManager({ enabled: true });
    manager.enqueueFrontend(frontendEvent(), "user-1");
    await new FirestoreTelemetrySink(() => db).writeEvents(manager.queue.items);
    assert.equal(documents[0].ref.id, manager.queue.items[0].eventId);
    assert.equal(documents[0].value.expiresAt.toMillis() - documents[0].value.receivedAt.toMillis(), 30 * 86400000);
});

test("Firestore duplicate IDs are accepted and other write errors are reported", async () => {
    let code = 6;
    const db = {
        collection: () => ({ doc: (id) => ({ id }) }),
        bulkWriter: () => ({
            onWriteError() {},
            create: () => Promise.reject(Object.assign(new Error("write failed"), { code })),
            close: async () => {}
        })
    };
    const manager = new TelemetryManager({ enabled: true });
    manager.enqueueFrontend(frontendEvent(), "user-1");
    const sink = new FirestoreTelemetrySink(() => db);
    await sink.writeEvents(manager.queue.items);
    code = 14;
    await assert.rejects(sink.writeEvents(manager.queue.items), /write failed/);
});
