const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { loadModuleWithMocks } = require("../helpers/loadModuleWithMocks");
const { transactCatalog } = require("../../src/audit/businessOutbox");
const { AuditOutboxWorker } = require("../../src/audit/outboxWorker");

function harness(initial = {}) {
    let root = structuredClone({ unrelated: { kept: true }, ...initial });
    let fail = false;
    let retry = null;
    let counter = 0;
    const database = { ref(pathname) {
        if (!pathname) return { async transaction(change) {
            if (fail) throw new Error("database unavailable");
            let next = change(structuredClone(root));
            if (retry) {
                retry(root);
                retry = null;
                next = change(structuredClone(root));
            }
            if (next === undefined) return { committed: false };
            root = next;
            return { committed: true };
        } };
        return {
            orderByKey() { return this; },
            limitToFirst() { return this; },
            async get() { return { forEach(callback) {
                for (const [key, value] of Object.entries(root.auditOutbox || {})) {
                    callback({ key, val: () => structuredClone(value) });
                }
            } }; },
            child(id) { return { async transaction(change) {
                const next = change(root.auditOutbox[id]);
                if (next === null) delete root.auditOutbox[id];
                return { committed: next !== undefined };
            } }; }
        };
    } };
    const transact = (options) => transactCatalog({ ...options, database });
    const helper = loadModuleWithMocks(path.resolve(__dirname, "../../src/audit/catalogAudit.js"), {
        "./businessOutbox": { transactCatalog: transact }
    });
    function service(name) {
        return loadModuleWithMocks(path.resolve(__dirname, `../../src/services/${name}Service.js`), {
            "firebase/database": { ref: () => ({}), push: () => ({ key: `generated${++counter}` }) },
            "../config/database": { getDatabaseInstance: () => ({}) },
            "../audit/businessOutbox": { isCatalogAuditEnabled: () => true, transactCatalog: transact },
            "../audit/catalogAudit": helper
        });
    }
    return {
        service, database, get root() { return root; },
        fail() { fail = true; }, retry(change) { retry = change; }
    };
}

test("catalog changes atomically publish sanitized events with authenticated actor", async () => {
    const h = harness();
    const catalogNames = [
        ["location", "location"], ["technician", "technician"], ["toolType", "tool_type"], ["tag", "tag"]
    ];
    for (const [serviceName] of catalogNames) {
        const api = h.service(serviceName);
        const created = await api.create({ name: `private-${serviceName}` }, "actor");
        assert.ok(created.id);
        assert.equal((await api.update(created.id, { name: "secret changed" }, "actor")).name, "secret changed");
        assert.equal(await api.remove(created.id, "actor"), true);
        assert.equal(await api.remove("missing", "actor"), false);
    }
    const events = Object.values(h.root.auditOutbox);
    assert.deepEqual(events.map((event) => event.action), catalogNames.flatMap(([, name]) =>
        [`${name}.created`, `${name}.updated`, `${name}.deleted`]));
    assert.ok(events.every((event) => event.actorId === "actor" && event.targetId));
    assert.doesNotMatch(JSON.stringify(events), /private|secret/);
    assert.deepEqual(h.root.unrelated, { kept: true });
    const published = [];
    const worker = new AuditOutboxWorker({
        getRealtimeDatabase: () => h.database,
        getFirestoreDatabase: () => ({ collection: () => ({ doc: () => ({ create: async (value) => published.push(value) }) }) })
    });
    await worker.flush();
    assert.equal(published.length, 12);
    assert.equal(Object.keys(h.root.auditOutbox).length, 0);
});

test("duplicate tag operations preserve existing responses without emitting audit", async () => {
    const h = harness({ tags: { existing: { name: "Alpha" }, another: { name: "Beta" } } });
    const tags = h.service("tag");
    assert.deepEqual(await tags.create({ name: " alpha " }, "actor"), { id: "existing", name: "Alpha" });
    assert.deepEqual(await tags.update("another", { name: "ALPHA" }, "actor"),
        { id: "existing", name: "Alpha", duplicated: true });
    assert.equal(h.root.auditOutbox, undefined);
    assert.equal(h.root.tags.another.name, "Beta");
});

test("tag duplicate validation is repeated on transaction retry", async () => {
    const h = harness({ tags: {} });
    h.retry((root) => { root.tags.other = { name: "Alpha" }; });
    const result = await h.service("tag").create({ name: "alpha" }, "actor");
    assert.deepEqual(result, { id: "other", name: "Alpha" });
    assert.equal(h.root.auditOutbox, undefined);
    assert.equal(Object.keys(h.root.tags).length, 1);
});

test("catalog creation works on an empty root and recalculates after a null cache retry", async () => {
    let root = null;
    const database = { ref() { return { async transaction(change) {
        root = change(root);
        return { committed: true };
    } }; } };
    const change = (_current, _entities, currentRoot) => ({
        value: { name: "value" }, result: currentRoot.marker || "empty"
    });
    assert.equal(await transactCatalog({ id: "one", actorId: "actor", collection: "tags",
        operation: "created", change, database }), "empty");
    assert.equal(root.tags.one.name, "value");
    const retryDatabase = { ref() { return { async transaction(callback) {
        callback(null);
        root.marker = "remote";
        root = callback(root);
        return { committed: true };
    } }; } };
    assert.equal(await transactCatalog({ id: "two", actorId: "actor", collection: "tags",
        operation: "created", change, database: retryDatabase }), "remote");
    assert.equal(Object.keys(root.auditOutbox).length, 2);
});

test("tag updates recheck duplicates on retry", async () => {
    const h = harness({ tags: { item: { name: "Beta" } } });
    h.retry((root) => { root.tags.other = { name: "Alpha" }; });
    assert.deepEqual(await h.service("tag").update("item", { name: "alpha" }, "actor"),
        { id: "other", name: "Alpha", duplicated: true });
    assert.equal(h.root.tags.item.name, "Beta");
    assert.equal(h.root.auditOutbox, undefined);
});

test("a duplicate that disappears on retry is created with one audit event", async () => {
    const h = harness({ tags: { other: { name: "Alpha" } } });
    h.retry((root) => { delete root.tags.other; });
    const result = await h.service("tag").create({ name: "alpha" }, "actor");
    assert.equal(result.name, "alpha");
    assert.equal(h.root.tags[result.id].name, "alpha");
    assert.equal(Object.keys(h.root.auditOutbox).length, 1);
    assert.equal(Object.values(h.root.auditOutbox)[0].targetId, result.id);
});

test("catalog transactions reject failure, missing actor and unrecognized actions", async () => {
    const h = harness({ locations: { id: { name: "old" } } });
    const api = h.service("location");
    await assert.rejects(api.update("id", { name: "new" }), /auditoría no válidos/);
    assert.throws(() => transactCatalog({ id: "id", actorId: "a", collection: "other", operation: "created", database: h.database }),
        /catálogo no válida/);
    h.fail();
    await assert.rejects(api.update("id", { name: "new" }, "actor"), /database unavailable/);
    assert.equal(h.root.locations.id.name, "old");
    assert.equal(h.root.auditOutbox, undefined);
});

test("catalog controllers forward the authenticated actor to each mutation", async () => {
    const cases = [
        ["location", "Location"], ["technician", "Technician"], ["toolType", "ToolType"], ["tag", "Tag"]
    ];
    for (const [name, suffix] of cases) {
        const calls = [];
        const service = {
            async create(...args) { calls.push(args); return {}; },
            async update(...args) { calls.push(args); return {}; },
            async remove(...args) { calls.push(args); return true; }
        };
        const controller = loadModuleWithMocks(path.resolve(__dirname, `../../src/controllers/${name}Controller.js`), {
            [`../services/${name}Service`]: service,
            [`../validators/${name}Validator`]: { [`validate${suffix}Payload`]: () => ({ isValid: true, data: {} }) }
        });
        const req = { params: { id: "id" }, body: {}, authUser: { id: "actor" } };
        const res = { status() { return this; }, json(value) { return value; }, send() {} };
        await controller[`create${suffix}`](req, res);
        await controller[`update${suffix}`](req, res);
        await controller[`delete${suffix}`](req, res);
        assert.equal(calls.length, 3);
        assert.ok(calls.every((args) => args.at(-1) === "actor"));
    }
});
