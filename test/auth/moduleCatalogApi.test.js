const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const sessions = require("../../src/services/authSessionService");
const originalResolveSession = sessions.resolveSession;
sessions.resolveSession = async (token) => token === "valid"
    ? { profile: { id: "user", permissions: ["app:access"] } }
    : null;
const { authRouter } = require("../../src/routes/authRoutes");
test.after(() => { sessions.resolveSession = originalResolveSession; });

test("authenticated users can retrieve the module catalog without changing permissions", async () => {
    const app = express();
    app.use("/api/auth", authRouter);
    const server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    try {
        const url = `http://127.0.0.1:${server.address().port}/api/auth/modules`;
        assert.equal((await fetch(url)).status, 401);
        const response = await fetch(url, { headers: { cookie: "tm_session=valid" } });
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("cache-control"), "no-store");
        const { modules } = await response.json();
        const inventory = modules.find((module) => module.id === "inventory");
        assert.equal(inventory.route, "/inventario");
        assert.equal(inventory.permission, "module:inventory");
        assert.equal(inventory.active, true);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});
