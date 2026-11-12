const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { loadModuleWithMocks } = require("../helpers/loadModuleWithMocks");
const { CacheService } = require("../../src/cache/cacheService");
const { loadCacheConfig } = require("../../src/cache/cacheConfig");

const CATALOGS = [
    { service: "tagService", node: "tags" },
    { service: "locationService", node: "locations" },
    { service: "technicianService", node: "technicians" },
    { service: "toolTypeService", node: "toolTypes" }
];

function harness({ service, node }, { cacheEnabled = true } = {}) {
    const store = { [node]: {} };
    const reads = { list: 0, item: 0 };
    const control = { failWrites: false };
    let counter = 1;
    const snapshot = (value) => ({ val: () => value, exists: () => value !== undefined && value !== null });
    const firebase = {
        ref: (_db, dbPath) => ({ path: dbPath }),
        async get(reference) {
            if (reference.path === node) {
                reads.list += 1;
                return snapshot(store[node]);
            }
            reads.item += 1;
            return snapshot(store[node][reference.path.replace(`${node}/`, "")]);
        },
        push: (reference) => ({ key: `id-${counter++}`, path: `${reference.path}/id-${counter - 1}` }),
        async set(reference, value) {
            if (control.failWrites) throw new Error("firebase down");
            store[node][reference.path.replace(`${node}/`, "")] = value;
        },
        async remove(reference) {
            delete store[node][reference.path.replace(`${node}/`, "")];
        }
    };
    const loaded = loadModuleWithMocks(path.resolve(__dirname, `../../src/services/${service}.js`), {
        "firebase/database": firebase,
        "../config/database": { getDatabaseInstance: () => ({}) },
        "../cache/sharedCache": { cache: new CacheService({ enabled: cacheEnabled }), cacheConfig: loadCacheConfig({}) },
        "../audit/businessOutbox": { isCatalogAuditEnabled: () => false, transactCatalog: async () => null },
        "../audit/catalogAudit": {}
    });
    return { loaded, store, reads, control };
}

for (const catalog of CATALOGS) {
    test(`${catalog.service}: findAll reads Firebase once while fresh and returns isolated copies`, async () => {
        const { loaded, reads } = harness(catalog);
        await loaded.create({ name: "Uno" });
        reads.list = 0;

        const first = await loaded.findAll();
        first[0].name = "Alterado";
        const second = await loaded.findAll();

        assert.equal(reads.list, 1);
        assert.equal(second[0].name, "Uno");
    });

    test(`${catalog.service}: create, update and remove invalidate the list`, async () => {
        const { loaded } = harness(catalog);
        const created = await loaded.create({ name: "Uno" });
        assert.deepEqual((await loaded.findAll()).map((item) => item.name), ["Uno"]);

        await loaded.update(created.id, { name: "Dos" });
        assert.deepEqual((await loaded.findAll()).map((item) => item.name), ["Dos"]);

        await loaded.create({ name: "Tres" });
        assert.equal((await loaded.findAll()).length, 2);

        await loaded.remove(created.id);
        assert.deepEqual((await loaded.findAll()).map((item) => item.name), ["Tres"]);
    });

    test(`${catalog.service}: a failed write propagates and leaves the list consistent with Firebase`, async () => {
        const { loaded, control } = harness(catalog);
        const created = await loaded.create({ name: "Uno" });
        await loaded.findAll();
        control.failWrites = true;

        await assert.rejects(loaded.update(created.id, { name: "Falla" }), /firebase down/);
        control.failWrites = false;

        assert.equal((await loaded.findAll())[0].name, "Uno");
    });

    test(`${catalog.service}: a list load started before a write cannot repopulate the cache with old data`, async () => {
        const { loaded } = harness(catalog);
        const created = await loaded.create({ name: "Uno" });
        const stale = loaded.findAll();
        await loaded.update(created.id, { name: "Nuevo" });
        await stale;

        assert.equal((await loaded.findAll())[0].name, "Nuevo");
    });

    test(`${catalog.service}: findById and write checks always read Firebase`, async () => {
        const { loaded, store, reads } = harness(catalog);
        const created = await loaded.create({ name: "Uno" });
        await loaded.findAll();
        reads.item = 0;

        await loaded.findById(created.id);
        await loaded.findById(created.id);
        assert.equal(reads.item, 2);

        delete store[catalog.node][created.id];
        assert.equal(await loaded.update(created.id, { name: "X" }), null);
    });

    test(`${catalog.service}: with the cache disabled every findAll reads Firebase`, async () => {
        const { loaded, reads } = harness(catalog, { cacheEnabled: false });
        reads.list = 0;

        await loaded.findAll();
        await loaded.findAll();

        assert.equal(reads.list, 2);
    });
}
