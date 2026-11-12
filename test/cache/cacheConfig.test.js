const test = require("node:test");
const assert = require("node:assert/strict");
const { loadCacheConfig, DEFAULT_TTL_MS, DEFAULT_MAX_ENTRIES } = require("../../src/cache/cacheConfig");

test("defaults are conservative and enabled", () => {
    const config = loadCacheConfig({});
    assert.equal(config.enabled, true);
    assert.equal(config.maxEntries, DEFAULT_MAX_ENTRIES);
    assert.deepEqual(config.ttlMs, DEFAULT_TTL_MS);
});

test("valid environment values are applied", () => {
    const config = loadCacheConfig({
        CACHE_ENABLED: "false", CACHE_MAX_ENTRIES: "50",
        CACHE_TTL_TOOLS_MS: "5000", CACHE_TTL_WORKSHOP_MS: "10000", CACHE_TTL_CATALOGS_MS: "120000"
    });
    assert.deepEqual([config.enabled, config.maxEntries], [false, 50]);
    assert.deepEqual({ ...config.ttlMs }, { tools: 5000, workshop: 10000, catalogs: 120000 });
});

test("invalid values fall back to safe defaults", () => {
    for (const bad of ["abc", "-5", "0", "1.5", "999999999", "1e4", " "]) {
        const config = loadCacheConfig({ CACHE_TTL_TOOLS_MS: bad, CACHE_MAX_ENTRIES: bad });
        assert.equal(config.ttlMs.tools, DEFAULT_TTL_MS.tools, bad);
        assert.equal(config.maxEntries, DEFAULT_MAX_ENTRIES, bad);
    }
});

test("only an explicit false disables the cache", () => {
    assert.equal(loadCacheConfig({ CACHE_ENABLED: "FALSE" }).enabled, false);
    assert.equal(loadCacheConfig({ CACHE_ENABLED: "0" }).enabled, true);
    assert.equal(loadCacheConfig({ CACHE_ENABLED: "" }).enabled, true);
});

test("the configuration is immutable", () => {
    const config = loadCacheConfig({});
    assert.throws(() => { "use strict"; config.ttlMs.tools = 1; }, TypeError);
});
