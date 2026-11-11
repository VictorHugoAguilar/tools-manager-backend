const test = require("node:test");
const assert = require("node:assert/strict");
const { TelemetryManager } = require("../../src/telemetry/telemetry");
const { createCollaborationTelemetry } = require("../../src/collaboration/collaborationTelemetry");

test("WebSocket lifecycle events correlate without capturing connection data", () => {
    const manager = new TelemetryManager({ enabled: true, service: "websocket", environment: "test", instanceId: "instance" });
    const recorder = createCollaborationTelemetry(manager);
    let close;
    recorder.connected({ onClose(callback) { close = callback; } });
    recorder.authenticationFailed();
    recorder.documentLoadFailed();
    recorder.documentStoreFailed();
    recorder.updateReceived();
    assert.deepEqual(recorder.getStats(), {
        activeConnections: 1, openedConnections: 1, closedConnections: 0, receivedUpdates: 1
    });
    close({ userId: "private-user", document: "private-content" });
    close();
    assert.deepEqual(recorder.getStats(), {
        activeConnections: 0, openedConnections: 1, closedConnections: 1, receivedUpdates: 1
    });
    const events = manager.queue.items;
    assert.deepEqual(events.map((event) => event.eventName), [
        "websocket.connection.opened", "websocket.authentication.failed",
        "websocket.document.load.failed", "websocket.document.store.failed",
        "websocket.connection.closed"
    ]);
    assert.equal(events[0].connectionId, events[4].connectionId);
    assert.match(events[0].connectionId, /^[0-9a-f-]{36}$/);
    assert.equal(events[0].service, "websocket");
    assert.equal(events[1].level, "WARN");
    assert.equal(events[2].level, "ERROR");
    const bucket = [...manager.webSocketMetrics.buckets.values()][0];
    assert.deepEqual({ opened: bucket.opened, closed: bucket.closed, updates: bucket.updates }, {
        opened: 1, closed: 1, updates: 1
    });
    assert.doesNotMatch(JSON.stringify(events), /private-user|private-content/);
});

test("disabled or failing instrumentation never breaks collaboration", () => {
    const disabled = createCollaborationTelemetry({ enabled: false });
    assert.doesNotThrow(() => disabled.connected({ onClose: assert.fail }));
    disabled.updateReceived();
    assert.equal(disabled.getStats().receivedUpdates, 0);
    const failing = createCollaborationTelemetry({
        enabled: true,
        recordWebSocketEvent() { throw new Error("test"); }
    });
    const previousError = console.error;
    console.error = () => {};
    try {
        assert.doesNotThrow(() => failing.authenticationFailed());
        assert.doesNotThrow(() => failing.connected({ onClose() { throw new Error("test"); } }));
    } finally {
        console.error = previousError;
    }
});
