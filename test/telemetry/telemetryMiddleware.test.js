const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { randomUUID } = require("node:crypto");
const { createTelemetryMiddleware } = require("../../src/middleware/telemetryMiddleware");
const { TelemetryManager } = require("../../src/telemetry/telemetry");

test("HTTP instrumentation correlates server failures without logging identifiers or queries", async () => {
    const manager = new TelemetryManager({ enabled: true, environment: "test" });
    const app = express();
    app.use(createTelemetryMiddleware(manager));
    const router = express.Router();
    router.get("/:id", (_req, res) => res.status(500).send("failure"));
    router.get("/", (_req, res) => res.send("ok"));
    app.use("/api/tools", router);
    app.get("/api/telemetry/events", (_req, res) => res.status(500).send("failure"));
    const server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    try {
        const traceId = randomUUID();
        const response = await fetch(`${url}/api/tools/private-id?search=secret`, {
            headers: { "x-trace-id": traceId }
        });
        assert.equal(response.status, 500);
        assert.equal(response.headers.get("x-trace-id"), traceId);
        assert.ok(response.headers.get("x-request-id"));
        assert.equal(manager.queue.items.length, 1);
        const event = manager.queue.items[0];
        assert.equal(event.traceId, traceId);
        assert.equal(event.requestId, response.headers.get("x-request-id"));
        assert.deepEqual(event.http, { method: "GET", route: "/api/tools/:id", statusCode: 500 });
        assert.ok(event.durationMs >= 0);
        assert.doesNotMatch(JSON.stringify(event), /private-id|secret/);
        await fetch(`${url}/api/tools`);
        await fetch(`${url}/api/telemetry/events`);
        assert.equal(manager.queue.items.length, 1);
        const bucket = [...manager.httpMetrics.buckets.values()][0];
        assert.equal(bucket.count, 2);
        assert.equal(bucket.errors, 1);
        const invalid = await fetch(`${url}/api/tools/other`, { headers: { "x-trace-id": "sensitive" } });
        assert.notEqual(invalid.headers.get("x-trace-id"), "sensitive");
        assert.doesNotMatch(JSON.stringify(manager.queue.items), /sensitive/);
    } finally {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
});

test("disabled HTTP instrumentation leaves responses and queue unchanged", async () => {
    const manager = new TelemetryManager({ enabled: false });
    const app = express();
    app.use(createTelemetryMiddleware(manager));
    app.get("/api/tools/:id", (_req, res) => res.status(500).end());
    const server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    try {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/api/tools/one`);
        assert.equal(response.status, 500);
        assert.equal(response.headers.get("x-trace-id"), null);
        assert.equal(manager.queue.items.length, 0);
    } finally {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
});
