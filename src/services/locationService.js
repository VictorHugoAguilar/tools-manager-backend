const {
    get,
    push,
    ref,
    remove: removeValue,
    set
} = require("firebase/database");
const { getDatabaseInstance } = require("../config/database");
const { isCatalogAuditEnabled } = require("../audit/businessOutbox");
const { createCatalogRecord, updateCatalogRecord, removeCatalogRecord } = require("../audit/catalogAudit");

function serializeLocations(snapshotValue) {
    if (!snapshotValue) {
        return [];
    }

    return Object.entries(snapshotValue)
        .map(([id, location]) => ({
            id,
            ...location
        }))
        .sort((left, right) => left.name.localeCompare(right.name, undefined, {
            sensitivity: "base"
        }));
}

async function findAll() {
    const database = getDatabaseInstance();
    const snapshot = await get(ref(database, "locations"));
    return serializeLocations(snapshot.val());
}

async function findById(id) {
    if (!id || typeof id !== "string") {
        return null;
    }

    const database = getDatabaseInstance();
    const snapshot = await get(ref(database, `locations/${id}`));

    if (!snapshot.exists()) {
        return null;
    }

    return {
        id,
        ...snapshot.val()
    };
}

async function create(locationData, actorId) {
    const database = getDatabaseInstance();
    const locationsRef = ref(database, "locations");
    const newLocationRef = push(locationsRef);
    if (isCatalogAuditEnabled()) return createCatalogRecord("locations", newLocationRef.key, locationData, actorId);
    const location = {
        id: newLocationRef.key,
        ...locationData
    };

    await set(newLocationRef, location);
    return location;
}

async function update(id, locationData, actorId) {
    if (isCatalogAuditEnabled()) return updateCatalogRecord("locations", id, locationData, actorId);
    const existing = await findById(id);

    if (!existing) {
        return null;
    }

    const database = getDatabaseInstance();
    const location = {
        id,
        ...locationData
    };

    await set(ref(database, `locations/${id}`), location);
    return location;
}

async function remove(id, actorId) {
    if (isCatalogAuditEnabled()) return removeCatalogRecord("locations", id, actorId);
    const existing = await findById(id);

    if (!existing) {
        return false;
    }

    const database = getDatabaseInstance();
    await removeValue(ref(database, `locations/${id}`));
    return true;
}

module.exports = {
    findAll,
    findById,
    create,
    update,
    remove
};
