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

function serializeTechnicians(snapshotValue) {
    if (!snapshotValue) {
        return [];
    }

    return Object.entries(snapshotValue)
        .map(([id, technician]) => ({
            id,
            ...technician
        }))
        .sort((left, right) => left.name.localeCompare(right.name, undefined, {
            sensitivity: "base"
        }));
}

async function readAll() {
    const database = getDatabaseInstance();
    const snapshot = await get(ref(database, "technicians"));
    return serializeTechnicians(snapshot.val());
}

// Solo se cachea el listado completo; las lecturas por id y las comprobaciones previas a escribir van a Firebase.
async function findAll() {
    return cache.getOrLoad(cacheKeys.catalog("technicians"), readAll, cacheConfig.ttlMs.catalogs);
}

// Invalida tras la escritura, también si falla, porque su resultado en Firebase puede ser incierto.
async function withInvalidation(write) {
    try {
        return await write();
    } finally {
        cache.invalidate(cacheKeys.catalog("technicians"));
    }
}

async function findById(id) {
    if (!id || typeof id !== "string") {
        return null;
    }

    const database = getDatabaseInstance();
    const snapshot = await get(ref(database, `technicians/${id}`));

    if (!snapshot.exists()) {
        return null;
    }

    return {
        id,
        ...snapshot.val()
    };
}

async function createRecord(technicianData, actorId) {
    const database = getDatabaseInstance();
    const techniciansRef = ref(database, "technicians");
    const newTechnicianRef = push(techniciansRef);
    if (isCatalogAuditEnabled()) return createCatalogRecord("technicians", newTechnicianRef.key, technicianData, actorId);
    const technician = {
        id: newTechnicianRef.key,
        ...technicianData
    };

    await set(newTechnicianRef, technician);
    return technician;
}

async function updateRecord(id, technicianData, actorId) {
    if (isCatalogAuditEnabled()) return updateCatalogRecord("technicians", id, technicianData, actorId);
    const existing = await findById(id);

    if (!existing) {
        return null;
    }

    const database = getDatabaseInstance();
    const technician = {
        id,
        ...technicianData
    };

    await set(ref(database, `technicians/${id}`), technician);
    return technician;
}

async function removeRecord(id, actorId) {
    if (isCatalogAuditEnabled()) return removeCatalogRecord("technicians", id, actorId);
    const existing = await findById(id);

    if (!existing) {
        return false;
    }

    const database = getDatabaseInstance();
    await removeValue(ref(database, `technicians/${id}`));
    return true;
}

module.exports = {
    findAll,
    findById,
    create: (...args) => withInvalidation(() => createRecord(...args)),
    update: (...args) => withInvalidation(() => updateRecord(...args)),
    remove: (...args) => withInvalidation(() => removeRecord(...args))
};
