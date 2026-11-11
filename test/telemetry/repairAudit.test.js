const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { loadModuleWithMocks } = require("../helpers/loadModuleWithMocks");
const { transactRepair } = require("../../src/audit/businessOutbox");
const { AuditOutboxWorker } = require("../../src/audit/outboxWorker");

function harness() {
    let root = { tools: { t: { name: "private tool" } }, technicians: { tech: { name: "private technician" } } };
    let fail = false;
    const database = { ref(pathname) {
        if (!pathname) return { async transaction(change) {
            if (fail) throw new Error("database unavailable");
            const value = change(structuredClone(root));
            if (value === undefined) return { committed: false };
            root = value;
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
    const service = loadModuleWithMocks(path.resolve(__dirname, "../../src/services/repairHistoryService.js"), {
        "firebase/database": { ref: () => ({}), push: () => ({ key: "repair1" }) },
        "../config/database": { getDatabaseInstance: () => ({}) },
        "../audit/businessOutbox": {
            isRepairAuditEnabled: () => true,
            transactRepair: (options) => transactRepair({ ...options, database })
        }
    });
    return { service, database, get root() { return root; }, fail() { fail = true; } };
}

test("repair mutations atomically create publishable events without business content", async () => {
    const h = harness();
    const data = { technicianId: "tech", technicianName: "stale", description: "private description" };
    const repair = await h.service.create("t", data, "actor");
    assert.equal(repair.technicianName, "private technician");
    await h.service.update("t", "repair1", { ...data, description: "private changed" }, "actor");
    assert.equal(await h.service.remove("t", "repair1", "actor"), true);
    assert.equal(await h.service.remove("t", "missing", "actor"), false);
    const events = Object.values(h.root.auditOutbox);
    assert.deepEqual(events.map((e) => e.action), ["repair.created", "repair.updated", "repair.deleted"]);
    assert.ok(events.every((e) => e.actorId === "actor" && e.targetId === "repair1" && e.toolId === "t"));
    assert.doesNotMatch(JSON.stringify(events), /private|stale/);
    const records = [];
    const worker = new AuditOutboxWorker({
        getRealtimeDatabase: () => h.database,
        getFirestoreDatabase: () => ({ collection: () => ({ doc: () => ({ create: async (item) => records.push(item) }) }) })
    });
    await worker.flush();
    assert.equal(records.length, 3);
    assert.equal(Object.keys(h.root.auditOutbox).length, 0);
});

test("failed validation or transaction never changes repair data or writes audit", async () => {
    const h = harness();
    await assert.rejects(h.service.create("missing", { technicianId: "tech" }, "actor"), { statusCode: 404 });
    await assert.rejects(h.service.create("t", { technicianId: "missing" }, "actor"), { statusCode: 400 });
    await assert.rejects(h.service.create("t", { technicianId: "tech" }), /no válidos/);
    await assert.rejects(h.service.create("../unsafe", { technicianId: "tech" }, "actor"), /no válidos/);
    assert.equal(h.root.auditOutbox, undefined);
    h.fail();
    await assert.rejects(h.service.create("t", { technicianId: "tech" }, "actor"), /database unavailable/);
    assert.equal(h.root.auditOutbox, undefined);
    assert.equal(h.root.toolRepairs, undefined);
});

test("repair transaction retries use the latest technician and preserve one event id", async () => {
    let firstEventId;
    let committed;
    const database = { ref: () => ({ async transaction(change) {
        const first = change({ tools: { t: {} }, technicians: { tech: { name: "before" } } });
        firstEventId = Object.keys(first.auditOutbox)[0];
        committed = change({ tools: { t: {} }, technicians: { tech: { name: "after" } }, unrelated: true });
        return { committed: true };
    } }) };
    const result = await transactRepair({
        id: "repair", toolId: "t", actorId: "actor", action: "repair.created", database,
        change: (_current, _repairs, root) => {
            const value = { technicianName: root.technicians.tech.name };
            return { value, result: value };
        }
    });
    assert.equal(result.technicianName, "after");
    assert.equal(committed.unrelated, true);
    assert.deepEqual(Object.keys(committed.auditOutbox), [firstEventId]);
    assert.equal(committed.auditOutbox[firstEventId].toolId, "t");
});

test("repair controllers propagate the authenticated actor to every mutation", async () => {
    const calls = [];
    const repairs = {
        async create(...args) { calls.push(["create", ...args]); return { id: "repair" }; },
        async update(...args) { calls.push(["update", ...args]); return { id: "repair" }; },
        async remove(...args) { calls.push(["remove", ...args]); return true; }
    };
    const controller = loadModuleWithMocks(path.resolve(__dirname, "../../src/controllers/repairHistoryController.js"), {
        "../services/repairHistoryService": repairs,
        "../services/technicianService": { findById: async () => ({ name: "technician" }) },
        "../services/toolService": { findById: async () => ({ id: "tool" }) },
        "../validators/repairHistoryValidator": { validateRepairPayload: () => ({
            isValid: true, data: { technicianId: "tech" }
        }) }
    });
    const req = { params: { toolId: "tool", repairId: "repair" }, body: {}, authUser: { id: "actor" } };
    const res = { status() { return this; }, json(value) { return value; }, send() {} };
    await controller.createToolRepair(req, res);
    await controller.updateToolRepair(req, res);
    await controller.deleteToolRepair(req, res);
    assert.equal(calls[0].at(-1), "actor");
    assert.equal(calls[1].at(-1), "actor");
    assert.equal(calls[2].at(-1), "actor");
});
