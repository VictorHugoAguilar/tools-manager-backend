const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const express = require("express");
const { TelemetryManager } = require("../../src/telemetry/telemetry");
const { taskOperationTelemetry } = require("../../src/middleware/taskOperationTelemetry");
const { isTaskOperation } = require("../../src/telemetry/taskOperations");
const { taskBoardRouter } = require("../../src/routes/taskBoardRoutes");
const { todoListRouter } = require("../../src/routes/todoListRoutes");

test("the telemetry catalog covers every task route and method", () => {
    for (const [module, router] of [["board", taskBoardRouter], ["todo", todoListRouter]]) {
        for (const layer of router.stack) {
            if (!layer.route) continue;
            for (const method of Object.keys(layer.route.methods)) {
                assert.ok(isTaskOperation(module, layer.route.path, method.toUpperCase()),
                    `Missing ${module} ${method} ${layer.route.path}`);
            }
        }
    }
});

test("task telemetry records only catalogued normalized routes without request data", async () => {
    const manager = new TelemetryManager({ enabled: true, environment: "test", instanceId: "instance" });
    const traceId = randomUUID();
    const requestId = randomUUID();
    const app = express();
    app.use((req, res, next) => {
        req.authUser = { id: "actor" };
        res.set("x-trace-id", traceId);
        res.set("x-request-id", requestId);
        next();
    });
    const router = express.Router();
    router.use(taskOperationTelemetry("todo", manager));
    router.patch("/items/:id/move", (_req, res) => res.sendStatus(403));
    router.put("/:id", (_req, res) => res.sendStatus(204));
    router.get("/not-catalogued/:id", (_req, res) => res.sendStatus(200));
    app.use("/api/todo-list", router);
    const server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    const base = `http://127.0.0.1:${server.address().port}/api/todo-list`;
    try {
        await fetch(`${base}/items/private-id/move?search=secret`, { method: "PATCH" });
        await fetch(`${base}/private-project`, { method: "PUT" });
        await fetch(`${base}/not-catalogued/private-id`);
        assert.equal(manager.queue.items.length, 2);
        const [item, alias] = manager.queue.items;
        assert.deepEqual(item.http, { method: "PATCH", route: "/api/todo-list/items/:id/move", statusCode: 403 });
        assert.equal(item.level, "WARN");
        assert.equal(item.traceId, traceId);
        assert.equal(alias.http.route, "/api/todo-list/:id");
        assert.doesNotMatch(JSON.stringify(manager.queue.items), /private-id|private-project|secret/);
        assert.throws(() => manager.recordTaskOperation({
            module: "todo", route: "/items/private-id", method: "GET", actorId: "actor",
            traceId, requestId, durationMs: 1, statusCode: 200
        }));
    } finally { await new Promise((resolve) => server.close(resolve)); }
});
