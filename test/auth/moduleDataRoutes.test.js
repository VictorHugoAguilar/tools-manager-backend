const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const express = require("express");
const { loadModuleWithMocks } = require("../helpers/loadModuleWithMocks");

test("module-specific resources enforce permissions and return only fields needed by each screen", async (t) => {
    const previous = process.env.MODULE_PERMISSIONS_ENABLED;
    process.env.MODULE_PERMISSIONS_ENABLED = "true";
    t.after(() => {
        if (previous === undefined) delete process.env.MODULE_PERMISSIONS_ENABLED;
        else process.env.MODULE_PERMISSIONS_ENABLED = previous;
    });
    const data = {
        id: "tool", name: "Drill", type: "Drill", category: "Tools", description: "detail",
        urlSrc: "image", state: "available", material: "steel", long: 1, brand: "brand",
        model: "model", serialNumber: "serial", location: "shelf", secret: "hidden"
    };
    const writes = [];
    const { moduleDataRouter } = loadModuleWithMocks(path.resolve(__dirname, "../../src/routes/moduleDataRoutes.js"), {
        "../services/toolService": {
            findAll: async () => [data],
            updateLocation: async (...args) => { writes.push(args); return { ...data, location: args[1] }; }
        },
        "../services/technicianService": {
            findAll: async () => [{ id: "tech", name: "T", active: true, email: "private@example.test" }]
        },
        "../services/locationService": {
            findAll: async () => [{ id: "loc", name: "Shelf", description: "private" }]
        },
        "../services/toolTypeService": {
            findAll: async () => [{ id: "type", name: "Drill", description: "private" }]
        },
        "../services/tagService": {
            findAll: async () => [{ id: "tag", name: "Metal", description: "private" }],
            create: async (tag, actor) => { writes.push([tag, actor]); return { id: "tag", ...tag }; }
        }
    });
    const app = express();
    app.use(express.json(), (req, _res, next) => {
        req.authUser = { id: "actor", permissions: String(req.get("x-permissions") || "").split(",") };
        next();
    }, moduleDataRouter);
    const server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}`;
    const read = (url, permission) => fetch(base + url, { headers: { "x-permissions": permission } });

    assert.equal((await read("/reports/tools", "module:categories")).status, 403);
    const reports = await (await read("/reports/tools", "module:reports")).json();
    assert.deepEqual(Object.keys(reports[0]).sort(), [
        "brand", "category", "description", "id", "long", "material", "model", "name", "state", "type"
    ]);
    const categories = await (await read("/categories/tools", "module:categories")).json();
    assert.equal(categories[0].serialNumber, undefined);
    assert.equal(categories[0].description, undefined);
    const techs = await (await read("/repairs/technicians", "module:repairs")).json();
    assert.deepEqual(techs, [{ id: "tech", name: "T", active: true }]);
    assert.deepEqual(await (await read("/repairs/locations", "module:repairs")).json(), [{ id: "loc", name: "Shelf" }]);
    assert.equal((await read("/tools/locations", "module:repairs")).status, 403);
    assert.deepEqual(await (await read("/tools/locations", "module:inventory")).json(), [{ id: "loc", name: "Shelf" }]);
    assert.deepEqual(await (await read("/tools/types", "module:dashboard")).json(), [{ id: "type", name: "Drill" }]);
    assert.deepEqual(await (await read("/storage/tags", "module:storage")).json(), [{ id: "tag", name: "Metal" }]);
    assert.equal((await read("/storage/tags", "module:inventory")).status, 403);
    const tagRequest = (body, permission = "module:storage") => fetch(base + "/storage/tags", {
        method: "POST", headers: { "content-type": "application/json", "x-permissions": permission },
        body: JSON.stringify(body)
    });
    assert.equal((await tagRequest({ name: "Metal", description: "private" })).status, 400);
    assert.equal((await tagRequest({ name: "Metal" }, "module:inventory")).status, 403);
    const createdTag = await tagRequest({ name: " New " });
    assert.equal(createdTag.status, 201);
    assert.deepEqual(await createdTag.json(), { id: "tag", name: "New" });
    assert.deepEqual(writes.splice(0), [[{ name: "New", description: "" }, "actor"]]);
    const bad = await fetch(base + "/repairs/tools/tool/location", {
        method: "PATCH", headers: { "content-type": "application/json", "x-permissions": "module:repairs" },
        body: JSON.stringify({ location: "New", name: "changed" })
    });
    assert.equal(bad.status, 400);
    const updated = await fetch(base + "/repairs/tools/tool/location", {
        method: "PATCH", headers: { "content-type": "application/json", "x-permissions": "module:repairs" },
        body: JSON.stringify({ location: " New " })
    });
    assert.equal(updated.status, 200);
    assert.deepEqual(writes, [["tool", "New", "actor"]]);
    assert.equal((await updated.json()).secret, undefined);
});
