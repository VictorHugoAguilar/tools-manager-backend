const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { TelemetryManager, normalizeFrontendEvent } = require("../../src/telemetry/telemetry");
const { toolOperationTelemetry } = require("../../src/middleware/toolOperationTelemetry");
const { EventEmitter } = require("node:events");

test("tool operation telemetry uses a closed catalog and contains no tool content", () => {
    const manager = new TelemetryManager({ enabled: true, environment: "test", instanceId: "instance" });
    const names = ["tools.create.completed", "tools.update.completed", "tools.state.completed",
        "tools.image.upload.completed", "tools.image.delete.completed", "tools.delete.completed",
        "tools.repair.create.completed", "tools.repair.update.completed", "tools.repair.delete.completed"];
    const args = { actorId: "actor", traceId: randomUUID(), requestId: randomUUID(), durationMs: 42, statusCode: 403 };
    for (const eventName of names) manager.recordToolOperation({ ...args, eventName });
    assert.equal(manager.queue.items.length, names.length);
    for (const event of manager.queue.items) {
        assert.equal(event.level, "WARN");
        assert.equal(event.http.statusCode, 403);
        assert.equal(event.category, "tools");
        assert.ok(!JSON.stringify(event).includes("repair-id"));
        assert.ok(!Object.hasOwn(event, "targetId"));
    }
    assert.throws(() => manager.recordToolOperation({ ...args, eventName: "tools.unknown" }));
    assert.throws(() => manager.recordToolOperation({ ...args, eventName: names[0], durationMs: NaN }));
});

test("frontend search events accept no search text or results", () => {
    const input = {
        schemaVersion: 1, eventId: randomUUID(), occurredAt: new Date().toISOString(),
        eventName: "frontend.tools.search.completed"
    };
    const context = { environment: "test", actorId: "actor", instanceId: "instance" };
    assert.equal(normalizeFrontendEvent(input, context).category, "tools");
    assert.equal(normalizeFrontendEvent({ ...input, query: "private" }, context), null);
});

test("operation middleware forwards server correlation and status on completion without changing responses", () => {
    let captured;
    const traceId = randomUUID();
    const requestId = randomUUID();
    const manager = { enabled: true, recordToolOperation: (event) => { captured = event; } };
    const response = new EventEmitter();
    response.statusCode = 204;
    response.getHeader = (key) => key === "x-trace-id" ? traceId : requestId;
    let next = false;
    toolOperationTelemetry("tools.delete.completed", manager)(
        { authUser: { id: "actor" }, params: { id: "private-tool" } }, response, () => { next = true; }
    );
    assert.equal(next, true);
    response.emit("finish");
    assert.equal(captured.eventName, "tools.delete.completed");
    assert.equal(captured.traceId, traceId);
    assert.equal(captured.statusCode, 204);
    assert.equal(Object.hasOwn(captured, "params"), false);
});

test("frontend collaboration measurements accept only a duration and use a closed catalog", () => {
    const context = { environment: "test", actorId: "actor", instanceId: "instance" };
    const input = {
        schemaVersion: 1, eventId: randomUUID(), occurredAt: new Date().toISOString(), durationMs: 120
    };
    for (const eventName of ["frontend.collaboration.sync.completed", "frontend.collaboration.reconnected",
        "frontend.collaboration.persist.completed"]) {
        const event = normalizeFrontendEvent({ ...input, eventName, eventId: randomUUID() }, context);
        assert.equal(event.category, "collaboration");
        assert.equal(event.level, "INFO");
        assert.equal(event.durationMs, 120);
    }
    assert.equal(normalizeFrontendEvent({ ...input, eventName: "frontend.collaboration.sync.completed", roomName: "private" }, context), null);
    assert.equal(normalizeFrontendEvent({ ...input, eventName: "frontend.collaboration.unknown" }, context), null);
});
