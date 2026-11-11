const test = require("node:test");
const assert = require("node:assert/strict");
const { ResourceSampler, MAX_SAMPLE_AGE_MS } = require("../../src/telemetry/resourceSampler");

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("samples process CPU over elapsed monotonic time and filesystem capacity", async () => {
    let cpu = { user: 100000, system: 50000 };
    let time = 1000000000n;
    let now = 10000;
    const sampler = new ResourceSampler({
        cpuUsage: () => cpu, memoryUsage: () => 1048576, monotonicNow: () => time, now: () => now,
        readDisk: async () => ({ blocks: 100, bsize: 4096, bfree: 40, bavail: 30 })
    });
    sampler.sample();
    assert.equal(sampler.snapshot().process.cpuPercent, null);
    await settle();
    assert.deepEqual(sampler.snapshot().disk, {
        sampledAt: 10000, totalBytes: 409600, usedBytes: 245760, availableBytes: 122880
    });
    cpu = { user: 1800000, system: 450000 };
    time += 1000000000n;
    now += 1000;
    sampler.sample();
    assert.equal(sampler.snapshot().process.cpuPercent, 210);
    assert.equal(sampler.snapshot().process.rssBytes, 1048576);
    await settle();
    now += MAX_SAMPLE_AGE_MS + 1;
    assert.deepEqual(sampler.snapshot(), { process: null, disk: null });
});

test("disk failures leave process samples available and report no disk value", async () => {
    const sampler = new ResourceSampler({
        cpuUsage: () => ({ user: 0, system: 0 }), memoryUsage: () => 0,
        monotonicNow: () => 0n, now: () => 1000,
        readDisk: async () => { throw new Error("offline"); }
    });
    const original = console.error;
    const errors = [];
    console.error = (...args) => errors.push(args);
    try {
        sampler.sample();
        await settle();
        assert.equal(sampler.snapshot().disk, null);
        assert.equal(sampler.snapshot().process.rssBytes, 0);
        assert.equal(errors.length, 1);
    } finally { console.error = original; }
});

test("disk sampling is non-blocking, rejects malformed data and discards results after stop", async () => {
    let resolveDisk;
    const sampler = new ResourceSampler({
        cpuUsage: () => ({ user: 0, system: 0 }), memoryUsage: () => 1,
        monotonicNow: () => 1n, now: () => 1000,
        readDisk: () => new Promise((resolve) => { resolveDisk = resolve; })
    });
    sampler.sample();
    await Promise.resolve();
    assert.equal(sampler.snapshot().process.rssBytes, 1);
    assert.equal(sampler.snapshot().disk, null);
    sampler.stop();
    resolveDisk({ blocks: 100, bsize: 1, bfree: 50, bavail: 40 });
    await settle();
    assert.deepEqual(sampler.snapshot(), { process: null, disk: null });

    sampler.readDisk = async () => ({ blocks: 100, bsize: 1, bfree: 50, bavail: 60 });
    const original = console.error;
    console.error = () => {};
    try {
        sampler.sample();
        await settle();
        assert.equal(sampler.snapshot().disk, null);
    } finally { console.error = original; }
});
