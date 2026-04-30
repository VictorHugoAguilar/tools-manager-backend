const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { loadModuleWithMocks } = require("../helpers/loadModuleWithMocks");

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

function createToolTypeServiceHarness(initialToolTypes = {}) {
    const store = {
        toolTypes: structuredClone(initialToolTypes)
    };
    let idCounter = 1;

    const firebaseDatabaseMock = {
        ref(_database, dbPath) {
            return { path: dbPath };
        },
        async get(reference) {
            if (reference.path === "toolTypes") {
                return createSnapshot(store.toolTypes);
            }

            const toolTypeId = reference.path.replace("toolTypes/", "");
            return createSnapshot(store.toolTypes[toolTypeId]);
        },
        push(reference) {
            const key = `tool-type-${idCounter++}`;

            return {
                key,
                path: `${reference.path}/${key}`
            };
        },
        async set(reference, value) {
            const toolTypeId = reference.path.replace("toolTypes/", "");
            store.toolTypes[toolTypeId] = value;
        },
        async remove(reference) {
            const toolTypeId = reference.path.replace("toolTypes/", "");
            delete store.toolTypes[toolTypeId];
        }
    };

    const toolTypeService = loadModuleWithMocks(
        path.resolve(__dirname, "../../src/services/toolTypeService.js"),
        {
            "firebase/database": firebaseDatabaseMock,
            "../config/database": {
                getDatabaseInstance() {
                    return {};
                }
            }
        }
    );

    return {
        toolTypeService,
        store
    };
}

test("findAll returns tool types sorted by name", async () => {
    const { toolTypeService } = createToolTypeServiceHarness({
        b1: { id: "b1", name: "Soldadura", description: "" },
        a1: { id: "a1", name: "Corte", description: "" }
    });

    const result = await toolTypeService.findAll();

    assert.deepEqual(result.map((item) => item.name), ["Corte", "Soldadura"]);
});

test("create stores a new tool type with generated id", async () => {
    const { toolTypeService, store } = createToolTypeServiceHarness();

    const created = await toolTypeService.create({
        name: "Perforacion",
        description: "Herramientas de taladro"
    });

    assert.equal(created.id, "tool-type-1");
    assert.deepEqual(store.toolTypes["tool-type-1"], created);
});

test("remove deletes an existing tool type", async () => {
    const { toolTypeService, store } = createToolTypeServiceHarness({
        a1: { id: "a1", name: "Corte", description: "" }
    });

    const result = await toolTypeService.remove("a1");

    assert.equal(result, true);
    assert.equal(store.toolTypes.a1, undefined);
});
