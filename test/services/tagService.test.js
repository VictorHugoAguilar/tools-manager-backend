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

function createTagServiceHarness(initialTags = {}) {
    const store = {
        tags: structuredClone(initialTags)
    };
    let idCounter = 1;

    const firebaseDatabaseMock = {
        ref(_database, dbPath) {
            return { path: dbPath };
        },
        async get(reference) {
            if (reference.path === "tags") {
                return createSnapshot(store.tags);
            }

            const tagId = reference.path.replace("tags/", "");
            return createSnapshot(store.tags[tagId]);
        },
        push(reference) {
            const key = `tag-${idCounter++}`;

            return {
                key,
                path: `${reference.path}/${key}`
            };
        },
        async set(reference, value) {
            const tagId = reference.path.replace("tags/", "");
            store.tags[tagId] = value;
        },
        async remove(reference) {
            const tagId = reference.path.replace("tags/", "");
            delete store.tags[tagId];
        }
    };

    const tagService = loadModuleWithMocks(
        path.resolve(__dirname, "../../src/services/tagService.js"),
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
        tagService,
        store
    };
}

test("findAll returns tags sorted by name", async () => {
    const { tagService } = createTagServiceHarness({
        b1: { id: "b1", name: "Usado", description: "" },
        a1: { id: "a1", name: "Nuevo", description: "" }
    });

    const result = await tagService.findAll();

    assert.deepEqual(result.map((item) => item.name), ["Nuevo", "Usado"]);
});

test("create stores a new tag with generated id", async () => {
    const { tagService, store } = createTagServiceHarness();

    const created = await tagService.create({
        name: "Tornilleria",
        description: "Productos pequenos"
    });

    assert.equal(created.id, "tag-1");
    assert.deepEqual(store.tags["tag-1"], created);
});

test("create reuses an existing tag with the same name", async () => {
    const { tagService, store } = createTagServiceHarness({
        tagA: { id: "tagA", name: "Tornilleria", description: "" }
    });

    const created = await tagService.create({
        name: "tornilleria",
        description: "Duplicado"
    });

    assert.equal(created.id, "tagA");
    assert.equal(Object.keys(store.tags).length, 1);
});

test("remove deletes an existing tag", async () => {
    const { tagService, store } = createTagServiceHarness({
        a1: { id: "a1", name: "Nuevo", description: "" }
    });

    const result = await tagService.remove("a1");

    assert.equal(result, true);
    assert.equal(store.tags.a1, undefined);
});
