const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { loadModuleWithMocks } = require("../helpers/loadModuleWithMocks");

let database;
let beforeNextTransaction;
let overrideNextTransactionValue = false;
let nextTransactionValue;

function readPath(path) {
    return path.split("/").filter(Boolean).reduce((value, part) => value?.[part], database);
}

function writePath(path, value) {
    const segments = path.split("/").filter(Boolean);
    if (!segments.length) {
        database = value === null ? {} : structuredClone(value);
        return;
    }
    let node = database;
    for (const segment of segments.slice(0, -1)) {
        if (!node[segment] || typeof node[segment] !== "object") node[segment] = {};
        node = node[segment];
    }
    if (value === null) delete node[segments.at(-1)];
    else node[segments.at(-1)] = structuredClone(value);
}

function reference(path = "") {
    return {
        child(childPath) {
            return reference([path, childPath].filter(Boolean).join("/"));
        },
        async get() {
            const value = readPath(path);
            return {
                exists: () => value !== null && value !== undefined,
                val: () => value === undefined ? null : structuredClone(value)
            };
        },
        async once() {
            return this.get();
        },
        async set(value) {
            writePath(path, value);
        },
        async update(changes) {
            for (const [key, value] of Object.entries(changes)) {
                writePath([path, key].filter(Boolean).join("/"), value);
            }
        },
        async remove() {
            writePath(path, null);
        },
        async transaction(update) {
            if (beforeNextTransaction) {
                const hook = beforeNextTransaction;
                beforeNextTransaction = null;
                hook(path);
            }
            const current = overrideNextTransactionValue
                ? nextTransactionValue
                : readPath(path);
            overrideNextTransactionValue = false;
            nextTransactionValue = undefined;
            const next = update(current === undefined ? null : structuredClone(current));
            if (next === undefined) return { committed: false };
            writePath(path, next);
            return { committed: true, snapshot: { val: () => structuredClone(next) } };
        }
    };
}

const fakeDatabase = { ref: reference };
const drawing = loadModuleWithMocks("../../src/services/drawingService", {
    "../config/firebaseAdmin": {
        getAdminDatabase: () => fakeDatabase,
        getAdminApp: () => ({})
    },
    "firebase-admin/storage": {
        getStorage: () => ({ bucket: () => ({ name: "test-bucket" }) })
    }
});

const ownerId = "user-1";
const otherUserId = "user-2";

test.beforeEach(() => {
    database = {};
    beforeNextTransaction = null;
    overrideNextTransactionValue = false;
    nextTransactionValue = undefined;
});

test("creates a private document with its initial page and snapshot", async () => {
    const document = await drawing.createDocument({ name: "Flujo de pedidos" }, ownerId);

    assert.equal(document.ownerUserId, ownerId);
    assert.equal(document.pages.length, 1);
    assert.deepEqual((await drawing.getSnapshot(document.pages[0].id, ownerId)).snapshot, { objects: [] });
    await assert.rejects(drawing.getDocument(document.id, otherUserId), { statusCode: 403 });
});

test("versioned snapshot writes succeed and stale writes conflict", async () => {
    const document = await drawing.createDocument({ name: "Diagrama" }, ownerId);
    const pageId = document.pages[0].id;
    const result = await drawing.saveSnapshot(pageId, {
        schemaVersion: 1,
        expectedVersion: 0,
        snapshot: { objects: [{ id: randomUUID(), type: "rect", x: 10, y: 20, width: 100, height: 50, fill: "#f6d768" }] }
    }, ownerId);

    assert.equal(result.version, 1);
    await assert.rejects(drawing.saveSnapshot(pageId, {
        schemaVersion: 1,
        expectedVersion: 0,
        snapshot: { objects: [] }
    }, ownerId), { statusCode: 409 });
    assert.equal((await drawing.listVersions(pageId, ownerId)).length, 2);
    await assert.rejects(drawing.getVersion(pageId, "not-a-version", ownerId), { statusCode: 400 });
});

test("reports a conflict if the page changes after authorization and before snapshot commit", async () => {
    const document = await drawing.createDocument({ name: "Página modificada" }, ownerId);
    const pageId = document.pages[0].id;
    const snapshotIds = Object.keys(readPath("drawing/snapshots"));
    beforeNextTransaction = (path) => {
        assert.equal(path, `drawing/pages/${pageId}`);
        writePath(path, { ...readPath(path), documentId: "another-document" });
    };

    await assert.rejects(drawing.saveSnapshot(pageId, {
        schemaVersion: 1,
        expectedVersion: 0,
        snapshot: { objects: [] }
    }, ownerId), { statusCode: 409 });
    assert.equal(readPath(`drawing/pages/${pageId}`).version, 0);
    assert.deepEqual(Object.keys(readPath("drawing/snapshots")), snapshotIds);
});

test("uses the freshly read page when the transaction cache initially returns null", async () => {
    const document = await drawing.createDocument({ name: "Caché vacío" }, ownerId);
    const pageId = document.pages[0].id;
    overrideNextTransactionValue = true;
    nextTransactionValue = null;

    const result = await drawing.saveSnapshot(pageId, {
        schemaVersion: 1,
        expectedVersion: 0,
        snapshot: { objects: [] }
    }, ownerId);

    assert.equal(result.version, 1);
    assert.equal((await drawing.getSnapshot(pageId, ownerId)).version, 1);
});

test("rejects malformed or oversized snapshots", async () => {
    assert.throws(() => drawing.validateSnapshot({
        schemaVersion: 1,
        expectedVersion: 0,
        snapshot: { objects: [{ id: "x", type: "script", x: 0, y: 0 }] }
    }), { statusCode: 400 });
    assert.throws(() => drawing.validateSnapshot({
        schemaVersion: 2,
        expectedVersion: 0,
        snapshot: { objects: [] }
    }), { statusCode: 400 });
    assert.throws(() => drawing.validateSnapshot({
        schemaVersion: 1,
        expectedVersion: 0,
        snapshot: { objects: [{ id: "x", type: "text", x: 0, y: 0, text: "a".repeat(10001) }] }
    }), { statusCode: 400 });
    assert.throws(() => drawing.validateSnapshot({
        schemaVersion: 1,
        expectedVersion: 0,
        snapshot: { objects: [{ id: "stroke", type: "freehand", x: 0, y: 0, points: [0, 0, 1] }] }
    }), { statusCode: 400 });
    assert.throws(() => drawing.validateSnapshot({
        schemaVersion: 1,
        expectedVersion: 0,
        snapshot: { objects: [{ id: "stroke", type: "freehand", x: 0, y: 0, points: [0, 0, 1e100, 1] }] }
    }), { statusCode: 400 });
});

test("normalizes Firebase object and empty-object representations of snapshot arrays", () => {
    assert.deepEqual(drawing.normalizeStoredSnapshot('[{"id":"shape","type":"rect","x":0,"y":0}]'), {
        objects: [{ id: "shape", type: "rect", x: 0, y: 0 }]
    });
    assert.deepEqual(drawing.normalizeStoredSnapshot([{ id: "shape", type: "rect", x: 0, y: 0 }]), {
        objects: [{ id: "shape", type: "rect", x: 0, y: 0 }]
    });
    assert.deepEqual(drawing.normalizeStoredSnapshot({ objects: {} }), { objects: [] });
    assert.deepEqual(drawing.normalizeStoredSnapshot({
        objects: {
            1: { id: "shape-2", type: "rect", x: 2, y: 3 },
            0: { id: "shape-1", type: "ellipse", x: 0, y: 1 }
        }
    }), {
        objects: [
            { id: "shape-1", type: "ellipse", x: 0, y: 1 },
            { id: "shape-2", type: "rect", x: 2, y: 3 }
        ]
    });
    assert.equal(drawing.normalizeStoredSnapshot({ objects: { 1: { id: "shape" } } }), null);
    assert.deepEqual(drawing.normalizeSnapshotRecord({
        snapshot: JSON.stringify({ objects: [] })
    }), { objects: [] });
});

test("reads legacy and sparse Firebase snapshot representations", async () => {
    const document = await drawing.createDocument({ name: "Compatibilidad" }, ownerId);
    const page = document.pages[0];
    const storedShape = { id: "shape-1", type: "rect", x: 10, y: 20 };

    writePath(`drawing/snapshots/${page.snapshotId}`, {
        pageId: page.id,
        version: 0,
        snapshot: { objects: { 2: storedShape } }
    });
    assert.deepEqual((await drawing.getSnapshot(page.id, ownerId)).snapshot, {
        objects: [storedShape]
    });

    writePath(`drawing/snapshots/${page.snapshotId}`, {
        pageId: page.id,
        version: 0,
        objects: [storedShape]
    });
    assert.deepEqual((await drawing.getSnapshot(page.id, ownerId)).snapshot, {
        objects: [storedShape]
    });
});

test("reads an empty snapshot whose empty object was omitted by Realtime Database", async () => {
    const document = await drawing.createDocument({ name: "Lienzo vacío" }, ownerId);
    const page = document.pages[0];
    const snapshotRecord = readPath(`drawing/snapshots/${page.snapshotId}`);
    delete snapshotRecord.snapshot;
    writePath(`drawing/snapshots/${page.snapshotId}`, snapshotRecord);

    assert.deepEqual((await drawing.getSnapshot(page.id, ownerId)).snapshot, { objects: [] });
});

test("prevents deleting the last page and supports page creation and reorder", async () => {
    const document = await drawing.createDocument({ name: "Diagrama" }, ownerId);
    const firstPageId = document.pages[0].id;
    await assert.rejects(drawing.deletePage(firstPageId, ownerId), { statusCode: 409 });
    await assert.rejects(drawing.createPage(document.id, { name: " " }, ownerId), { statusCode: 400 });
    assert.equal((await drawing.getDocument(document.id, ownerId)).pageCount, 1);

    const secondPage = await drawing.createPage(document.id, { name: "Alternativa" }, ownerId);
    const pages = await drawing.reorderPages(document.id, [secondPage.id, firstPageId], ownerId);
    assert.deepEqual(pages.map((page) => page.id), [secondPage.id, firstPageId]);
    assert.equal(await drawing.deletePage(firstPageId, ownerId), true);
});

test("duplicates a page with its snapshot and independent page identity", async () => {
    const document = await drawing.createDocument({ name: "Diagrama" }, ownerId);
    const original = document.pages[0];
    await drawing.saveSnapshot(original.id, {
        schemaVersion: 1,
        expectedVersion: 0,
        snapshot: { objects: [{ id: "shape-1", type: "ellipse", x: 5, y: 8, width: 80, height: 60 }] }
    }, ownerId);

    const duplicate = await drawing.duplicatePage(original.id, ownerId);
    assert.notEqual(duplicate.id, original.id);
    assert.equal(duplicate.position, 1);
    assert.deepEqual((await drawing.getSnapshot(duplicate.id, ownerId)).snapshot, {
        objects: [{ id: "shape-1", type: "ellipse", x: 5, y: 8, width: 80, height: 60 }]
    });
});

test("archives, duplicates, and lists only the authenticated user's documents", async () => {
    const document = await drawing.createDocument({ name: "Privada" }, ownerId);
    await drawing.setDocumentArchived(document.id, true, ownerId);
    assert.equal((await drawing.listDocuments(ownerId)).documents.length, 0);
    assert.equal((await drawing.listDocuments(ownerId, { includeArchived: "true" })).documents.length, 1);

    const duplicate = await drawing.duplicateDocument(document.id, ownerId);
    assert.equal(duplicate.pages.length, 1);
    assert.equal((await drawing.listDocuments(otherUserId)).documents.length, 0);
});

test("persists only validated per-user canvas preferences", async () => {
    const document = await drawing.createDocument({ name: "Preferencias" }, ownerId);
    const pageId = document.pages[0].id;
    await drawing.savePreferences(pageId, {
        cameraState: { x: 10, y: 20, zoom: 1.5 },
        gridEnabled: true,
        snapToGrid: false,
        background: "dots"
    }, ownerId);
    const savedPreferences = await drawing.getPreferences(pageId, ownerId);
    assert.equal(savedPreferences.cameraState.zoom, 1.5);
    await drawing.savePreferences(pageId, savedPreferences, ownerId);
    await assert.rejects(drawing.savePreferences(pageId, {
        cameraState: { x: 0, y: 0, zoom: 10 },
        gridEnabled: true,
        snapToGrid: false,
        background: "dots"
    }, ownerId), { statusCode: 400 });
    await assert.rejects(drawing.savePreferences(pageId, {
        cameraState: { x: 1e100, y: 0, zoom: 1 },
        gridEnabled: true,
        snapToGrid: false,
        background: "dots"
    }, ownerId), { statusCode: 400 });
});

test("rejects image MIME values that do not match the binary signature", async () => {
    assert.throws(() => drawing.validateAssetFile({
        buffer: Buffer.from("not a png"),
        size: 9,
        mimetype: "image/png",
        originalname: "drawing.png"
    }), { statusCode: 400 });
});
