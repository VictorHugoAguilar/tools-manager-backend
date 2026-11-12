const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { loadModuleWithMocks } = require("../helpers/loadModuleWithMocks");
const { CacheService } = require("../../src/cache/cacheService");
const { loadCacheConfig } = require("../../src/cache/cacheConfig");

// Escenario equivalente con y sin caché sobre un Firebase simulado; mide lecturas reales, no estima mejoras.
async function runScenario({ cacheEnabled }) {
    const store = { tools: Object.fromEntries(Array.from({ length: 50 }, (_, index) => [`t${index}`, {
        name: `Herramienta ${index}`, type: "Manual", category: "General", description: "d", state: index % 2 ? "Disponible" : "Prestada",
        urlSrc: "", material: "Acero", serialNumber: `${index}`, location: "Taller", long: index
    }])) };
    const reads = { count: 0 };
    const cache = new CacheService({ enabled: cacheEnabled });
    const snapshot = (value) => ({ val: () => value, exists: () => value !== undefined });
    const toolService = loadModuleWithMocks(path.resolve(__dirname, "../../src/services/toolService.js"), {
        "firebase/database": {
            ref: (_db, dbPath) => ({ path: dbPath }),
            async get(reference) {
                reads.count += 1;
                return snapshot(reference.path === "tools" ? store.tools : store.tools[reference.path.replace("tools/", "")]);
            },
            push: () => ({ key: "new" }),
            async set(reference, value) { store.tools[reference.path.replace("tools/", "")] = value; },
            async update(reference, value) {
                const id = reference.path.replace("tools/", "");
                store.tools[id] = { ...store.tools[id], ...value };
            },
            async remove() {}
        },
        "../cache/sharedCache": { cache, cacheConfig: loadCacheConfig({}) },
        "../config/database": { getDatabaseInstance: () => ({}) },
        "./toolImageStorageService": { deleteImageByUrl: async () => true },
        "../audit/businessOutbox": { isToolAuditEnabled: () => false, transactTool: async () => null }
    });
    const results = [];
    for (let round = 0; round < 10; round += 1) {
        results.push(await toolService.findAll({ filters: {}, pagination: { enabled: true, page: 1, limit: 10 } }));
        results.push(await toolService.findAll({ filters: { state: "disponible" } }));
        results.push(await toolService.findById("t1"));
    }
    await toolService.updateState("t1", "Prestada");
    results.push(await toolService.findAll({ filters: { state: "prestada" } }));
    results.push(await toolService.findById("t1"));
    return { reads: reads.count, results, stats: cache.stats() };
}

test("the same workload returns identical data with and without cache and reads Firebase far less with it", async (t) => {
    const without = await runScenario({ cacheEnabled: false });
    const withCache = await runScenario({ cacheEnabled: true });

    assert.deepEqual(withCache.results, without.results);
    assert.ok(withCache.reads < without.reads);
    assert.ok(withCache.stats.hits > 0);
    t.diagnostic(`lecturas Firebase sin caché: ${without.reads}, con caché: ${withCache.reads}; hits: ${withCache.stats.hits}, misses: ${withCache.stats.misses}`);
});
