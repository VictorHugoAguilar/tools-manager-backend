const { createHash, randomUUID } = require("node:crypto");
const { getAdminDatabase } = require("../config/firebaseAdmin");
const drawing = require("./drawingService");

const MAX_COLLABORATION_STATE_BYTES = 750 * 1024;
const CHECKPOINT_INTERVAL_MS = 5 * 60 * 1000;

function drawingRef(path = "") {
    const root = getAdminDatabase().ref("drawing");
    return path ? root.child(path) : root;
}

function snapshotFromDocument(document) {
    const objectMap = document.getMap("objects");
    const objects = [];
    objectMap.forEach((fields, id) => {
        if (!fields || typeof fields.toJSON !== "function") return;
        objects.push({ id, ...fields.toJSON() });
    });
    return { objects };
}

function hashSnapshot(snapshot) {
    return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

async function loadCollaborationDocument(documentId, pageId, document, Y) {
    const [pageSnapshot, drawingDocumentSnapshot, stateSnapshot] = await Promise.all([
        drawingRef(`pages/${pageId}`).get(),
        drawingRef(`documents/${documentId}`).get(),
        drawingRef(`collaborationStates/${documentId}/${pageId}`).get()
    ]);
    const page = pageSnapshot.val();
    if (!page || page.deletedAt || page.documentId !== documentId) {
        throw Object.assign(new Error("La página colaborativa no existe."), { statusCode: 404 });
    }
    const drawingDocument = drawingDocumentSnapshot.val();
    if (!drawingDocument || drawingDocument.deletedAt) {
        throw Object.assign(new Error("La pizarra colaborativa no existe."), { statusCode: 404 });
    }
    const state = stateSnapshot.val();
    if (state?.updateBase64) {
        const update = Buffer.from(state.updateBase64, "base64");
        if (!update.length || update.length > MAX_COLLABORATION_STATE_BYTES) {
            throw Object.assign(new Error("El estado colaborativo guardado no es válido."), { statusCode: 500 });
        }
        Y.applyUpdate(document, update);
        return { document, snapshot: state.snapshot, version: state.version || 0 };
    }

    const current = await drawing.getSnapshot(pageId, drawingDocument.ownerUserId);
    if (!current) throw Object.assign(new Error("No se pudo cargar el contenido de la página."), { statusCode: 404 });
    replaceYjsSnapshot(document, current.snapshot, Y);
    return { document, snapshot: current.snapshot, version: current.version };
}

function replaceYjsSnapshot(document, snapshot, Y) {
    const objects = document.getMap("objects");
    document.transact(() => {
        for (const id of Array.from(objects.keys())) objects.delete(id);
        for (const object of snapshot.objects) {
            const fields = new Y.Map();
            for (const [key, value] of Object.entries(object)) {
                if (key !== "id") fields.set(key, value);
            }
            objects.set(object.id, fields);
        }
    }, "drawing-server-bootstrap");
}

async function persistCollaborationDocument(documentId, pageId, document, Y, actorUserId) {
    const update = Y.encodeStateAsUpdate(document);
    if (!update.length || update.length > MAX_COLLABORATION_STATE_BYTES) {
        throw Object.assign(new Error("El estado colaborativo supera el límite de tamaño permitido."), {
            statusCode: 413
        });
    }
    const snapshot = snapshotFromDocument(document);
    const validated = drawing.validateSnapshot({
        schemaVersion: 1,
        expectedVersion: 0,
        snapshot
    });
    const now = new Date().toISOString();
    const stateRef = drawingRef(`collaborationStates/${documentId}/${pageId}`);
    const previousStateSnapshot = await stateRef.get();
    const previousState = previousStateSnapshot.val();
    await stateRef.update({
        schemaVersion: 1,
        updateBase64: Buffer.from(update).toString("base64"),
        snapshot: validated.snapshot,
        contentHash: validated.contentHash,
        updatedAt: now,
        updatedByUserId: actorUserId || null,
        version: previousState?.version || 0
    });

    let checkpointVersion = previousState?.version || 0;
    const lastCheckpointAt = Date.parse(previousState?.checkpointAt || "");
    if (!Number.isFinite(lastCheckpointAt) || Date.now() - lastCheckpointAt >= CHECKPOINT_INTERVAL_MS) {
        checkpointVersion = await createCheckpoint(
            documentId,
            pageId,
            validated.snapshot,
            validated.contentHash,
            actorUserId,
            now
        );
        if (checkpointVersion !== null) {
            await stateRef.update({ version: checkpointVersion, checkpointAt: now });
        } else {
            checkpointVersion = previousState?.version || 0;
        }
    }
    document.broadcastStateless(JSON.stringify({
        type: "drawing:persisted",
        stateVector: Buffer.from(Y.encodeStateVector(document)).toString("base64")
    }));
    return { contentHash: validated.contentHash, version: checkpointVersion };
}

async function createCheckpoint(documentId, pageId, snapshot, contentHash, actorUserId, now) {
    const pageRef = drawingRef(`pages/${pageId}`);
    const before = await pageRef.get();
    const previousPage = before.val();
    if (!previousPage || previousPage.deletedAt || previousPage.documentId !== documentId) {
        throw Object.assign(new Error("La página cambió o se eliminó durante el guardado colaborativo."), {
            statusCode: 409
        });
    }
    const snapshotId = randomUUID();
    const nextVersion = (Number(previousPage.version) || 0) + 1;
    await drawingRef(`snapshots/${snapshotId}`).set({
        pageId,
        version: nextVersion,
        schemaVersion: 1,
        snapshot,
        contentHash,
        createdAt: now,
        createdByUserId: actorUserId || previousPage.createdByUserId || "collaboration"
    });
    let conflict = false;
    const transaction = await pageRef.transaction((current) => {
        conflict = false;
        // Con la caché local vacía la transacción recibe null: se sustituye por la
        // lectura previa y Firebase reintenta con el valor real del servidor.
        if (current === null) current = structuredClone(previousPage);
        if (!current || current.deletedAt || current.documentId !== documentId ||
            current.version !== previousPage.version || current.snapshotId !== previousPage.snapshotId) {
            conflict = true;
            return;
        }
        current.version = nextVersion;
        current.schemaVersion = 1;
        current.snapshotId = snapshotId;
        current.updatedAt = now;
        return current;
    });
    if (!transaction.committed) {
        await drawingRef(`snapshots/${snapshotId}`).remove();
        if (conflict) return null;
        throw Object.assign(new Error("No se pudo crear el checkpoint colaborativo."), { statusCode: 409 });
    }
    await drawingRef().update({
        [`versionsByPage/${pageId}/${nextVersion}`]: {
            snapshotId,
            contentHash,
            createdAt: now,
            createdByUserId: actorUserId || "collaboration"
        },
        [`documents/${documentId}/updatedAt`]: now
    });
    return nextVersion;
}

module.exports = {
    CHECKPOINT_INTERVAL_MS,
    MAX_COLLABORATION_STATE_BYTES,
    loadCollaborationDocument,
    persistCollaborationDocument,
    replaceYjsSnapshot,
    snapshotFromDocument
};
