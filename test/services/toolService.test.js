const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { loadModuleWithMocks } = require("../helpers/loadModuleWithMocks");
const { createTool } = require("../fixtures/tool");

function createSnapshot(value) {
    return {
        val() {
            return value;
        },
        exists() {
            return value !== null && value !== undefined;
        }
    };
}

function createToolServiceHarness(initialTools = {}, { cacheEnabled = true } = {}) {
    const store = {
        tools: structuredClone(initialTools)
    };
    let idCounter = 1;
    const control = { failWrites: false };
    const deletedImages = [];

    const firebaseDatabaseMock = {
        ref(_database, dbPath) {
            return { path: dbPath };
        },
        async get(reference) {
            if (reference.path === "tools") {
                return createSnapshot(store.tools);
            }

            const toolId = reference.path.replace("tools/", "");
            return createSnapshot(store.tools[toolId]);
        },
        push(reference) {
            const key = `tool-${idCounter++}`;

            return {
                key,
                path: `${reference.path}/${key}`
            };
        },
        async set(reference, value) {
            if (control.failWrites) throw new Error("firebase down");
            if (reference.path === "tools") {
                store.tools = value;
                return;
            }

            const toolId = reference.path.replace("tools/", "");
            store.tools[toolId] = value;
        },
        async update(reference, value) {
            const toolId = reference.path.replace("tools/", "");
            store.tools[toolId] = {
                ...store.tools[toolId],
                ...value
            };
        },
        async remove(reference) {
            const toolId = reference.path.replace("tools/", "");
            delete store.tools[toolId];
        }
    };

    const reads = { all: 0, byId: 0 };
    const originalGet = firebaseDatabaseMock.get;
    firebaseDatabaseMock.get = async (reference) => {
        if (reference.path === "tools") reads.all += 1;
        else reads.byId += 1;
        return originalGet(reference);
    };
    const { CacheService } = require("../../src/cache/cacheService");
    const { loadCacheConfig } = require("../../src/cache/cacheConfig");

    const toolService = loadModuleWithMocks(
        path.resolve(__dirname, "../../src/services/toolService.js"),
        {
            "firebase/database": firebaseDatabaseMock,
            "../cache/sharedCache": {
                cache: new CacheService({ enabled: cacheEnabled }),
                cacheConfig: loadCacheConfig({})
            },
            "../config/database": {
                getDatabaseInstance() {
                    return {};
                }
            },
            "./toolImageStorageService": {
                async deleteImageByUrl(url) {
                    deletedImages.push(url);
                    return true;
                }
            }
        }
    );

    return {
        toolService,
        store,
        deletedImages,
        reads,
        control
    };
}

test("findAll filters, sorts and paginates tools", async () => {
    const { toolService } = createToolServiceHarness({
        a1: createTool({ id: "a1", name: "Sierra", state: "Disponible", long: 40 }),
        a2: createTool({ id: "a2", name: "Taladro", state: "Prestada", long: 20 }),
        a3: createTool({ id: "a3", name: "Amoladora", state: "Disponible", long: 30 })
    });

    const result = await toolService.findAll({
        filters: { state: "disponible" },
        sorting: { enabled: true, sortBy: "name", sortOrder: "asc" },
        pagination: { enabled: true, page: 1, limit: 1 }
    });

    assert.deepEqual(result, {
        items: [
            createTool({ id: "a3", name: "Amoladora", state: "Disponible", long: 30 })
        ],
        meta: {
            totalItems: 2,
            totalPages: 2,
            currentPage: 1,
            limit: 1,
            hasNextPage: true,
            hasPreviousPage: false
        }
    });
});

test("findById returns null for unknown ids", async () => {
    const { toolService } = createToolServiceHarness();

    const result = await toolService.findById("missing");

    assert.equal(result, null);
});

test("create stores a new tool with generated id", async () => {
    const { toolService, store } = createToolServiceHarness();

    const created = await toolService.create(createTool());

    assert.equal(created.id, "tool-1");
    assert.deepEqual(store.tools["tool-1"], created);
});

test("update returns null when the tool does not exist", async () => {
    const { toolService } = createToolServiceHarness();

    const result = await toolService.update("missing", createTool());

    assert.equal(result, null);
});

test("update overwrites an existing tool", async () => {
    const { toolService, store } = createToolServiceHarness({
        a1: createTool({ id: "a1", name: "Sierra" })
    });

    const result = await toolService.update(
        "a1",
        createTool({ name: "Sierra nueva", urlSrc: "https://example.com/nueva.jpg" })
    );

    assert.equal(result.name, "Sierra nueva");
    assert.equal(store.tools.a1.id, "a1");
    assert.equal(store.tools.a1.urlSrc, "https://example.com/nueva.jpg");
});

test("updateState changes only the state field in the returned tool", async () => {
    const { toolService, store } = createToolServiceHarness({
        a1: createTool({ id: "a1", state: "Disponible" })
    });

    const result = await toolService.updateState("a1", "Prestada");

    assert.equal(result.state, "Prestada");
    assert.equal(store.tools.a1.state, "Prestada");
});

test("updateImageUrl clears or updates the image url", async () => {
    const { toolService, store } = createToolServiceHarness({
        a1: createTool({ id: "a1", urlSrc: "https://example.com/old.jpg" })
    });

    const result = await toolService.updateImageUrl("a1", "");

    assert.equal(result.urlSrc, "");
    assert.equal(store.tools.a1.urlSrc, "");
});

test("remove deletes the tool and requests image cleanup", async () => {
    const { toolService, store, deletedImages } = createToolServiceHarness({
        a1: createTool({ id: "a1", urlSrc: "https://bucket/image.jpg" })
    });

    const result = await toolService.remove("a1");

    assert.equal(result, true);
    assert.equal(store.tools.a1, undefined);
    assert.deepEqual(deletedImages, ["https://bucket/image.jpg"]);
});

test("repeated reads hit Firebase once while the entry is fresh, for any filter combination", async () => {
    const { toolService, reads } = createToolServiceHarness({
        a1: createTool({ id: "a1", name: "Sierra", state: "Disponible" }),
        a2: createTool({ id: "a2", name: "Taladro", state: "Prestada" })
    });

    const all = await toolService.findAll();
    const filtered = await toolService.findAll({ filters: { state: "prestada" } });
    const paged = await toolService.findAll({ pagination: { enabled: true, page: 1, limit: 1 } });

    assert.equal(reads.all, 1);
    assert.equal(all.length, 2);
    assert.deepEqual(filtered.map((tool) => tool.id), ["a2"]);
    assert.equal(paged.items.length, 1);
    assert.equal(paged.meta.totalItems, 2);
});

test("findById is cached per id and a different id is never answered with another tool", async () => {
    const { toolService, reads } = createToolServiceHarness({
        a1: createTool({ id: "a1", name: "Sierra" }),
        a2: createTool({ id: "a2", name: "Taladro" })
    });

    assert.equal((await toolService.findById("a1")).name, "Sierra");
    assert.equal((await toolService.findById("a1")).name, "Sierra");
    assert.equal((await toolService.findById("a2")).name, "Taladro");
    assert.equal(reads.byId, 2);
});

test("unknown tools are not cached", async () => {
    const { toolService, store, reads } = createToolServiceHarness();

    assert.equal(await toolService.findById("late"), null);
    store.tools.late = createTool({ id: "late", name: "Nueva" });

    assert.equal((await toolService.findById("late")).name, "Nueva");
    assert.equal(reads.byId, 2);
});

test("mutating a returned result does not corrupt the cache", async () => {
    const { toolService } = createToolServiceHarness({ a1: createTool({ id: "a1", name: "Sierra" }) });

    const first = await toolService.findAll();
    first[0].name = "Alterada";
    const byId = await toolService.findById("a1");
    byId.name = "Alterada";

    assert.equal((await toolService.findAll())[0].name, "Sierra");
    assert.equal((await toolService.findById("a1")).name, "Sierra");
});

test("create, update, updateState, updateImageUrl and remove invalidate list and detail", async () => {
    const { toolService } = createToolServiceHarness({ a1: createTool({ id: "a1", name: "Sierra", state: "Disponible" }) });
    const names = async () => (await toolService.findAll()).map((tool) => tool.name).sort();

    assert.deepEqual(await names(), ["Sierra"]);
    const created = await toolService.create(createTool({ name: "Taladro" }));
    assert.deepEqual(await names(), ["Sierra", "Taladro"]);

    await toolService.findById("a1");
    await toolService.update("a1", createTool({ name: "Sierra 2" }));
    assert.equal((await toolService.findById("a1")).name, "Sierra 2");
    assert.deepEqual(await names(), ["Sierra 2", "Taladro"]);

    await toolService.updateState("a1", "Prestada");
    assert.equal((await toolService.findById("a1")).state, "Prestada");
    assert.equal((await toolService.findAll()).find((tool) => tool.id === "a1").state, "Prestada");

    await toolService.updateImageUrl("a1", "https://img/x.png");
    assert.equal((await toolService.findById("a1")).urlSrc, "https://img/x.png");

    await toolService.findById(created.id);
    await toolService.remove(created.id);
    assert.equal(await toolService.findById(created.id), null);
    assert.deepEqual(await names(), ["Sierra 2"]);
});

test("writes check existence against Firebase, not against a stale cached copy", async () => {
    const { toolService, store } = createToolServiceHarness({ a1: createTool({ id: "a1", name: "Sierra" }) });
    await toolService.findById("a1");
    delete store.tools.a1;

    assert.equal(await toolService.update("a1", createTool({ name: "X" })), null);
    assert.equal(await toolService.remove("a1"), false);
});

test("a failed write propagates the error and does not cache a false result", async () => {
    const { toolService, store, control } = createToolServiceHarness({ a1: createTool({ id: "a1", name: "Sierra" }) });
    await toolService.findAll();
    control.failWrites = true;

    await assert.rejects(toolService.update("a1", createTool({ name: "Nueva" })), /firebase down/);
    control.failWrites = false;

    assert.equal(store.tools.a1.name, "Sierra");
    assert.equal((await toolService.findAll())[0].name, "Sierra");
    assert.equal((await toolService.findById("a1")).name, "Sierra");
});

test("a read started before a write cannot repopulate the cache with the old list", async () => {
    const { toolService, store } = createToolServiceHarness({ a1: createTool({ id: "a1", name: "Sierra" }) });
    const staleRead = toolService.findAll();
    await toolService.update("a1", createTool({ name: "Nueva" }));
    await staleRead;

    assert.equal((await toolService.findAll())[0].name, "Nueva");
    assert.equal(store.tools.a1.name, "Nueva");
});

test("with the cache disabled every read goes to Firebase", async () => {
    const { toolService, reads } = createToolServiceHarness({ a1: createTool({ id: "a1" }) }, { cacheEnabled: false });

    await toolService.findAll();
    await toolService.findAll();

    assert.equal(reads.all, 2);
});
