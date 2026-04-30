const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp } = require("../src/app");

test("createApp registers the root endpoint and tool routes", () => {
    const app = createApp();
    const stack = app._router.stack;
    const routePaths = stack
        .filter((layer) => layer.route)
        .map((layer) => layer.route.path);
    const mountedRouters = stack
        .filter((layer) => layer.name === "router")
        .map((layer) => layer.regexp.toString());

    assert.deepEqual(routePaths, ["/"]);
    assert.ok(mountedRouters.some((layer) => layer.includes("\\/api\\/tools")));
    assert.ok(mountedRouters.some((layer) => layer.includes("\\/api\\/technicians")));
    assert.ok(mountedRouters.some((layer) => layer.includes("\\/api\\/locations")));
    assert.ok(mountedRouters.some((layer) => layer.includes("\\/api\\/tool-types")));
});
