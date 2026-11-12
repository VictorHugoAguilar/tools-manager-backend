const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const express = require("express");
const sessions = require("../../src/services/authSessionService");
const original = sessions.resolveSession;
sessions.resolveSession = async (token) => token === "tracing"
    ? { profile: { id: "reader", permissions: ["tracing:app"] } }
    : token === "monitoring" ? { profile: { id: "reader", permissions: ["monitoring:app"] } } : null;
const { TelemetryManager } = require("../../src/telemetry/telemetry");
const { workshopOperationTelemetry } = require("../../src/middleware/workshopOperationTelemetry");
const { isWorkshopOperation } = require("../../src/telemetry/workshopOperations");
const { workshopStorageRouter } = require("../../src/routes/workshopStorageRoutes");
const { createWorkshopTracingRouter } = require("../../src/routes/workshopTracingRoutes");
test.after(() => { sessions.resolveSession = original; });

test("the catalog covers every workshop write route and no read route", () => {
    for (const layer of workshopStorageRouter.stack) {
        if (!layer.route) continue;
        for (const method of Object.keys(layer.route.methods)) {
            assert.equal(isWorkshopOperation(layer.route.path, method.toUpperCase()), method !== "get",
                `${method} ${layer.route.path}`);
        }
    }
});

test("workshop telemetry records normalized routes without ids, queries or bodies", async () => {
    const manager = new TelemetryManager({ enabled: true, environment: "test", instanceId: "instance" });
    const app = express();
    app.use((req, res, next) => {
        req.authUser = { id: "actor" };
        res.set("x-trace-id", randomUUID());
        res.set("x-request-id", randomUUID());
        next();
    });
    const router = express.Router();
    router.use(workshopOperationTelemetry(manager));
    router.put("/materials/:id", (_req, res) => res.sendStatus(403));
    router.get("/materials/:id", (_req, res) => res.sendStatus(200));
    app.use("/api/workshop-storage", router);
    const server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    const base = `http://127.0.0.1:${server.address().port}/api/workshop-storage`;
    try {
        await fetch(`${base}/materials/private-id?secret=1`, { method: "PUT", body: "secret" });
        await fetch(`${base}/materials/private-id`);
        assert.equal(manager.queue.items.length, 1);
        const [item] = manager.queue.items;
        assert.equal(item.eventName, "workshop_storage.operation.completed");
        assert.equal(item.level, "WARN");
        assert.deepEqual(item.http, { method: "PUT", route: "/api/workshop-storage/materials/:id", statusCode: 403 });
        assert.doesNotMatch(JSON.stringify(item), /private-id|secret/);
    } finally { await new Promise((resolve) => server.close(resolve)); }
});

test("workshop history requires tracing, audits access and filters by target and workshop actions", async () => {
    const calls = [];
    const db = { collection: () => ({
        doc: () => ({ create: async (record) => { calls.push(["audit", record]); } }),
        where(field, op, value) {
            const filters = [[field, op, value]];
            return {
                where(key, operator, data) { filters.push([key, operator, data]); return this; },
                orderBy() { return this; },
                limit() { return this; },
                async get() {
                    calls.push(["query", filters]);
                    return { docs: [{ id: "e", data: () => ({
                        action: "workshop.materials.updated", actorId: "actor", targetId: "m1",
                        occurredAt: "2026-01-01T00:00:00.000Z", private: "hidden"
                    }) }] };
                }
            };
        }
    }) };
    const app = express();
    app.use("/api/tracing/workshop", createWorkshopTracingRouter({ getDatabase: () => db }));
    const server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    const base = `http://127.0.0.1:${server.address().port}/api/tracing/workshop`;
    const options = (token) => ({ headers: { cookie: `tm_session=${token}` } });
    try {
        assert.equal((await fetch(`${base}/m1/history`)).status, 401);
        assert.equal((await fetch(`${base}/m1/history`, options("monitoring"))).status, 403);
        assert.equal((await fetch(`${base}/m1/history?x=1`, options("tracing"))).status, 400);
        assert.equal((await fetch(`${base}/m%2E1/history`, options("tracing"))).status, 400);
        assert.equal(calls.length, 0);
        const result = await fetch(`${base}/m1/history`, options("tracing"));
        assert.equal(result.status, 200);
        const body = await result.json();
        assert.equal(body.events[0].private, undefined);
        assert.equal(calls[0][1].action, "tracing.workshop-history.accessed");
        assert.deepEqual(calls[1][1][0], ["targetId", "==", "m1"]);
        assert.ok(calls[1][1][1][2].every((action) => action.startsWith("workshop.")));
        assert.ok(calls[1][1][1][2].includes("workshop.materials.image.updated"));
    } finally { await new Promise((resolve) => server.close(resolve)); }
});
