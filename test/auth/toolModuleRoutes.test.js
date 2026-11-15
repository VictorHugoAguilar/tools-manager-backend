const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const express = require("express");
const { loadModuleWithMocks } = require("../helpers/loadModuleWithMocks");

test("tool and repair routes require their respective effective module permission", async (t) => {
    const previous = process.env.MODULE_PERMISSIONS_ENABLED;
    process.env.MODULE_PERMISSIONS_ENABLED = "true";
    t.after(() => {
        if (previous === undefined) delete process.env.MODULE_PERMISSIONS_ENABLED;
        else process.env.MODULE_PERMISSIONS_ENABLED = previous;
    });
    const handler = (_req, res) => res.status(204).end();
    const toolController = Object.fromEntries([
        "getAllTools", "getToolById", "createTool", "updateTool", "updateToolState",
        "uploadToolImage", "deleteToolImage", "deleteTool"
    ].map((name) => [name, handler]));
    const repairController = Object.fromEntries([
        "getToolRepairs", "getToolRepairById", "createToolRepair", "updateToolRepair", "deleteToolRepair"
    ].map((name) => [name, handler]));
    const { toolRouter } = loadModuleWithMocks(path.resolve(__dirname, "../../src/routes/toolRoutes.js"), {
        "../controllers/toolController": toolController,
        "../controllers/repairHistoryController": repairController,
        "../middleware/uploadMiddleware": { uploadToolImage: (_req, _res, next) => next() },
        "../middleware/toolOperationTelemetry": { toolOperationTelemetry: () => (_req, _res, next) => next() }
    });
    const app = express();
    app.use((req, _res, next) => {
        req.authUser = { permissions: String(req.get("x-permissions") || "").split(",") };
        next();
    }, toolRouter);
    const server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const [method, route, allowed, denied] of [
        ["GET", "/", "module:dashboard", "module:repairs"],
        ["GET", "/tool", "module:inventory", "module:categories"],
        ["POST", "/", "module:inventory", "module:repairs"],
        ["PATCH", "/tool/state", "module:dashboard", "module:reports"],
        ["DELETE", "/tool", "module:inventory", "module:repairs"],
        ["GET", "/tool/repairs", "module:repairs", "module:inventory"],
        ["POST", "/tool/repairs", "module:repairs", "module:dashboard"],
        ["PUT", "/tool/repairs/repair", "module:repairs", "module:inventory"]
    ]) {
        const request = (permission) => fetch(base + route, { method, headers: { "x-permissions": permission } });
        assert.equal((await request(allowed)).status, 204, `${method} ${route} allowed`);
        assert.equal((await request(denied)).status, 403, `${method} ${route} denied`);
    }
});
