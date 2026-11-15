const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const express = require("express");
const { loadModuleWithMocks } = require("../helpers/loadModuleWithMocks");
const auth = require("../../src/middleware/authMiddleware");

test("application routes enforce their module and restrict catalog writes", async (t) => {
    const previous = process.env.MODULE_PERMISSIONS_ENABLED;
    process.env.MODULE_PERMISSIONS_ENABLED = "false";
    t.after(() => {
        if (previous === undefined) delete process.env.MODULE_PERMISSIONS_ENABLED;
        else process.env.MODULE_PERMISSIONS_ENABLED = previous;
    });
    const fakeRouter = express.Router();
    fakeRouter.use((_req, res) => res.status(204).end());
    const mocks = {
        "./middleware/authMiddleware": {
            ...auth,
            requireAuthenticated: (req, _res, next) => {
                req.authUser = { permissions: ["app:access", ...String(req.get("x-permissions") || "").split(",")] };
                next();
            },
            requireCsrf: (req, res, next) => req.get("x-csrf-token") === "valid" ? next() : res.sendStatus(403)
        },
        "./middleware/telemetryMiddleware": { createTelemetryMiddleware: () => (_req, _res, next) => next() },
        "./exams/examRoutes": { createExamRouter: () => fakeRouter }
    };
    for (const [file, name] of [
        ["toolRoutes", "toolRouter"], ["moduleDataRoutes", "moduleDataRouter"],
        ["technicianRoutes", "technicianRouter"], ["locationRoutes", "locationRouter"],
        ["toolTypeRoutes", "toolTypeRouter"], ["tagRoutes", "tagRouter"],
        ["storageBoxRoutes", "storageBoxRouter"], ["shelfConfigRoutes", "shelfConfigRouter"],
        ["workshopStorageRoutes", "workshopStorageRouter"], ["authRoutes", "authRouter"],
        ["userRoutes", "userRouter"], ["adminRoutes", "adminRouter"], ["taskBoardRoutes", "taskBoardRouter"],
        ["todoListRoutes", "todoListRouter"], ["drawingRoutes", "drawingRouter"],
        ["telemetryRoutes", "telemetryRouter"], ["monitoringRoutes", "monitoringRouter"],
        ["toolTracingRoutes", "toolTracingRouter"], ["taskTracingRoutes", "taskTracingRouter"],
        ["workshopTracingRoutes", "workshopTracingRouter"]
    ]) mocks[`./routes/${file}`] = { [name]: fakeRouter };
    const { createApp } = loadModuleWithMocks(path.resolve(__dirname, "../../src/app.js"), mocks);
    const server = createApp().listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    process.env.MODULE_PERMISSIONS_ENABLED = "true";
    const base = `http://127.0.0.1:${server.address().port}`;
    const request = (route, method, permission, csrf = true) => fetch(base + route, {
        method, headers: { "x-permissions": permission, ...(csrf ? { "x-csrf-token": "valid" } : {}) }
    });
    for (const [route, method, allowed, denied] of [
        ["/api/storage-boxes/x", "GET", "module:storage", "module:inventory"],
        ["/api/workshop-storage/x", "POST", "module:workshop-storage", "module:settings"],
        ["/api/workshop-storage/categories", "GET", "module:settings", "module:storage"],
        ["/api/task-board/x", "GET", "module:task-board", "module:todo-list"],
        ["/api/todo-list/x", "GET", "module:todo-list", "module:task-board"],
        ["/api/drawing/x", "GET", "module:drawing", "module:exams"],
        ["/api/exams/x", "GET", "module:exams", "module:drawing"],
        ["/api/technicians/x", "GET", "module:technicians", "module:repairs"],
        ["/api/locations/x", "GET", "module:settings", "module:repairs"],
        ["/api/tool-types/x", "GET", "module:settings", "module:inventory"],
        ["/api/tags/x", "GET", "module:settings", "module:storage"],
        ["/api/shelf-config", "GET", "module:storage", "module:inventory"],
        ["/api/shelf-config", "PUT", "module:settings", "module:storage"]
    ]) {
        assert.equal((await request(route, method, allowed)).status, 204, `${method} ${route} allowed`);
        assert.equal((await request(route, method, denied)).status, 403, `${method} ${route} denied`);
        if (method !== "GET") assert.equal((await request(route, method, allowed, false)).status, 403);
    }
});
