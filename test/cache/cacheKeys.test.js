const test = require("node:test");
const assert = require("node:assert/strict");
const { cacheKeys, CACHE_PREFIXES, normalizeParams } = require("../../src/cache/cacheKeys");

test("equivalent parameters produce the same key regardless of order, blanks and spacing", () => {
    const a = cacheKeys.toolsList({ page: 1, search: "  taladro   percutor ", status: undefined, sort: "name" });
    const b = cacheKeys.toolsList({ sort: "name", search: "taladro percutor", page: 1, status: "", type: null });
    assert.equal(a, b);
});

test("different parameters never share a key", () => {
    const base = { page: 1, search: "a" };
    const keys = new Set([
        cacheKeys.toolsList(base), cacheKeys.toolsList({ ...base, page: 2 }), cacheKeys.toolsList({ ...base, search: "b" }),
        cacheKeys.toolsList({ ...base, extra: true }), cacheKeys.toolsList({ page: "1", search: "a" }),
        cacheKeys.toolsList({ ids: ["a", "b"] }), cacheKeys.toolsList({ ids: ["b", "a"] })
    ]);
    assert.equal(keys.size, 7);
});

test("keys use domain prefixes that allow selective invalidation", () => {
    assert.ok(cacheKeys.toolsList({}).startsWith(CACHE_PREFIXES.toolsList));
    assert.ok(cacheKeys.toolsList({}).startsWith(CACHE_PREFIXES.tools));
    assert.equal(cacheKeys.toolDetail("abc-1"), "tools:detail:abc-1");
    assert.equal(cacheKeys.workshopAll(), "workshop:all");
    assert.ok(cacheKeys.workshopMaterialsSearch({ q: "x" }).startsWith(CACHE_PREFIXES.workshopSearch));
    assert.ok(cacheKeys.workshopMaterialsSearch({ q: "x" }).startsWith(CACHE_PREFIXES.workshop));
    assert.equal(cacheKeys.catalog("tags"), "catalog:tags");
});

test("the base tools collection key cannot collide with a hashed list key", () => {
    assert.equal(cacheKeys.toolsAll(), "tools:list:all");
    assert.notEqual(cacheKeys.toolsList({}), cacheKeys.toolsAll());
});

test("search text is hashed, so it never appears in the key", () => {
    assert.doesNotMatch(cacheKeys.workshopMaterialsSearch({ q: "juan.perez" }), /juan/);
});

test("unsafe identifiers and unknown catalogs are rejected", () => {
    for (const id of ["", "a:b", "a/b", "a b", "x".repeat(129), 5, undefined]) {
        assert.throws(() => cacheKeys.toolDetail(id), TypeError);
    }
    assert.throws(() => cacheKeys.catalog("users"), TypeError);
});

test("sensitive parameter names and invalid values are rejected", () => {
    for (const name of ["token", "password", "authorization", "userEmail", "sessionId"]) {
        assert.throws(() => normalizeParams({ [name]: "x" }), TypeError);
    }
    assert.throws(() => normalizeParams({ a: () => 1 }), TypeError);
    assert.throws(() => normalizeParams({ a: NaN }), TypeError);
});

test("there are no keys for authentication, permissions or audit", () => {
    assert.deepEqual(Object.keys(cacheKeys).sort(), ["catalog", "toolDetail", "toolsAll", "toolsList", "workshopAll", "workshopMaterialsSearch"]);
});
