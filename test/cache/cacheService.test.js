const test = require("node:test");
const assert = require("node:assert/strict");
const { CacheService } = require("../../src/cache/cacheService");

function clock() {
    const state = { time: 0 };
    return { now: () => state.time, advance: (ms) => { state.time += ms; } };
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

test("hit and miss are counted", () => {
    const cache = new CacheService();
    assert.equal(cache.get("a"), undefined);
    cache.set("a", { n: 1 }, 1000);
    assert.deepEqual(cache.get("a"), { n: 1 });
    assert.deepEqual([cache.stats().hits, cache.stats().misses], [1, 1]);
});

test("expired values are never returned", () => {
    const time = clock();
    const cache = new CacheService({ now: time.now });
    cache.set("a", 1, 100);
    time.advance(99);
    assert.equal(cache.get("a"), 1);
    time.advance(1);
    assert.equal(cache.get("a"), undefined);
    assert.equal(cache.stats().expirations, 1);
    assert.equal(cache.stats().size, 0);
});

test("invalid keys, ttl and loaders are rejected", async () => {
    const cache = new CacheService();
    assert.throws(() => cache.set("", 1, 10), TypeError);
    for (const ttl of [0, -1, NaN, Infinity, "10", undefined]) {
        assert.throws(() => cache.set("a", 1, ttl), RangeError);
    }
    await assert.rejects(cache.getOrLoad("a", null, 10), TypeError);
    assert.throws(() => new CacheService({ maxEntries: 0 }), RangeError);
});

test("concurrent getOrLoad calls for one key share a single loader execution", async () => {
    const cache = new CacheService();
    const gate = deferred();
    let calls = 0;
    const loader = () => { calls += 1; return gate.promise; };
    const pending = [cache.getOrLoad("a", loader, 1000), cache.getOrLoad("a", loader, 1000), cache.getOrLoad("a", loader, 1000)];
    gate.resolve({ ok: true });
    const results = await Promise.all(pending);
    assert.equal(calls, 1);
    assert.deepEqual(results, [{ ok: true }, { ok: true }, { ok: true }]);
    assert.notEqual(results[0], results[1]);
    await cache.getOrLoad("a", loader, 1000);
    assert.equal(calls, 1);
    assert.equal(cache.stats().loads, 1);
});

test("different keys load in parallel", async () => {
    const cache = new CacheService();
    const gates = { a: deferred(), b: deferred() };
    const started = [];
    const load = (key) => cache.getOrLoad(key, () => { started.push(key); return gates[key].promise; }, 1000);
    const first = load("a");
    const second = load("b");
    assert.deepEqual(started, ["a", "b"]);
    gates.b.resolve(2);
    gates.a.resolve(1);
    assert.deepEqual(await Promise.all([first, second]), [1, 2]);
});

test("a failing loader is not cached and allows retry", async () => {
    const cache = new CacheService();
    let calls = 0;
    const loader = async () => {
        calls += 1;
        if (calls === 1) throw new Error("boom");
        return "ok";
    };
    const [first, second] = await Promise.allSettled([cache.getOrLoad("a", loader, 1000), cache.getOrLoad("a", loader, 1000)]);
    assert.equal(first.status, "rejected");
    assert.equal(second.status, "rejected");
    assert.equal(calls, 1);
    assert.equal(await cache.getOrLoad("a", loader, 1000), "ok");
    assert.equal(cache.stats().errors, 1);
});

test("synchronous loader exceptions are handled like rejections", async () => {
    const cache = new CacheService();
    await assert.rejects(cache.getOrLoad("a", () => { throw new Error("sync"); }, 1000), /sync/);
    assert.equal(await cache.getOrLoad("a", () => 5, 1000), 5);
});

test("invalidate and invalidatePrefix remove entries", () => {
    const cache = new CacheService();
    cache.set("tools:list:1", 1, 1000);
    cache.set("tools:detail:1", 2, 1000);
    cache.set("workshop:all", 3, 1000);
    assert.equal(cache.invalidate("workshop:all"), true);
    assert.equal(cache.invalidate("workshop:all"), false);
    assert.equal(cache.invalidatePrefix("tools:"), 2);
    assert.equal(cache.stats().size, 0);
    assert.equal(cache.stats().invalidations, 3);
});

test("invalidating a key during its load prevents the stale result from being cached", async () => {
    const cache = new CacheService();
    const stale = deferred();
    const fresh = deferred();
    const oldLoad = cache.getOrLoad("a", () => stale.promise, 1000);
    cache.invalidate("a");
    const newLoad = cache.getOrLoad("a", () => fresh.promise, 1000);
    stale.resolve("old");
    assert.equal(await oldLoad, "old");
    assert.equal(cache.get("a"), undefined);
    fresh.resolve("new");
    assert.equal(await newLoad, "new");
    assert.equal(cache.get("a"), "new");
});

test("a stale load finishing after the fresh one cannot overwrite it", async () => {
    const cache = new CacheService();
    const stale = deferred();
    const fresh = deferred();
    const oldLoad = cache.getOrLoad("a", () => stale.promise, 1000);
    cache.invalidate("a");
    const newLoad = cache.getOrLoad("a", () => fresh.promise, 1000);
    fresh.resolve("new");
    await newLoad;
    stale.resolve("old");
    await oldLoad;
    assert.equal(cache.get("a"), "new");
});

test("prefix invalidation and clear also discard in-flight loads", async () => {
    const cache = new CacheService();
    const first = deferred();
    const second = deferred();
    const a = cache.getOrLoad("tools:a", () => first.promise, 1000);
    const b = cache.getOrLoad("other:b", () => second.promise, 1000);
    cache.invalidatePrefix("tools:");
    first.resolve(1);
    await a;
    assert.equal(cache.get("tools:a"), undefined);
    cache.clear();
    second.resolve(2);
    await b;
    assert.equal(cache.get("other:b"), undefined);
});

test("a failed stale load does not disturb a newer load", async () => {
    const cache = new CacheService();
    const stale = deferred();
    const fresh = deferred();
    const oldLoad = cache.getOrLoad("a", () => stale.promise, 1000);
    cache.invalidate("a");
    const newLoad = cache.getOrLoad("a", () => fresh.promise, 1000);
    stale.reject(new Error("late"));
    await assert.rejects(oldLoad, /late/);
    const shared = cache.getOrLoad("a", () => assert.fail("must share the newer load"), 1000);
    fresh.resolve("new");
    assert.equal(await newLoad, "new");
    assert.equal(await shared, "new");
});

test("the entry limit evicts the least recently used entry deterministically", () => {
    const cache = new CacheService({ maxEntries: 2 });
    cache.set("a", 1, 1000);
    cache.set("b", 2, 1000);
    cache.get("a");
    cache.set("c", 3, 1000);
    assert.equal(cache.get("b"), undefined);
    assert.equal(cache.get("a"), 1);
    assert.equal(cache.get("c"), 3);
    assert.equal(cache.stats().evictions, 1);
    cache.set("c", 4, 1000);
    assert.equal(cache.stats().evictions, 1);
});

test("expired entries are purged before evicting live ones", () => {
    const time = clock();
    const cache = new CacheService({ maxEntries: 2, now: time.now });
    cache.set("old", 1, 10);
    cache.set("live", 2, 1000);
    time.advance(10);
    cache.set("new", 3, 1000);
    assert.equal(cache.get("live"), 2);
    assert.equal(cache.stats().evictions, 0);
});

test("clear removes everything", () => {
    const cache = new CacheService();
    cache.set("a", 1, 1000);
    cache.set("b", 2, 1000);
    cache.clear();
    assert.equal(cache.get("a"), undefined);
    assert.equal(cache.stats().size, 0);
});

test("a disabled cache never stores and always calls the loader", async () => {
    const cache = new CacheService({ enabled: false });
    let calls = 0;
    cache.set("a", 1, 1000);
    assert.equal(cache.get("a"), undefined);
    await cache.getOrLoad("a", () => { calls += 1; return 1; }, 1000);
    await cache.getOrLoad("a", () => { calls += 1; return 1; }, 1000);
    assert.equal(calls, 2);
    assert.equal(cache.stats().size, 0);
});

test("stored and returned values are isolated from accidental mutation", async () => {
    const cache = new CacheService();
    const original = { list: [1, 2], nested: { a: 1 } };
    cache.set("a", original, 1000);
    original.list.push(3);
    const first = cache.get("a");
    first.nested.a = 99;
    assert.deepEqual(cache.get("a"), { list: [1, 2], nested: { a: 1 } });
    const loaded = await cache.getOrLoad("b", async () => ({ n: 1 }), 1000);
    loaded.n = 2;
    assert.deepEqual(cache.get("b"), { n: 1 });
});

test("falsy values such as null, 0 and empty arrays are cached", async () => {
    const cache = new CacheService();
    let calls = 0;
    for (const value of [null, 0, []]) {
        const key = `k${calls}`;
        await cache.getOrLoad(key, async () => { calls += 1; return value; }, 1000);
        await cache.getOrLoad(key, async () => { calls += 100; return value; }, 1000);
    }
    assert.equal(calls, 3);
});
