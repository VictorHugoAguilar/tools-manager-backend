const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { loadModuleWithMocks } = require("../helpers/loadModuleWithMocks");
const { transactWorkshopStorage } = require("../../src/audit/businessOutbox");

function fakeDatabase(initial) {
    let data = structuredClone(initial);
    let failing = false;
    return {
        get data() { return data; },
        fail() { failing = true; },
        ref: () => ({ async transaction(change) {
            if (failing) throw new Error("database unavailable");
            const next = change(structuredClone(data));
            if (next === undefined) return { committed: false };
            data = next;
            return { committed: true };
        } })
    };
}

function service(db) {
    return loadModuleWithMocks(path.resolve(__dirname, "../../src/services/workshopStorageService.js"), {
        "firebase/database": { ref: () => ({}), push: () => ({ key: "created-id" }) },
        "../config/database": { getDatabaseInstance: () => ({}) },
        "../audit/businessOutbox": {
            isWorkshopStorageAuditEnabled: () => true,
            transactWorkshopStorage: (options) => transactWorkshopStorage({ ...options, database: db })
        }
    });
}

test("workshop audited changes commit with sanitized events and preserve unrelated data", async () => {
    const db = fakeDatabase({ unrelated: { kept: true }, workshopStorage: {
        shelves: { parent: { name: "private-name" } }
    } });
    const api = service(db);
    await api.create("levels", { name: "secret", shelfId: "parent", width: 10, depth: 10 }, "actor");
    await api.updateEntity("levels", "created-id", { name: "changed" }, "actor");
    await assert.rejects(api.deleteEntity("shelves", "parent", "actor"), { statusCode: 409 });
    assert.equal(await api.deleteEntity("levels", "created-id", "actor"), true);
    assert.equal(await api.deleteEntity("levels", "missing", "actor"), false);
    assert.deepEqual(db.data.unrelated, { kept: true });
    const events = Object.values(db.data.auditOutbox);
    assert.deepEqual(events.map((event) => event.action), [
        "workshop.levels.created", "workshop.levels.updated", "workshop.levels.deleted"
    ]);
    assert.ok(events.every((event) => event.actorId === "actor" && event.targetId === "created-id"));
    assert.doesNotMatch(JSON.stringify(events), /secret|changed|private-name/);
});

test("workshop audited mutations enforce parent and layout invariants inside transaction", async () => {
    const db = fakeDatabase({ workshopStorage: {
        shelves: { shelf: {} },
        levels: { level: { shelfId: "shelf", width: 10, depth: 10 } },
        organizers: { org: { levelId: "level", width: 8, depth: 8, columns: 2 } },
        compartments: { slot: { organizerId: "org", row: 1, column: 2 } }
    } });
    const api = service(db);
    await assert.rejects(api.create("materials", { compartmentId: "missing" }, "actor"), { statusCode: 404 });
    await assert.rejects(api.updateEntity("levels", "level", { width: 1, depth: 1 }, "actor"), { statusCode: 409 });
    await assert.rejects(api.updateEntity("organizers", "org", { columns: 1 }, "actor"), { statusCode: 409 });
    await assert.rejects(api.create("compartments", { organizerId: "org", row: 1, column: 2 }, "actor"), { statusCode: 409 });
    assert.equal(db.data.auditOutbox, undefined);
    db.fail();
    await assert.rejects(api.deleteEntity("compartments", "slot", "actor"), /database unavailable/);
    assert.ok(db.data.workshopStorage.compartments.slot);
});
