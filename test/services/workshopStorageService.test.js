const test = require("node:test");
const assert = require("node:assert/strict");
const { organizerFitsLevel } = require("../../src/services/workshopStorageService");

test("workshop organizer fits when its dimensions fit the shelf level", () => {
    assert.equal(
        organizerFitsLevel({ width: 300, depth: 200 }, { width: 400, depth: 250 }),
        true
    );
});

test("workshop organizer can be rotated to fit the shelf level", () => {
    assert.equal(
        organizerFitsLevel({ width: 300, depth: 200 }, { width: 250, depth: 350 }),
        true
    );
});

test("workshop organizer is rejected when it exceeds shelf dimensions", () => {
    assert.equal(
        organizerFitsLevel({ width: 400, depth: 300 }, { width: 350, depth: 250 }),
        false
    );
});

test("workshop organizer fit remains unchecked when physical dimensions are absent", () => {
    assert.equal(
        organizerFitsLevel({ width: 400 }, { width: 350, depth: 250 }),
        true
    );
});

const path = require("path");
const { loadModuleWithMocks } = require("../helpers/loadModuleWithMocks");
const { CacheService } = require("../../src/cache/cacheService");
const { loadCacheConfig } = require("../../src/cache/cacheConfig");

function createHarness({ cacheEnabled = true, audit = false } = {}) {
    const store = { shelves: {}, levels: {}, organizers: {}, compartments: {}, materials: {} };
    const reads = { count: 0 };
    const control = { failWrites: false };
    let counter = 1;
    const snapshot = (value) => ({ val: () => value, exists: () => value !== undefined && value !== null });
    const split = (reference) => reference.path.replace("workshopStorage/", "").split("/");
    const firebase = {
        ref: (_db, dbPath) => ({ path: dbPath }),
        async get(reference) {
            reads.count += 1;
            const [collection, id] = split(reference);
            return snapshot(id ? store[collection][id] : store[collection]);
        },
        push: (reference) => ({ key: `id-${counter++}`, path: `${reference.path}/id-${counter - 1}` }),
        async set(reference, value) {
            if (control.failWrites) throw new Error("firebase down");
            const [collection, id] = split(reference);
            store[collection][id] = value;
        },
        async update(reference, value) {
            if (control.failWrites) throw new Error("firebase down");
            const [collection, id] = split(reference);
            store[collection][id] = { ...store[collection][id], ...value };
        },
        async remove(reference) {
            const [collection, id] = split(reference);
            delete store[collection][id];
        }
    };
    const service = loadModuleWithMocks(path.resolve(__dirname, "../../src/services/workshopStorageService.js"), {
        "firebase/database": firebase,
        "../config/database": { getDatabaseInstance: () => ({}) },
        "../cache/sharedCache": { cache: new CacheService({ enabled: cacheEnabled }), cacheConfig: loadCacheConfig({}) },
        "../audit/businessOutbox": { isWorkshopStorageAuditEnabled: () => audit, transactWorkshopStorage: async () => null }
    });
    return { service, store, reads, control };
}

async function seedHierarchy(service) {
    const shelf = await service.create("shelves", { name: "Estante A" });
    const level = await service.create("levels", { name: "Nivel 1", shelfId: shelf.id });
    const organizer = await service.create("organizers", { name: "Organizador", levelId: level.id, columns: 2 });
    const compartment = await service.create("compartments", { name: "Hueco", organizerId: organizer.id, row: 1, column: 1 });
    const material = await service.create("materials", { name: "Tornillo", category: "Fijaciones", compartmentId: compartment.id });
    return { shelf, level, organizer, compartment, material };
}

test("findAll reads the five collections once while the snapshot is fresh", async () => {
    const { service, reads } = createHarness();
    await seedHierarchy(service);
    reads.count = 0;

    const first = await service.findAll();
    const second = await service.findAll();

    assert.equal(reads.count, 5);
    assert.deepEqual(second, first);
    assert.deepEqual(Object.keys(first), ["shelves", "levels", "organizers", "compartments", "materials"]);
});

test("searchMaterials reuses the cached snapshot and keeps its result structure", async () => {
    const { service, reads } = createHarness();
    const { material, shelf } = await seedHierarchy(service);
    await service.findAll();
    reads.count = 0;

    const byName = await service.searchMaterials("tornillo");
    const byShelf = await service.searchMaterials("estante");
    const none = await service.searchMaterials("martillo");

    assert.equal(reads.count, 0);
    assert.equal(byName.length, 1);
    assert.equal(byName[0].material.id, material.id);
    assert.deepEqual(Object.keys(byName[0]), ["material", "compartment", "organizer", "level", "shelf"]);
    assert.equal(byShelf[0].shelf.id, shelf.id);
    assert.deepEqual(none, []);
});

test("every write kind invalidates the aggregate snapshot and searches", async () => {
    const { service } = createHarness();
    const { material, shelf } = await seedHierarchy(service);
    const find = async () => (await service.searchMaterials("tornillo")).map((result) => result.material.name);
    assert.deepEqual(await find(), ["Tornillo"]);

    await service.updateEntity("materials", material.id, { name: "Tornillo largo" });
    assert.deepEqual(await find(), ["Tornillo largo"]);
    assert.equal((await service.findAll()).materials[0].name, "Tornillo largo");

    await service.updateEntity("materials", material.id, { imagePath: "x.png" }, undefined, "image.updated");
    assert.equal((await service.findAll()).materials[0].imagePath, "x.png");

    await service.updateEntity("shelves", shelf.id, { name: "Estante Z" });
    assert.equal((await service.searchMaterials("estante z")).length, 1);

    await service.deleteEntity("materials", material.id);
    assert.deepEqual((await service.findAll()).materials, []);
    assert.deepEqual(await service.searchMaterials("tornillo"), []);

    const created = await service.create("materials", { name: "Tuerca", compartmentId: (await service.findAll()).compartments[0].id });
    assert.equal((await service.findAll()).materials[0].id, created.id);
});

test("shelves, levels, organizers and compartments also invalidate the snapshot", async () => {
    const { service } = createHarness();
    const { level, organizer, compartment } = await seedHierarchy(service);
    await service.findAll();

    await service.updateEntity("levels", level.id, { name: "Nivel renombrado" });
    assert.equal((await service.findAll()).levels[0].name, "Nivel renombrado");
    await service.updateEntity("organizers", organizer.id, { name: "Org 2" });
    assert.equal((await service.findAll()).organizers[0].name, "Org 2");
    await service.updateEntity("compartments", compartment.id, { name: "Hueco 2" });
    assert.equal((await service.findAll()).compartments[0].name, "Hueco 2");
});

test("a failed write propagates the error and leaves the snapshot consistent with Firebase", async () => {
    const { service, control } = createHarness();
    const { material } = await seedHierarchy(service);
    await service.findAll();
    control.failWrites = true;

    await assert.rejects(service.updateEntity("materials", material.id, { name: "Falla" }), /firebase down/);
    control.failWrites = false;

    assert.equal((await service.findAll()).materials[0].name, "Tornillo");
});

test("business rule errors do not cache anything and keep the same status code", async () => {
    const { service } = createHarness();
    await service.findAll();

    await assert.rejects(service.create("levels", { name: "Huérfano", shelfId: "missing" }), (error) => error.statusCode === 404);
    assert.deepEqual((await service.findAll()).levels, []);
});

test("write validations read Firebase directly, not the cached snapshot", async () => {
    const { service, store } = createHarness();
    const { shelf } = await seedHierarchy(service);
    await service.findAll();
    delete store.shelves[shelf.id];

    await assert.rejects(service.create("levels", { name: "N2", shelfId: shelf.id }), (error) => error.statusCode === 404);
});

test("a snapshot load started before a write cannot repopulate the cache with old data", async () => {
    const { service } = createHarness();
    const { material } = await seedHierarchy(service);
    const stale = service.findAll();
    await service.updateEntity("materials", material.id, { name: "Nuevo" });
    await stale;

    assert.equal((await service.findAll()).materials[0].name, "Nuevo");
});

test("mutating a returned snapshot does not corrupt the cache", async () => {
    const { service } = createHarness();
    await seedHierarchy(service);

    (await service.findAll()).materials[0].name = "Alterado";

    assert.equal((await service.findAll()).materials[0].name, "Tornillo");
});

test("with the cache disabled every findAll reads Firebase", async () => {
    const { service, reads } = createHarness({ cacheEnabled: false });
    reads.count = 0;

    await service.findAll();
    await service.findAll();

    assert.equal(reads.count, 10);
});
