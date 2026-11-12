const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const sessions = require("../../src/services/authSessionService");
const original = sessions.resolveSession;
sessions.resolveSession = async (token) => token === "tracing"
    ? { profile: { id: "reader", permissions: ["tracing:app"] } }
    : token === "monitoring" ? { profile: { id: "reader", permissions: ["monitoring:app"] } } : null;
const { createTaskTracingRouter } = require("../../src/routes/taskTracingRoutes");
test.after(() => { sessions.resolveSession = original; });

test("task history requires tracing, audits access and filters actions for each module", async () => {
    const calls = [];
    let failAudit = false;
    let failIndex = false;
    const db = { collection: (name) => {
        assert.equal(name, "auditEvents");
        return {
            doc: () => ({ create: async (record) => {
                calls.push(["audit", record]);
                if (failAudit) throw new Error("audit failed");
            } }),
            where(field, op, value) {
                const filters = [[field, op, value]];
                return {
                    where(key, operator, data) { filters.push([key, operator, data]); return this; },
                    orderBy(key, order) { assert.deepEqual([key, order], ["occurredAt", "desc"]); return this; },
                    limit(value) { assert.equal(value, 25); return this; },
                    async get() {
                        calls.push(["query", filters]);
                        if (failIndex) throw Object.assign(new Error("query requires an index"), { code: 9 });
                        return { docs: [{ id: "event", data: () => ({
                            action: filters[1][2][0], actorId: "actor", targetId: "private-id",
                            occurredAt: "2026-01-01T00:00:00.000Z", private: "not returned"
                        }) }] };
                    }
                };
            }
        };
    } };
    const app = express();
    app.use("/api/tracing/tasks", createTaskTracingRouter({ getDatabase: () => db }));
    app.use((_error, _req, res, _next) => res.status(500).end());
    const server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    const base = `http://127.0.0.1:${server.address().port}/api/tracing/tasks`;
    const options = (token) => ({ headers: { cookie: `tm_session=${token}` } });
    try {
        assert.equal((await fetch(`${base}/todo/private-id/history`)).status, 401);
        assert.equal((await fetch(`${base}/todo/private-id/history`, options("monitoring"))).status, 403);
        assert.equal((await fetch(`${base}/other/private-id/history`, options("tracing"))).status, 400);
        assert.equal((await fetch(`${base}/todo/private-id/history?extra=1`, options("tracing"))).status, 400);
        assert.equal((await fetch(`${base}/todo/private%2Eid/history`, options("tracing"))).status, 400);
        assert.equal(calls.length, 0);
        for (const module of ["board", "todo"]) {
            calls.length = 0;
            const result = await fetch(`${base}/${module}/private-id/history`, options("tracing"));
            assert.equal(result.status, 200);
            assert.equal(result.headers.get("cache-control"), "no-store");
            const body = await result.json();
            assert.equal(body.limit, 25);
            assert.equal(body.events[0].private, undefined);
            assert.equal(calls[0][0], "audit");
            assert.equal(calls[0][1].actorId, "reader");
            assert.equal(calls[0][1].taskModule, module);
            assert.deepEqual(calls[1][1][0], ["targetId", "==", "private-id"]);
            const actions = calls[1][1][1][2];
            assert.ok(actions.every((action) => action.startsWith(module === "board" ? "task_board.task." : "todo.item.")));
            assert.ok(!actions.some((action) => /comment|attachment|child|reminder/.test(action)));
        }
        calls.length = 0;
        failAudit = true;
        assert.equal((await fetch(`${base}/todo/private-id/history`, options("tracing"))).status, 500);
        assert.deepEqual(calls.map((call) => call[0]), ["audit"]);
        failAudit = false;
        failIndex = true;
        assert.equal((await fetch(`${base}/todo/private-id/history`, options("tracing"))).status, 503);
    } finally { await new Promise((resolve) => server.close(resolve)); }
});
