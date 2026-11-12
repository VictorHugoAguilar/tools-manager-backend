const {
    get,
    push,
    ref,
    remove: removeValue,
    set
} = require("firebase/database");
const { getDatabaseInstance } = require("../config/database");
const { cache, cacheConfig } = require("../cache/sharedCache");
const { cacheKeys } = require("../cache/cacheKeys");
const { isCatalogAuditEnabled } = require("../audit/businessOutbox");
const { createCatalogRecord, updateCatalogRecord, removeCatalogRecord } = require("../audit/catalogAudit");

function serializeToolTypes(snapshotValue) {
    if (!snapshotValue) {
        return [];
    }

    return Object.entries(snapshotValue)
        .map(([id, toolType]) => ({
            id,
            ...toolType
        }))
        .sort((left, right) => left.name.localeCompare(right.name, undefined, {
            sensitivity: "base"
        }));
}

async function readAll() {
    const database = getDatabaseInstance();
    const snapshot = await get(ref(database, "toolTypes"));
    return serializeToolTypes(snapshot.val());
}

// Solo se cachea el listado completo; las lecturas por id y las comprobaciones previas a escribir van a Firebase.
async function findAll() {
    return cache.getOrLoad(cacheKeys.catalog("tool-types"), readAll, cacheConfig.ttlMs.catalogs);
}

// Invalida tras la escritura, también si falla, porque su resultado en Firebase puede ser incierto.
async function withInvalidation(write) {
    try {
        return await write();
    } finally {
        cache.invalidate(cacheKeys.catalog("tool-types"));
    }
}

async function findById(id) {
    if (!id || typeof id !== "string") {
        return null;
    }

    const database = getDatabaseInstance();
    const snapshot = await get(ref(database, `toolTypes/${id}`));

    if (!snapshot.exists()) {
        return null;
    }

    return {
        id,
        ...snapshot.val()
    };
}

async function createRecord(toolTypeData, actorId) {
    const database = getDatabaseInstance();
    const toolTypesRef = ref(database, "toolTypes");
    const newToolTypeRef = push(toolTypesRef);
    if (isCatalogAuditEnabled()) return createCatalogRecord("toolTypes", newToolTypeRef.key, toolTypeData, actorId);
    const toolType = {
        id: newToolTypeRef.key,
        ...toolTypeData
    };

    await set(newToolTypeRef, toolType);
    return toolType;
}

async function updateRecord(id, toolTypeData, actorId) {
    if (isCatalogAuditEnabled()) return updateCatalogRecord("toolTypes", id, toolTypeData, actorId);
    const existing = await findById(id);

    if (!existing) {
        return null;
    }

    const database = getDatabaseInstance();
    const toolType = {
        id,
        ...toolTypeData
    };

    await set(ref(database, `toolTypes/${id}`), toolType);
    return toolType;
}

async function removeRecord(id, actorId) {
    if (isCatalogAuditEnabled()) return removeCatalogRecord("toolTypes", id, actorId);
    const existing = await findById(id);

    if (!existing) {
        return false;
    }

    const database = getDatabaseInstance();
    await removeValue(ref(database, `toolTypes/${id}`));
    return true;
}

module.exports = {
    findAll,
    findById,
    create: (...args) => withInvalidation(() => createRecord(...args)),
    update: (...args) => withInvalidation(() => updateRecord(...args)),
    remove: (...args) => withInvalidation(() => removeRecord(...args))
};
