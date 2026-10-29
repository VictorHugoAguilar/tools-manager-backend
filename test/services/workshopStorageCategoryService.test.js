const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { loadModuleWithMocks } = require("../helpers/loadModuleWithMocks");

function createSnapshot(value) {
    return {
        exists: () => value !== undefined && value !== null,
        val: () => value
    };
}

function createCategoryServiceHarness(initialConfig) {
    const store = { workshopStorageSettings: initialConfig };
    const database = {};
    let nextId = 0;

    function findNode(location) {
        return location.split("/").reduce((value, part) => value?.[part], store);
    }

    function setNode(location, value) {
        const parts = location.split("/");
        const key = parts.pop();
        const parent = parts.reduce((node, part) => {
            node[part] ??= {};
            return node[part];
        }, store);
        parent[key] = value;
    }

    function removeNode(location) {
        const parts = location.split("/");
        const key = parts.pop();
        const parent = parts.reduce((node, part) => node?.[part], store);
        if (parent) delete parent[key];
    }

    const firebaseDatabase = {
        ref(_database, location) {
            return { location };
        },
        async get(reference) {
            return createSnapshot(findNode(reference.location));
        },
        push(reference) {
            nextId += 1;
            return { location: `${reference.location}/category-${nextId}`, key: `category-${nextId}` };
        },
        async set(reference, value) {
            setNode(reference.location, value);
        },
        async remove(reference) {
            removeNode(reference.location);
        }
    };

    const service = loadModuleWithMocks(
        path.resolve(__dirname, "../../src/services/workshopStorageCategoryService.js"),
        {
            "firebase/database": firebaseDatabase,
            "../config/database": { getDatabaseInstance: () => database }
        }
    );

    return { service, store };
}

test("workshop material categories start with the initial options", async () => {
    const { service } = createCategoryServiceHarness();

    const categories = await service.findAllMaterialCategories();

    assert.deepEqual(categories.map((category) => category.name), [
        "Tornillos",
        "Tuercas",
        "Arandelas",
        "Tacos",
        "Piezas eléctricas",
        "Otros"
    ]);
});

test("adding a workshop material category persists the defaults and new option", async () => {
    const { service, store } = createCategoryServiceHarness();

    const category = await service.createMaterialCategory(" Adhesivos ");
    const categories = await service.findAllMaterialCategories();

    assert.deepEqual(category, { id: "category-1", name: "Adhesivos" });
    assert.ok(categories.some((item) => item.id === category.id && item.name === category.name));
    assert.equal(store.workshopStorageSettings.materialCategories.initialized, true);
});

test("workshop material category names cannot be duplicated", async () => {
    const { service } = createCategoryServiceHarness();
    await service.createMaterialCategory("Adhesivos");

    await assert.rejects(
        () => service.createMaterialCategory(" adhesivos "),
        (error) => error.statusCode === 409
    );
});

test("deleting workshop material categories preserves an intentionally empty catalog", async () => {
    const { service } = createCategoryServiceHarness();
    const initialCategories = await service.findAllMaterialCategories();

    for (const category of initialCategories) {
        assert.equal(await service.deleteMaterialCategory(category.id), true);
    }

    assert.deepEqual(await service.findAllMaterialCategories(), []);
});
