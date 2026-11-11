const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { loadModuleWithMocks } = require("../helpers/loadModuleWithMocks");
const { transactStorageBox, transactStorageSettings } = require("../../src/audit/businessOutbox");
const { AuditOutboxWorker } = require("../../src/audit/outboxWorker");

function database(initial) {
    let data = structuredClone(initial);
    let fail = false;
    return {
        get data() { return data; },
        fail() { fail = true; },
        ref(pathname) {
            if (!pathname) return { async transaction(change) {
                if (fail) throw new Error("database unavailable");
                const next = change(structuredClone(data));
                if (next === undefined) return { committed: false };
                data = next;
                return { committed: true };
            } };
            return {
                orderByKey() { return this; },
                limitToFirst() { return this; },
                async get() { return { forEach: (callback) => {
                    for (const [key, value] of Object.entries(structuredClone(data.auditOutbox || {}))) {
                        callback({ key, val: () => value });
                    }
                } }; },
                child(id) { return { async transaction(change) {
                    if (change(data.auditOutbox[id]) === null) delete data.auditOutbox[id];
                    return { committed: true };
                } }; }
            };
        }
    };
}

function modules(db) {
    const audit = {
        isStorageBoxAuditEnabled: () => true,
        isWorkshopStorageAuditEnabled: () => true,
        transactStorageBox: (args) => transactStorageBox({ ...args, database: db }),
        transactStorageSettings: (args) => transactStorageSettings({ ...args, database: db })
    };
    const mocks = {
        "firebase/database": { ref: () => ({}), push: () => ({ key: "generated" }) },
        "../config/database": { getDatabaseInstance: () => ({}) },
        "../audit/businessOutbox": audit
    };
    return {
        boxes: loadModuleWithMocks(path.resolve(__dirname, "../../src/services/storageBoxService.js"), {
            ...mocks, "./toolImageStorageService": { deleteImageByUrl: () => { throw new Error("unsafe cleanup"); } }
        }),
        categories: loadModuleWithMocks(path.resolve(__dirname, "../../src/services/workshopStorageCategoryService.js"), mocks),
        shelves: loadModuleWithMocks(path.resolve(__dirname, "../../src/services/shelfConfigService.js"), mocks)
    };
}

test("box, product and shelf settings changes are atomic, sanitized and publishable", async () => {
    const db = database({ unrelated: { kept: true }, shelfConfig: { rows: 5, columns: 6 } });
    const { boxes, shelves, categories } = modules(db);
    await boxes.create({ name: "secret", description: "private", shelfRow: 2, shelfColumn: 1 }, "actor");
    await boxes.createProduct("generated", { name: "private-product", imageUrl: "secret-url" }, "actor");
    await boxes.update("generated", { code: "BOX-0001", name: "edited", description: "", shelfRow: 2, shelfColumn: 1 }, "actor");
    assert.ok(db.data.storageBoxes.generated.products.generated);
    await boxes.updateImageUrl("generated", "box-image-url", "actor");
    await boxes.updateProduct("generated", "generated", { name: "updated-product" }, "actor");
    await boxes.updateProductImageUrl("generated", "generated", "new-private-url", "actor");
    await assert.rejects(shelves.updateShelfConfig({ rows: 1, columns: 6 }, "actor"), { code: "SHELF_CONFIG_CONFLICT" });
    await shelves.updateShelfConfig({ rows: 3, columns: 6 }, "actor");
    await boxes.removeProduct("generated", "generated", "actor");
    await boxes.remove("generated", "actor");
    await categories.createMaterialCategory("private-category", "actor");
    await assert.rejects(categories.createMaterialCategory("PRIVATE-CATEGORY", "actor"), { statusCode: 409 });
    await categories.deleteMaterialCategory("generated", "actor");
    assert.equal(await categories.deleteMaterialCategory("constructor", "actor"), false);
    assert.deepEqual(db.data.unrelated, { kept: true });
    const events = Object.values(db.data.auditOutbox);
    assert.equal(events.length, 11);
    assert.doesNotMatch(JSON.stringify(events), /secret|private|edited|updated-product|box-image-url/);
    assert.equal(events.find((item) => item.action === "box.product.created").boxId, "generated");
    assert.equal(events.find((item) => item.action === "workshop.category.created").categoryId, "generated");
    const written = [];
    const worker = new AuditOutboxWorker({
        getRealtimeDatabase: () => db,
        getFirestoreDatabase: () => ({ collection: () => ({ doc: () => ({ create: async (event) => written.push(event) }) }) })
    });
    await worker.flush();
    assert.equal(written.length, 11);
    assert.equal(Object.keys(db.data.auditOutbox).length, 0);
});

test("failed audited transactions leave data unchanged and do not enqueue", async () => {
    const db = database({ storageBoxes: { box: { name: "old" } } });
    const { boxes } = modules(db);
    db.fail();
    await assert.rejects(boxes.update("box", { name: "new" }, "actor"), /database unavailable/);
    assert.equal(db.data.storageBoxes.box.name, "old");
    assert.equal(db.data.auditOutbox, undefined);
});
