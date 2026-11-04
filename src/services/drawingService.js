const { createHash, randomUUID } = require("node:crypto");
const { getAdminDatabase, getAdminApp } = require("../config/firebaseAdmin");
const { getStorage } = require("firebase-admin/storage");

const MAX_SNAPSHOT_BYTES = 750 * 1024;
const MAX_SNAPSHOT_OBJECTS = 2500;
const MAX_ASSET_SIZE = 10 * 1024 * 1024;
const EMPTY_SNAPSHOT_HASH = createHash("sha256").update(JSON.stringify({ objects: [] })).digest("hex");
const ALLOWED_ASSET_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const ALLOWED_OBJECT_TYPES = new Set(["rect", "ellipse", "diamond", "line", "arrow", "text", "freehand"]);
const COLOR_PATTERN = /^(#[0-9a-f]{6}|transparent)$/i;

function serviceError(message, statusCode = 400) {
    return Object.assign(new Error(message), { statusCode });
}

function drawingRef(path = "") {
    const root = getAdminDatabase().ref("drawing");
    return path ? root.child(path) : root;
}

function normalizeName(value, label = "El nombre") {
    if (typeof value !== "string" || !value.trim() || value.trim().length > 120) {
        throw serviceError(`${label} es obligatorio y no puede superar 120 caracteres.`);
    }
    return value.trim();
}

function normalizeDescription(value) {
    if (value === undefined || value === null) return "";
    if (typeof value !== "string" || value.length > 2000) {
        throw serviceError("La descripción no puede superar 2000 caracteres.");
    }
    return value.trim();
}

function validateSnapshot(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload) ||
        Object.keys(payload).some((key) => !["schemaVersion", "expectedVersion", "snapshot"].includes(key))) {
        throw serviceError("El snapshot no tiene un formato válido.");
    }
    if (payload.schemaVersion !== 1) {
        throw serviceError("La versión del formato del snapshot no es compatible.");
    }
    if (!Number.isSafeInteger(payload.expectedVersion) || payload.expectedVersion < 0) {
        throw serviceError("La versión esperada del snapshot no es válida.");
    }
    const snapshot = payload.snapshot;
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot) ||
        Object.keys(snapshot).some((key) => key !== "objects") || !Array.isArray(snapshot.objects) ||
        snapshot.objects.length > MAX_SNAPSHOT_OBJECTS) {
        throw serviceError("El contenido del snapshot no es válido.");
    }

    const objectIds = new Set();
    for (const object of snapshot.objects) {
        if (!object || typeof object !== "object" || Array.isArray(object) ||
            Object.keys(object).some((key) => ![
                "id", "type", "x", "y", "width", "height", "points", "fill", "stroke",
                "strokeWidth", "text", "fontSize", "rotation", "opacity"
            ].includes(key))) {
            throw serviceError("El snapshot contiene un objeto no válido.");
        }
        if (typeof object.id !== "string" || !object.id || object.id.length > 120 ||
            objectIds.has(object.id) || !ALLOWED_OBJECT_TYPES.has(object.type) ||
            !Number.isFinite(object.x) || !Number.isFinite(object.y)) {
            throw serviceError("El snapshot contiene un objeto no compatible.");
        }
        objectIds.add(object.id);
        for (const field of ["x", "y", "width", "height", "strokeWidth", "fontSize", "rotation", "opacity"]) {
            const value = object[field];
            const maximum = field === "fontSize" ? 512 :
                field === "strokeWidth" ? 100 :
                    ["width", "height"].includes(field) ? 1_000_000 :
                        ["x", "y"].includes(field) ? 10_000_000 :
                            field === "rotation" ? 3_600 : 1;
            if (value !== undefined && (!Number.isFinite(value) ||
                Math.abs(value) > maximum ||
                (["width", "height", "strokeWidth", "fontSize"].includes(field) && value < 0) ||
                (field === "opacity" && (value < 0 || value > 1)))) {
                throw serviceError("El snapshot contiene medidas no válidas.");
            }
        }
        if (object.fill !== undefined && (typeof object.fill !== "string" || !COLOR_PATTERN.test(object.fill))) {
            throw serviceError("El snapshot contiene un color de relleno no válido.");
        }
        if (object.stroke !== undefined && (typeof object.stroke !== "string" || !COLOR_PATTERN.test(object.stroke))) {
            throw serviceError("El snapshot contiene un color de línea no válido.");
        }
        if (object.text !== undefined && (typeof object.text !== "string" || object.text.length > 10000)) {
            throw serviceError("El texto del snapshot no es válido.");
        }
        if (object.points !== undefined &&
            (object.type !== "freehand" || !Array.isArray(object.points) ||
                object.points.length < 2 || object.points.length > 20000 ||
                object.points.length % 2 !== 0 ||
                object.points.some((point) => !Number.isFinite(point) || Math.abs(point) > 10_000_000))) {
            throw serviceError("El trazo del snapshot no es válido.");
        }
    }

    const serialized = JSON.stringify(snapshot);
    if (Buffer.byteLength(serialized, "utf8") > MAX_SNAPSHOT_BYTES) {
        throw serviceError("El snapshot supera el límite de tamaño permitido.");
    }
    return {
        snapshot,
        schemaVersion: payload.schemaVersion,
        expectedVersion: payload.expectedVersion,
        contentHash: createHash("sha256").update(serialized).digest("hex")
    };
}

async function getDocumentForUser(documentId, userId) {
    const snapshot = await drawingRef(`documents/${documentId}`).get();
    const document = snapshot.val();
    if (!document || document.deletedAt) return null;
    if (document.ownerUserId !== userId) throw serviceError("No tienes permiso para acceder a esta pizarra.", 403);
    return { id: documentId, ...document };
}

async function getPageForUser(pageId, userId) {
    const snapshot = await drawingRef(`pages/${pageId}`).get();
    const page = snapshot.val();
    if (!page || page.deletedAt) return null;
    const document = await getDocumentForUser(page.documentId, userId);
    if (!document) return null;
    return { id: pageId, ...page, document };
}

async function getPagesForDocument(documentId) {
    const index = await drawingRef(`pagesByDocument/${documentId}`).get();
    const ids = Object.keys(index.val() || {});
    if (!ids.length) return [];
    const pages = await Promise.all(ids.map(async (id) => {
        const snapshot = await drawingRef(`pages/${id}`).get();
        return snapshot.exists() ? { id, ...snapshot.val() } : null;
    }));
    return pages.filter((page) => page && !page.deletedAt)
        .sort((left, right) => left.position - right.position);
}

function initialSnapshot() {
    return { objects: [] };
}

function normalizeStoredSnapshot(value) {
    if (typeof value === "string") {
        try {
            return normalizeStoredSnapshot(JSON.parse(value));
        } catch {
            return null;
        }
    }
    if (Array.isArray(value)) {
        return value.every((object) => object && typeof object === "object" && !Array.isArray(object))
            ? { objects: value }
            : null;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const keys = Object.keys(value);
    if (keys.some((key) => key !== "objects")) return null;
    if (!Object.hasOwn(value, "objects")) {
        return keys.length === 0 ? initialSnapshot() : null;
    }

    const objects = value.objects;
    if (Array.isArray(objects)) return { objects };
    if (objects === null || (typeof objects === "object" && !Array.isArray(objects))) {
        const entries = Object.entries(objects || {});
        if (!entries.length) return initialSnapshot();
        const allNumericKeys = entries.every(([key]) => /^(0|[1-9]\d*)$/.test(key));
        entries.sort(([left], [right]) => allNumericKeys
            ? Number(left) - Number(right)
            : left.localeCompare(right));
        if (entries.some(([, object]) => !object || typeof object !== "object" || Array.isArray(object))) {
            return null;
        }
        return { objects: entries.map(([, object]) => object) };
    }
    return null;
}

function normalizeSnapshotRecord(record) {
    if (typeof record === "string") {
        try {
            return normalizeSnapshotRecord(JSON.parse(record));
        } catch {
            return null;
        }
    }
    if (Array.isArray(record)) return normalizeStoredSnapshot(record);
    if (!record || typeof record !== "object" || Array.isArray(record)) return null;
    const storedContent = Object.hasOwn(record, "snapshot") ? record.snapshot : record;
    const normalized = normalizeStoredSnapshot(storedContent);
    if (normalized) return normalized;
    if (record.contentHash === EMPTY_SNAPSHOT_HASH) return initialSnapshot();
    return null;
}

function snapshotRecordDiagnostic(record) {
    if (record === null) return { recordType: "null" };
    if (Array.isArray(record)) return { recordType: "array", recordLength: record.length };
    if (typeof record !== "object") return { recordType: typeof record };
    const snapshot = Object.hasOwn(record, "snapshot") ? record.snapshot : record;
    return {
        recordType: "object",
        recordKeys: Object.keys(record).sort(),
        snapshotType: Array.isArray(snapshot) ? "array" : typeof snapshot,
        snapshotKeys: snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)
            ? Object.keys(snapshot).sort()
            : undefined,
        objectsType: snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)
            ? Array.isArray(snapshot.objects) ? "array" : typeof snapshot.objects
            : undefined,
        objectEntryCount: snapshot?.objects && typeof snapshot.objects === "object"
            ? Object.keys(snapshot.objects).length
            : undefined,
        hasContentHash: typeof record.contentHash === "string"
    };
}

async function createDocument(payload, userId) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload) ||
        Object.keys(payload).some((key) => !["name", "description"].includes(key))) {
        throw serviceError("Los datos de la pizarra no son válidos.");
    }
    const name = normalizeName(payload.name);
    const description = normalizeDescription(payload.description);
    const now = new Date().toISOString();
    const documentId = randomUUID();
    const pageId = randomUUID();
    const snapshotId = randomUUID();
    const content = initialSnapshot();
    const contentHash = createHash("sha256").update(JSON.stringify(content)).digest("hex");
    const document = {
        name,
        description,
        ownerUserId: userId,
        isArchived: false,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        version: 1,
        pageCount: 1,
        nextPagePosition: 1,
        firstPageId: pageId
    };
    const page = {
        documentId,
        name: "Página 1",
        position: 0,
        createdAt: now,
        updatedAt: now,
        version: 0,
        schemaVersion: 1,
        snapshotId
    };
    const updates = {
        [`documents/${documentId}`]: document,
        [`pages/${pageId}`]: page,
        [`pagesByDocument/${documentId}/${pageId}`]: true,
        [`pagesByUser/${userId}/${pageId}`]: true,
        [`snapshots/${snapshotId}`]: { pageId, version: 0, schemaVersion: 1, snapshot: content, contentHash, createdAt: now, createdByUserId: userId },
        [`versionsByPage/${pageId}/0`]: { snapshotId, contentHash, createdAt: now, createdByUserId: userId },
        [`documentsByOwner/${userId}/${documentId}`]: true
    };
    await drawingRef().update(updates);
    return { id: documentId, ...document, pages: [{ id: pageId, ...page }] };
}

async function listDocuments(userId, options = {}) {
    const limit = Number(options.limit);
    const pageSize = Number.isSafeInteger(limit) ? Math.min(Math.max(limit, 1), 100) : 30;
    const search = typeof options.search === "string" ? options.search.trim().toLocaleLowerCase() : "";
    if (search.length > 120) throw serviceError("La búsqueda no puede superar 120 caracteres.");
    const indexSnapshot = await drawingRef(`documentsByOwner/${userId}`).get();
    const ids = Object.keys(indexSnapshot.val() || {});
    const documents = await Promise.all(ids.map(async (id) => {
        const snapshot = await drawingRef(`documents/${id}`).get();
        const document = snapshot.val();
        return document && !document.deletedAt
            ? { id, ...document }
            : null;
    }));
    const filtered = documents.filter((document) => document &&
        (options.includeArchived === "true" || !document.isArchived))
        .filter((document) => {
            return !search || `${document.name} ${document.description}`.toLocaleLowerCase().includes(search);
        })
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    const cursor = typeof options.cursor === "string" ? options.cursor : "";
    const cursorIndex = cursor ? filtered.findIndex((item) => item.id === cursor) : -1;
    if (cursor && cursorIndex < 0) throw serviceError("El cursor de paginación no es válido.");
    const start = cursor ? cursorIndex + 1 : 0;
    const items = filtered.slice(start, start + pageSize);
    return {
        documents: items,
        nextCursor: start + pageSize < filtered.length ? items.at(-1)?.id ?? null : null
    };
}

async function getDocument(documentId, userId) {
    const document = await getDocumentForUser(documentId, userId);
    if (!document) return null;
    return { ...document, pages: await getPagesForDocument(documentId) };
}

async function updateDocument(documentId, payload, userId) {
    const document = await getDocumentForUser(documentId, userId);
    if (!document) return null;
    if (!payload || typeof payload !== "object" || Array.isArray(payload) ||
        !Object.keys(payload).length ||
        Object.keys(payload).some((key) => !["name", "description"].includes(key))) {
        throw serviceError("Los datos de la pizarra no son válidos.");
    }
    const changes = { updatedAt: new Date().toISOString(), version: document.version + 1 };
    if (Object.hasOwn(payload, "name")) changes.name = normalizeName(payload.name);
    if (Object.hasOwn(payload, "description")) changes.description = normalizeDescription(payload.description);
    await drawingRef(`documents/${documentId}`).update(changes);
    return { ...document, ...changes };
}

async function setDocumentArchived(documentId, isArchived, userId) {
    const document = await getDocumentForUser(documentId, userId);
    if (!document) return null;
    if (typeof isArchived !== "boolean") throw serviceError("El estado de archivo no es válido.");
    const changes = { isArchived, updatedAt: new Date().toISOString(), version: document.version + 1 };
    await drawingRef(`documents/${documentId}`).update(changes);
    return { ...document, ...changes };
}

async function deleteDocument(documentId, userId) {
    const document = await getDocumentForUser(documentId, userId);
    if (!document) return false;
    const deletedAt = new Date().toISOString();
    await drawingRef().update({
        [`documents/${documentId}/deletedAt`]: deletedAt,
        [`documents/${documentId}/updatedAt`]: deletedAt,
        [`documents/${documentId}/version`]: document.version + 1,
        [`documentsByOwner/${userId}/${documentId}`]: null
    });
    return true;
}

async function duplicateDocument(documentId, userId) {
    const source = await getDocument(documentId, userId);
    if (!source) return null;
    const now = new Date().toISOString();
    const duplicateId = randomUUID();
    const pageCopies = source.pages.map((page, index) => ({ page, id: randomUUID(), snapshotId: randomUUID(), index }));
    const updates = {
        [`documents/${duplicateId}`]: {
            name: `${source.name} (copia)`.slice(0, 120),
            description: source.description,
            ownerUserId: userId,
            isArchived: false,
            createdAt: now,
            updatedAt: now,
            deletedAt: null,
            version: 1,
            pageCount: pageCopies.length,
            nextPagePosition: pageCopies.length,
            firstPageId: pageCopies[0]?.id ?? null
        },
        [`documentsByOwner/${userId}/${duplicateId}`]: true
    };
    for (const copy of pageCopies) {
        const original = copy.page;
        const snapshotRef = await drawingRef(`snapshots/${original.snapshotId}`).get();
        const originalSnapshot = snapshotRef.val();
        const content = normalizeSnapshotRecord(originalSnapshot);
        if (!content) throw serviceError("La página contiene un snapshot guardado no válido.", 500);
        const hash = originalSnapshot?.contentHash ??
            createHash("sha256").update(JSON.stringify(content)).digest("hex");
        const page = {
            documentId: duplicateId,
            name: original.name,
            position: copy.index,
            createdAt: now,
            updatedAt: now,
            version: 0,
            schemaVersion: 1,
            snapshotId: copy.snapshotId
        };
        updates[`pages/${copy.id}`] = page;
        updates[`pagesByDocument/${duplicateId}/${copy.id}`] = true;
        updates[`pagesByUser/${userId}/${copy.id}`] = true;
        updates[`snapshots/${copy.snapshotId}`] = {
            pageId: copy.id, version: 0, schemaVersion: 1, snapshot: content,
            contentHash: hash, createdAt: now, createdByUserId: userId
        };
        updates[`versionsByPage/${copy.id}/0`] = {
            snapshotId: copy.snapshotId, contentHash: hash, createdAt: now, createdByUserId: userId
        };
    }
    await drawingRef().update(updates);
    return getDocument(duplicateId, userId);
}

async function reservePagePosition(documentId, userId) {
    let pageLimitReached = false;
    let position = null;
    const transaction = await drawingRef(`documents/${documentId}`).transaction((document) => {
        pageLimitReached = false;
        position = null;
        if (!document || document.deletedAt || document.ownerUserId !== userId) return;
        const pageCount = Number(document.pageCount) || 0;
        if (pageCount >= 100) {
            pageLimitReached = true;
            return;
        }
        position = Number(document.nextPagePosition) || pageCount;
        document.pageCount = pageCount + 1;
        document.nextPagePosition = position + 1;
        document.version = (Number(document.version) || 0) + 1;
        document.updatedAt = new Date().toISOString();
        return document;
    });
    if (pageLimitReached) throw serviceError("La pizarra no puede tener más de 100 páginas.", 409);
    if (!transaction.committed) return null;
    return position;
}

async function releasePageReservation(documentId, userId) {
    await drawingRef(`documents/${documentId}`).transaction((document) => {
        if (!document || document.deletedAt || document.ownerUserId !== userId) return;
        document.pageCount = Math.max(1, (Number(document.pageCount) || 1) - 1);
        document.version = (Number(document.version) || 0) + 1;
        document.updatedAt = new Date().toISOString();
        return document;
    });
}

async function createPage(documentId, payload, userId) {
    const document = await getDocumentForUser(documentId, userId);
    if (!document) return null;
    if (!payload || typeof payload !== "object" || Array.isArray(payload) ||
        Object.keys(payload).some((key) => key !== "name")) {
        throw serviceError("Los datos de la página no son válidos.");
    }
    const name = normalizeName(payload.name, "El nombre de la página");
    const position = await reservePagePosition(documentId, userId);
    if (position === null) return null;
    const pageId = randomUUID();
    const snapshotId = randomUUID();
    const now = new Date().toISOString();
    const page = {
        documentId,
        name,
        position,
        createdAt: now,
        updatedAt: now,
        version: 0,
        schemaVersion: 1,
        snapshotId
    };
    const content = initialSnapshot();
    const contentHash = createHash("sha256").update(JSON.stringify(content)).digest("hex");
    try {
        await drawingRef().update({
            [`pages/${pageId}`]: page,
            [`pagesByDocument/${documentId}/${pageId}`]: true,
            [`pagesByUser/${userId}/${pageId}`]: true,
            [`snapshots/${snapshotId}`]: { pageId, version: 0, schemaVersion: 1, snapshot: content, contentHash, createdAt: now, createdByUserId: userId },
            [`versionsByPage/${pageId}/0`]: { snapshotId, contentHash, createdAt: now, createdByUserId: userId }
        });
    } catch (error) {
        await releasePageReservation(documentId, userId);
        throw error;
    }
    return { id: pageId, ...page };
}

async function duplicatePage(pageId, userId) {
    const source = await getPageForUser(pageId, userId);
    if (!source) return null;
    const sourceSnapshot = await drawingRef(`snapshots/${source.snapshotId}`).get();
    const original = sourceSnapshot.val();
    const snapshot = normalizeSnapshotRecord(original);
    if (!snapshot) throw serviceError("La página contiene un snapshot guardado no válido.", 500);
    const contentHash = original?.contentHash ?? createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
    const position = await reservePagePosition(source.documentId, userId);
    if (position === null) return null;
    const pageIdCopy = randomUUID();
    const snapshotId = randomUUID();
    const now = new Date().toISOString();
    const page = {
        documentId: source.documentId,
        name: `${source.name} (copia)`.slice(0, 120),
        position,
        createdAt: now,
        updatedAt: now,
        version: 0,
        schemaVersion: source.schemaVersion,
        snapshotId
    };
    try {
        await drawingRef().update({
            [`pages/${pageIdCopy}`]: page,
            [`pagesByDocument/${source.documentId}/${pageIdCopy}`]: true,
            [`pagesByUser/${userId}/${pageIdCopy}`]: true,
            [`snapshots/${snapshotId}`]: {
                pageId: pageIdCopy,
                version: 0,
                schemaVersion: source.schemaVersion,
                snapshot,
                contentHash,
                createdAt: now,
                createdByUserId: userId
            },
            [`versionsByPage/${pageIdCopy}/0`]: {
                snapshotId,
                contentHash,
                createdAt: now,
                createdByUserId: userId
            }
        });
    } catch (error) {
        await releasePageReservation(source.documentId, userId);
        throw error;
    }
    return { id: pageIdCopy, ...page };
}

async function updatePage(pageId, payload, userId) {
    const page = await getPageForUser(pageId, userId);
    if (!page) return null;
    if (!payload || typeof payload !== "object" || Array.isArray(payload) ||
        Object.keys(payload).length !== 1 || !Object.hasOwn(payload, "name")) {
        throw serviceError("Los datos de la página no son válidos.");
    }
    const changes = { name: normalizeName(payload.name, "El nombre de la página"), updatedAt: new Date().toISOString() };
    await drawingRef(`pages/${pageId}`).update(changes);
    return { id: pageId, documentId: page.documentId, ...page, ...changes };
}

async function deletePage(pageId, userId) {
    const page = await getPageForUser(pageId, userId);
    if (!page) return false;
    const documentRef = drawingRef(`documents/${page.documentId}`);
    let conflict = false;
    const transaction = await documentRef.transaction((current) => {
        conflict = false;
        if (!current || current.deletedAt || current.ownerUserId !== userId) return;
        if (Number(current.pageCount) <= 1) {
            conflict = true;
            return;
        }
        current.pageCount -= 1;
        current.version = (Number(current.version) || 0) + 1;
        current.updatedAt = new Date().toISOString();
        return current;
    });
    if (conflict) throw serviceError("Una pizarra debe conservar al menos una página.", 409);
    if (!transaction.committed) return false;
    const now = new Date().toISOString();
    try {
        await drawingRef().update({
            [`pages/${pageId}/deletedAt`]: now,
            [`pagesByDocument/${page.documentId}/${pageId}`]: null,
            [`pagesByUser/${userId}/${pageId}`]: null
        });
    } catch (error) {
        await drawingRef(`documents/${page.documentId}`).transaction((document) => {
            if (!document || document.deletedAt || document.ownerUserId !== userId) return;
            document.pageCount = (Number(document.pageCount) || 0) + 1;
            document.version = (Number(document.version) || 0) + 1;
            document.updatedAt = new Date().toISOString();
            return document;
        });
        throw error;
    }
    return true;
}

async function reorderPages(documentId, ids, userId) {
    const document = await getDocumentForUser(documentId, userId);
    if (!document) return null;
    const pages = await getPagesForDocument(documentId);
    if (!Array.isArray(ids) || ids.length !== pages.length ||
        new Set(ids).size !== pages.length ||
        ids.some((id) => !pages.some((page) => page.id === id))) {
        throw serviceError("El orden de las páginas no es válido.");
    }
    const updates = {};
    ids.forEach((id, position) => updates[`pages/${id}/position`] = position);
    await drawingRef().update(updates);
    return getPagesForDocument(documentId);
}

async function getSnapshot(pageId, userId) {
    const page = await getPageForUser(pageId, userId);
    if (!page) return null;
    const snapshot = await drawingRef(`snapshots/${page.snapshotId}`).get();
    if (!snapshot.exists()) {
        return { pageId, version: page.version, schemaVersion: 1, snapshot: initialSnapshot(), contentHash: "" };
    }
    const stored = snapshot.val();
    const normalized = normalizeSnapshotRecord(stored);
    if (!normalized) {
        console.error("Invalid drawing snapshot record", {
            pageId,
            snapshotId: page.snapshotId,
            ...snapshotRecordDiagnostic(stored)
        });
        throw serviceError("La página contiene un snapshot guardado no válido. Consulta el log del backend para ver su estructura.", 500);
    }
    return {
        pageId,
        ...stored,
        version: page.version,
        schemaVersion: stored.schemaVersion ?? page.schemaVersion ?? 1,
        snapshot: normalized
    };
}

async function saveSnapshot(pageId, payload, userId) {
    const page = await getPageForUser(pageId, userId);
    if (!page) return null;
    const validated = validateSnapshot(payload);
    if (validated.expectedVersion !== page.version) {
        throw serviceError("La pizarra ha cambiado desde que la abriste. Recarga para conservar los cambios más recientes.", 409);
    }
    const nextVersion = page.version + 1;
    const snapshotId = randomUUID();
    const now = new Date().toISOString();
    await drawingRef(`snapshots/${snapshotId}`).set({
        pageId,
        version: nextVersion,
        schemaVersion: validated.schemaVersion,
        snapshot: validated.snapshot,
        contentHash: validated.contentHash,
        createdAt: now,
        createdByUserId: userId
    });
    let conflict = false;
    let permissionLost = false;
    let transactionInput = null;
    const pageRef = drawingRef(`pages/${pageId}`);
    const transactionRead = await pageRef.once("value");
    if (!transactionRead.exists()) {
        await drawingRef(`snapshots/${snapshotId}`).remove();
        throw serviceError(
            "La página se eliminó antes de guardar. Recarga la pizarra para continuar.",
            409
        );
    }
    const pageAtTransactionStart = transactionRead.val();
    if (!pageAtTransactionStart || pageAtTransactionStart.deletedAt ||
        pageAtTransactionStart.documentId !== page.documentId) {
        await drawingRef(`snapshots/${snapshotId}`).remove();
        throw serviceError(
            "La página cambió o se eliminó antes de guardar. Recarga la pizarra para continuar.",
            409
        );
    }
    if (pageAtTransactionStart.version !== validated.expectedVersion) {
        await drawingRef(`snapshots/${snapshotId}`).remove();
        throw serviceError(
            "La pizarra ha cambiado desde que la abriste. Recarga para conservar los cambios más recientes.",
            409
        );
    }
    const transaction = await pageRef.transaction((current) => {
        conflict = false;
        permissionLost = false;
        transactionInput = current && typeof current === "object"
            ? {
                documentId: current.documentId ?? null,
                version: current.version ?? null,
                deletedAt: current.deletedAt ?? null
            }
            : current;
        if (current === null) current = { ...pageAtTransactionStart };
        if (!current || current.deletedAt || current.documentId !== page.documentId) {
            permissionLost = true;
            return;
        }
        if (current.version !== validated.expectedVersion) {
            conflict = true;
            return;
        }
        current.version = nextVersion;
        current.schemaVersion = validated.schemaVersion;
        current.snapshotId = snapshotId;
        current.updatedAt = now;
        return current;
    });
    if (!transaction.committed) {
        await drawingRef(`snapshots/${snapshotId}`).remove();
        if (permissionLost) {
            const currentPageSnapshot = await drawingRef(`pages/${pageId}`).get();
            const currentPage = currentPageSnapshot.val();
            console.error("Drawing page changed during snapshot save", {
                pageId,
                documentIdAtRead: page.documentId,
                documentIdAtCommit: currentPage?.documentId ?? null,
                pageExistsAtCommit: Boolean(currentPage),
                pageDeletedAtCommit: Boolean(currentPage?.deletedAt),
                transactionInput
            });
            throw serviceError(
                "La página cambió o se eliminó mientras se guardaban los cambios. Recarga la página antes de volver a guardar.",
                409
            );
        }
        if (conflict) throw serviceError("La página cambió mientras guardabas. Recarga para evitar sobrescribir cambios.", 409);
        throw serviceError("No se pudo guardar el snapshot.", 409);
    }
    try {
        await drawingRef().update({
            [`versionsByPage/${pageId}/${nextVersion}`]: {
                snapshotId,
                contentHash: validated.contentHash,
                createdAt: now,
                createdByUserId: userId
            },
            [`documents/${page.documentId}/updatedAt`]: now
        });
    } catch (error) {
        const rollback = await drawingRef(`pages/${pageId}`).transaction((current) => {
            if (!current || current.version !== nextVersion || current.snapshotId !== snapshotId) return;
            current.version = page.version;
            current.schemaVersion = page.schemaVersion;
            current.snapshotId = page.snapshotId;
            current.updatedAt = page.updatedAt;
            return current;
        });
        if (rollback.committed) await drawingRef(`snapshots/${snapshotId}`).remove();
        throw error;
    }
    return { pageId, version: nextVersion, schemaVersion: validated.schemaVersion, contentHash: validated.contentHash, updatedAt: now };
}

async function listVersions(pageId, userId) {
    const page = await getPageForUser(pageId, userId);
    if (!page) return null;
    const versionsSnapshot = await drawingRef(`versionsByPage/${pageId}`).get();
    const versions = Object.entries(versionsSnapshot.val() || {})
        .map(([version, value]) => ({ version: Number(version), ...value }));
    if (!versions.some((entry) => entry.version === page.version)) {
        const currentSnapshot = await drawingRef(`snapshots/${page.snapshotId}`).get();
        versions.push({
            version: page.version,
            snapshotId: page.snapshotId,
            contentHash: currentSnapshot.val()?.contentHash ?? "",
            createdAt: currentSnapshot.val()?.createdAt ?? page.updatedAt
        });
    }
    return versions
        .sort((left, right) => right.version - left.version);
}

async function getVersion(pageId, version, userId) {
    const page = await getPageForUser(pageId, userId);
    if (!page) return null;
    const normalizedVersion = String(version);
    if (!/^(0|[1-9]\d*)$/.test(normalizedVersion) ||
        !Number.isSafeInteger(Number(normalizedVersion))) {
        throw serviceError("La versión solicitada no es válida.");
    }
    const versionNumber = Number(normalizedVersion);
    if (versionNumber === page.version) {
        const currentSnapshot = await drawingRef(`snapshots/${page.snapshotId}`).get();
        if (currentSnapshot.exists()) {
            const stored = currentSnapshot.val();
            const normalized = normalizeSnapshotRecord(stored);
            if (!normalized) throw serviceError("La versión contiene un snapshot guardado no válido.", 500);
            return { pageId, version: versionNumber, ...stored, snapshot: normalized };
        }
    }
    const versionSnapshot = await drawingRef(`versionsByPage/${pageId}/${versionNumber}`).get();
    const versionEntry = versionSnapshot.val();
    if (!versionEntry) return null;
    const snapshot = await drawingRef(`snapshots/${versionEntry.snapshotId}`).get();
    if (!snapshot.exists()) return null;
    const stored = snapshot.val();
    const normalized = normalizeSnapshotRecord(stored);
    if (!normalized) throw serviceError("La versión contiene un snapshot guardado no válido.", 500);
    return { pageId, version: versionNumber, ...stored, snapshot: normalized };
}

async function restoreVersion(pageId, version, userId) {
    const historical = await getVersion(pageId, version, userId);
    if (!historical) return null;
    const page = await getPageForUser(pageId, userId);
    return saveSnapshot(pageId, {
        schemaVersion: historical.schemaVersion,
        expectedVersion: page.version,
        snapshot: historical.snapshot
    }, userId);
}

function validateAssetFile(file) {
    if (!file?.buffer || !Buffer.isBuffer(file.buffer)) throw serviceError("Selecciona una imagen.", 400);
    if (file.size > MAX_ASSET_SIZE) throw serviceError("La imagen supera el límite de 10 MB.", 413);
    if (!ALLOWED_ASSET_TYPES.has(file.mimetype)) throw serviceError("Solo se permiten imágenes PNG, JPEG o WebP.", 400);
    const bytes = file.buffer;
    const isPng = bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const isJpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    const isWebp = bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" &&
        bytes.toString("ascii", 8, 12) === "WEBP";
    if (!(file.mimetype === "image/png" && isPng) &&
        !(file.mimetype === "image/jpeg" && isJpeg) &&
        !(file.mimetype === "image/webp" && isWebp)) {
        throw serviceError("El contenido de la imagen no coincide con su tipo declarado.", 400);
    }
}

function safeFileName(name) {
    return String(name || "imagen").replace(/[^a-zA-Z0-9._-]/g, "-").slice(-120) || "imagen";
}

async function uploadAsset(documentId, pageId, file, userId) {
    const document = await getDocumentForUser(documentId, userId);
    if (!document) return null;
    if (pageId) {
        const page = await getPageForUser(pageId, userId);
        if (!page || page.documentId !== documentId) throw serviceError("La página no pertenece a esta pizarra.", 404);
    }
    validateAssetFile(file);
    const bucket = getStorage(getAdminApp()).bucket();
    if (!bucket.name) throw serviceError("Firebase Storage no está configurado.", 503);
    const id = randomUUID();
    const storageKey = `drawing/${documentId}/${id}-${safeFileName(file.originalname)}`;
    const storageFile = bucket.file(storageKey);
    await storageFile.save(file.buffer, {
        resumable: false,
        metadata: { contentType: file.mimetype, cacheControl: "private, no-store" }
    });
    const asset = {
        id,
        documentId,
        pageId: pageId || null,
        originalFileName: safeFileName(file.originalname),
        storageKey,
        contentType: file.mimetype,
        sizeBytes: file.size,
        uploadedByUserId: userId,
        createdAt: new Date().toISOString(),
        isDeleted: false
    };
    try {
        await drawingRef(`assets/${id}`).set(asset);
        await drawingRef(`assetsByDocument/${documentId}/${id}`).set(true);
    } catch (error) {
        await storageFile.delete({ ignoreNotFound: true });
        throw error;
    }
    const { storageKey: _storageKey, ...publicAsset } = asset;
    return publicAsset;
}

async function getAssetForUser(assetId, userId) {
    const assetSnapshot = await drawingRef(`assets/${assetId}`).get();
    const asset = assetSnapshot.val();
    if (!asset || asset.isDeleted) return null;
    const document = await getDocumentForUser(asset.documentId, userId);
    if (!document) return null;
    return asset;
}

async function streamAsset(assetId, userId) {
    const asset = await getAssetForUser(assetId, userId);
    if (!asset) return null;
    const bucket = getStorage(getAdminApp()).bucket();
    return { asset, stream: bucket.file(asset.storageKey).createReadStream() };
}

async function deleteAsset(assetId, userId) {
    const asset = await getAssetForUser(assetId, userId);
    if (!asset) return false;
    const now = new Date().toISOString();
    await drawingRef().update({
        [`assets/${assetId}/isDeleted`]: true,
        [`assets/${assetId}/deletedAt`]: now,
        [`assetsByDocument/${asset.documentId}/${assetId}`]: null
    });
    const bucket = getStorage(getAdminApp()).bucket();
    await bucket.file(asset.storageKey).delete({ ignoreNotFound: true });
    return true;
}

async function getPreferences(pageId, userId) {
    const page = await getPageForUser(pageId, userId);
    if (!page) return null;
    const snapshot = await drawingRef(`preferences/${pageId}/${userId}`).get();
    return snapshot.val() || {
        cameraState: { x: 0, y: 0, zoom: 1 },
        gridEnabled: true,
        snapToGrid: false,
        background: "dots"
    };
}

async function savePreferences(pageId, payload, userId) {
    const page = await getPageForUser(pageId, userId);
    if (!page) return null;
    const allowed = new Set(["cameraState", "gridEnabled", "snapToGrid", "background", "updatedAt"]);
    if (!payload || typeof payload !== "object" || Array.isArray(payload) ||
        Object.keys(payload).some((key) => !allowed.has(key))) {
        throw serviceError("Las preferencias no son válidas.");
    }
    if (payload.updatedAt !== undefined && typeof payload.updatedAt !== "string") {
        throw serviceError("Las preferencias no son válidas.");
    }
    const cameraState = payload.cameraState;
    if (!cameraState || typeof cameraState !== "object" ||
        !["x", "y", "zoom"].every((key) => Number.isFinite(cameraState[key])) ||
        Math.abs(cameraState.x) > 10_000_000 || Math.abs(cameraState.y) > 10_000_000 ||
        cameraState.zoom < 0.1 || cameraState.zoom > 4) {
        throw serviceError("La posición o el zoom del lienzo no son válidos.");
    }
    if (typeof payload.gridEnabled !== "boolean" || typeof payload.snapToGrid !== "boolean" ||
        !["dots", "lines", "none", "white", "cream"].includes(payload.background)) {
        throw serviceError("Las preferencias del lienzo no son válidas.");
    }
    const preferences = { cameraState, gridEnabled: payload.gridEnabled, snapToGrid: payload.snapToGrid, background: payload.background, updatedAt: new Date().toISOString() };
    await drawingRef(`preferences/${pageId}/${userId}`).set(preferences);
    return preferences;
}

module.exports = {
    ALLOWED_ASSET_TYPES,
    MAX_ASSET_SIZE,
    MAX_SNAPSHOT_BYTES,
    MAX_SNAPSHOT_OBJECTS,
    createDocument,
    createPage,
    deleteAsset,
    deleteDocument,
    deletePage,
    duplicateDocument,
    duplicatePage,
    getAssetForUser,
    getDocument,
    getPageForUser,
    getSnapshot,
    getVersion,
    getPreferences,
    listDocuments,
    listVersions,
    normalizeStoredSnapshot,
    normalizeSnapshotRecord,
    snapshotRecordDiagnostic,
    reorderPages,
    restoreVersion,
    savePreferences,
    saveSnapshot,
    setDocumentArchived,
    streamAsset,
    updateDocument,
    updatePage,
    uploadAsset,
    validateAssetFile,
    validateSnapshot
};
