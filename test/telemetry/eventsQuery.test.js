const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { Timestamp } = require("firebase-admin/firestore");
const { parseEventFilters, findEvents } = require("../../src/telemetry/eventsQuery");

const now = Date.parse("2026-01-02T00:00:00.000Z");
const request = { from: "2026-01-01T00:00:00.000Z", to: "2026-01-02T00:00:00.000Z" };
function doc(id = randomUUID(), overrides = {}) {
    return {
        id, exists: true,
        data: () => ({
            receivedAt: Timestamp.fromMillis(now - 1000), environment: "test",
            service: "backend", level: "ERROR", eventName: "http.request.failed",
            actorId: "private", ...overrides
        })
    };
}
function database(docs, calls, cursor) {
    const query = {
        where(...args) { calls.push(["where", ...args]); return this; },
        orderBy(...args) { calls.push(["orderBy", ...args]); return this; },
        startAfter(value) { calls.push(["startAfter", value]); return this; },
        limit(value) { calls.push(["limit", value]); return this; },
        async get() { return { docs }; },
        doc(id) { return { get: async () => cursor || { exists: false, id } }; }
    };
    return { collection: () => query };
}

test("event filters reject invalid ranges, types, cursors and arbitrary fields", () => {
    for (const bad of [
        { ...request, from: "2025-01-01T00:00:00.000Z" },
        { ...request, to: "2027-01-01T00:00:00.000Z" },
        { ...request, service: "unknown" }, { ...request, level: ["ERROR"] },
        { ...request, traceId: "invalid" }, { ...request, cursor: "invalid" },
        { ...request, eventName: "../private" }, { ...request, actorId: "other" }
    ]) assert.throws(() => parseEventFilters(bad, now), { statusCode: 400 });
});

test("query constrains environment and filters, limits and paginates without exposing actor", async () => {
    const events = Array.from({ length: 26 }, () => doc());
    const calls = [];
    const filters = parseEventFilters({ ...request, service: "backend", level: "ERROR" }, now);
    const result = await findEvents(database(events, calls), filters, "test");
    assert.equal(result.events.length, 25);
    assert.equal(result.nextCursor, events[24].id);
    assert.equal(result.events[0].actorId, undefined);
    assert.ok(calls.some((call) => call[1] === "environment" && call[3] === "test"));
    assert.ok(calls.some((call) => call[1] === "service" && call[3] === "backend"));
    assert.deepEqual(calls.at(-1), ["limit", 26]);
    const nextCalls = [];
    const next = await findEvents(database([events[25]], nextCalls, events[24]), { ...filters, cursor: events[24].id }, "test");
    assert.equal(next.events.length, 1);
    assert.equal(next.nextCursor, null);
    assert.ok(nextCalls.some((call) => call[0] === "startAfter"));
});

test("cursor must exist and match range, environment and active filters", async () => {
    const cursor = randomUUID();
    const filters = parseEventFilters({ ...request, cursor, level: "ERROR" }, now);
    for (const value of [undefined, doc(cursor, { environment: "production" }),
        doc(cursor, { level: "INFO" }), doc(cursor, { receivedAt: Timestamp.fromMillis(now - 90000000) })]) {
        await assert.rejects(findEvents(database([], [], value), filters, "test"), { statusCode: 400 });
    }
});
