const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { TelemetryManager } = require("../../src/telemetry/telemetry");
const { createTelemetryMiddleware } = require("../../src/middleware/telemetryMiddleware");
const { storageReadTelemetry } = require("../../src/middleware/storageReadTelemetry");

test("storage reads are correlated without retaining search terms or resource identifiers", async () => {
    const manager = new TelemetryManager({ enabled: true, environment: "test" });
    const app = express();
    app.use(createTelemetryMiddleware(manager));
    app.use((req, _res, next) => { req.authUser = { id: "actor-id" }; next(); });
    app.get("/api/storage-boxes/search", storageReadTelemetry("storage.boxes.searched", manager),
        (_req, res) => res.status(200).end());
    app.get("/api/storage-boxes/:id", storageReadTelemetry("storage.box.viewed", manager),
        (_req, res) => res.status(404).end());
    const server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    try {
        const response = await fetch(`${url}/api/storage-boxes/search?q=private-search`);
        assert.equal(response.status, 200);
        assert.equal(manager.queue.items.length, 1);
        const event = manager.queue.items[0];
        assert.equal(event.eventName, "storage.boxes.searched");
        assert.equal(event.actorId, "actor-id");
        assert.equal(event.traceId, response.headers.get("x-trace-id"));
        assert.equal(event.requestId, response.headers.get("x-request-id"));
        assert.equal(event.http.route, "/api/storage-boxes/search");
        assert.equal(event.level, "INFO");
        assert.ok(event.durationMs >= 0);
        await fetch(`${url}/api/storage-boxes/private-box`);
        assert.equal(manager.queue.items[1].level, "WARN");
        assert.equal(manager.queue.items[1].http.route, "/api/storage-boxes/:id");
        assert.doesNotMatch(JSON.stringify(manager.queue.items), /private-search|private-box/);
        await fetch(`${url}/api/storage-boxes/search`, { method: "HEAD" });
        assert.equal(manager.queue.items.length, 2);
    } finally {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
});

test("storage events reject unrecognized names and disable collection when telemetry is off", () => {
    const manager = new TelemetryManager({ enabled: true });
    assert.throws(() => manager.recordStorageRead({ eventName: "untrusted" }), /no válido/);
    manager.enabled = false;
    manager.recordStorageRead({ eventName: "untrusted" });
    assert.equal(manager.queue.items.length, 0);
});
