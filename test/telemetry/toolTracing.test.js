const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const sessions = require("../../src/services/authSessionService");
const original = sessions.resolveSession;
sessions.resolveSession = async (token) => token === "tracing"
    ? { profile: { id: "reader", permissions: ["tracing:app"] } }
    : token === "monitoring" ? { profile: { id: "reader", permissions: ["monitoring:app"] } } : null;
const { createToolTracingRouter } = require("../../src/routes/toolTracingRoutes");
test.after(() => { sessions.resolveSession = original; });

test("tool history requires tracing permission and audits access before both scoped queries", async () => {
    const calls = [];
    let failAudit = false;
    const db = { collection: () => ({
        doc: () => ({ create: async (record) => {
            calls.push(["audit", record]);
            if (failAudit) throw new Error("audit failed");
        } }),
        where(field, op, value) {
            const filters = [[field, op, value]];
            return {
                where(key, operator, data) { filters.push([key, operator, data]); return this; },
                orderBy() { return this; },
                limit(value) { assert.equal(value, 25); return this; },
                async get() {
                    calls.push(["query", filters]);
                    const repair = filters[0][0] === "toolId";
                    return { docs: [{ id: repair ? "repair" : "tool", data: () => ({
                        action: repair ? "repair.created" : "tool.created",
                        actorId: "actor", targetId: repair ? "repair-id" : "tool-id",
                        occurredAt: repair ? "2026-01-02T00:00:00.000Z" : "2026-01-01T00:00:00.000Z",
                        private: "not returned"
                    }) }] };
                }
            };
        }
    }) };
    const app = express();
    app.use("/api/tracing/tools", createToolTracingRouter({ getDatabase: () => db }));
    app.use((_error, _req, res, _next) => res.status(500).end());
    const server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    const url = `http://127.0.0.1:${server.address().port}/api/tracing/tools/tool-id/history`;
    const options = (token) => ({ headers: { cookie: `tm_session=${token}` } });
    try {
        assert.equal((await fetch(url)).status, 401);
        assert.equal((await fetch(url, options("monitoring"))).status, 403);
        assert.equal((await fetch(`${url}?bad=1`, options("tracing"))).status, 400);
        assert.equal(calls.length, 0);
        const result = await fetch(url, options("tracing"));
        assert.equal(result.status, 200);
        assert.equal(result.headers.get("cache-control"), "no-store");
        const body = await result.json();
        assert.deepEqual(body.events.map((event) => event.eventId), ["repair", "tool"]);
        assert.equal(body.events[0].private, undefined);
        assert.equal(calls[0][0], "audit");
        assert.equal(calls[0][1].actorId, "reader");
        assert.deepEqual(calls.slice(1).map((call) => call[1][0]), [
            ["targetId", "==", "tool-id"], ["toolId", "==", "tool-id"]
        ]);
        calls.length = 0;
        failAudit = true;
        assert.equal((await fetch(url, options("tracing"))).status, 500);
        assert.deepEqual(calls.map((call) => call[0]), ["audit"]);
    } finally { await new Promise((resolve) => server.close(resolve)); }
});
