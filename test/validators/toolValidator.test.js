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

function createToolServiceHarness(initialTools = {}) {
    const store = {
        tools: structuredClone(initialTools)
    };
    let idCounter = 1;
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

    const toolService = loadModuleWithMocks(
        path.resolve(__dirname, "../../src/services/toolService.js"),
        {
            "firebase/database": firebaseDatabaseMock,
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
        deletedImages
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
