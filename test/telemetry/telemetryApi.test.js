const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const sessions = require("../../src/services/authSessionService");
const originalResolveSession = sessions.resolveSession;
sessions.resolveSession = async (token) => {
    if (token === "valid") return { profile: { id: "real-user", permissions: ["app:access"] } };
    if (token === "no-permission") return { profile: { id: "restricted", permissions: [] } };
    if (token === "limited") return { profile: { id: "limited-user", permissions: ["app:access"] } };
    return null;
};
const { createApp } = require("../../src/app");
const { telemetry } = require("../../src/telemetry/telemetry");

test.after(() => { sessions.resolveSession = originalResolveSession; });

test("ingestion requires session, permission, CSRF, bounded input and a valid batch", async () => {
    const previousEnabled = telemetry.enabled;
    telemetry.enabled = true;
    const server = createApp().listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    const url = `http://127.0.0.1:${server.address().port}/api/telemetry/events`;
    const event = {
        schemaVersion: 1,
        eventId: randomUUID(),
        occurredAt: new Date().toISOString(),
        eventName: "frontend.runtime.error"
    };
    const body = JSON.stringify({ schemaVersion: 1, events: [event] });
    const headers = {
        "content-type": "application/json",
        cookie: "tm_session=valid; tm_csrf=csrf",
        "x-csrf-token": "csrf"
    };
    try {
        let response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body });
        assert.equal(response.status, 401);
        response = await fetch(url, { method: "POST", headers: { ...headers, cookie: "tm_session=no-permission; tm_csrf=csrf" }, body });
        assert.equal(response.status, 403);
        response = await fetch(url, { method: "POST", headers: { ...headers, "x-csrf-token": "wrong" }, body });
        assert.equal(response.status, 403);
        response = await fetch(url, { method: "POST", headers, body });
        assert.equal(response.status, 202);
        assert.deepEqual(await response.json(), { accepted: 1, rejected: 0 });
        assert.equal(telemetry.queue.items.at(-1).actorId, "real-user");
        response = await fetch(url, {
            method: "POST", headers,
            body: JSON.stringify({ schemaVersion: 1, events: [{ ...event, actorId: "forged" }] })
        });
        assert.deepEqual(await response.json(), { accepted: 0, rejected: 1 });
        response = await fetch(url, {
            method: "POST", headers,
            body: JSON.stringify({ schemaVersion: 1, events: Array(51).fill(event) })
        });
        assert.equal(response.status, 400);
        response = await fetch(url, {
            method: "POST", headers,
            body: JSON.stringify({ schemaVersion: 1, events: [], padding: "a".repeat(65536) })
        });
        assert.equal(response.status, 413);
        telemetry.enabled = false;
        response = await fetch(url, { method: "POST", headers, body });
        assert.equal(response.status, 503);
        telemetry.enabled = true;
        const limitedHeaders = { ...headers, cookie: "tm_session=limited; tm_csrf=csrf" };
        for (let i = 0; i < 30; i += 1) {
            response = await fetch(url, { method: "POST", headers: limitedHeaders, body });
            assert.equal(response.status, 202);
        }
        response = await fetch(url, { method: "POST", headers: limitedHeaders, body });
        assert.equal(response.status, 429);
    } finally {
        telemetry.enabled = previousEnabled;
        telemetry.queue.items.length = 0;
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
});
