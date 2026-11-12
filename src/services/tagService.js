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
const { isCatalogAuditEnabled, transactCatalog } = require("../audit/businessOutbox");
const { removeCatalogRecord } = require("../audit/catalogAudit");

function normalizeName(value) {
    return String(value ?? "").trim().toLowerCase();
}

function serializeTags(snapshotValue) {
    if (!snapshotValue) {
        return [];
    }

    return Object.entries(snapshotValue)
        .map(([id, tag]) => ({
            id,
            ...tag
        }))
        .sort((left, right) => left.name.localeCompare(right.name, "es", {
            sensitivity: "base"
        }));
}

async function readAll() {
    const database = getDatabaseInstance();
    const snapshot = await get(ref(database, "tags"));
    return serializeTags(snapshot.val());
}

// Solo se cachea el listado completo; las lecturas por id y las comprobaciones previas a escribir van a Firebase.
async function findAll() {
    return cache.getOrLoad(cacheKeys.catalog("tags"), readAll, cacheConfig.ttlMs.catalogs);
}

// Invalida tras la escritura, también si falla, porque su resultado en Firebase puede ser incierto.
async function withInvalidation(write) {
    try {
        return await write();
    } finally {
        cache.invalidate(cacheKeys.catalog("tags"));
    }
}

async function findById(id) {
    if (!id || typeof id !== "string") {
        return null;
    }

    const database = getDatabaseInstance();
    const snapshot = await get(ref(database, `tags/${id}`));

    if (!snapshot.exists()) {
        return null;
    }

    return {
        id,
        ...snapshot.val()
    };
}

async function findByName(name) {
    const normalizedName = normalizeName(name);

    if (!normalizedName) {
        return null;
    }

    const tags = await readAll();
    return tags.find((tag) => normalizeName(tag.name) === normalizedName) ?? null;
}

async function createRecord(tagData, actorId) {
    if (isCatalogAuditEnabled()) {
        const newTagRef = push(ref(getDatabaseInstance(), "tags"));
        return transactCatalog({ id: newTagRef.key, actorId, collection: "tags", operation: "created",
            change: (current, tags) => {
                const name = normalizeName(tagData.name);
                const duplicate = name && serializeTags(tags).find((tag) => normalizeName(tag.name) === name);
                if (duplicate) return { unchanged: true, result: duplicate };
                if (current) throw Object.assign(new Error("El registro ya existe."), { statusCode: 409 });
                const value = { id: newTagRef.key, ...tagData };
                return { value, result: value };
            } });
    }
    const existing = await findByName(tagData.name);

    if (existing) {
        return existing;
    }

    const database = getDatabaseInstance();
    const tagsRef = ref(database, "tags");
    const newTagRef = push(tagsRef);
    const tag = {
        id: newTagRef.key,
        ...tagData
    };

    await set(newTagRef, tag);
    return tag;
}

async function updateRecord(id, tagData, actorId) {
    if (isCatalogAuditEnabled()) return transactCatalog({ id, actorId, collection: "tags", operation: "updated",
        change: (current, tags) => {
            if (!current) return null;
            const name = normalizeName(tagData.name);
            const duplicate = name && serializeTags(tags).find((tag) => normalizeName(tag.name) === name);
            if (duplicate && duplicate.id !== id) return { unchanged: true, result: { ...duplicate, duplicated: true } };
            const value = { id, ...tagData };
            return { value, result: value };
        } });
    const existing = await findById(id);

    if (!existing) {
        return null;
    }

    const duplicated = await findByName(tagData.name);

    if (duplicated && duplicated.id !== id) {
        return {
            ...duplicated,
            duplicated: true
        };
    }

    const database = getDatabaseInstance();
    const tag = {
        id,
        ...tagData
    };

    await set(ref(database, `tags/${id}`), tag);
    return tag;
}

async function removeRecord(id, actorId) {
    if (isCatalogAuditEnabled()) return removeCatalogRecord("tags", id, actorId);
    const existing = await findById(id);

    if (!existing) {
        return false;
    }

    const database = getDatabaseInstance();
    await removeValue(ref(database, `tags/${id}`));
    return true;
}

module.exports = {
    findAll,
    findById,
    findByName,
    create: (...args) => withInvalidation(() => createRecord(...args)),
    update: (...args) => withInvalidation(() => updateRecord(...args)),
    remove: (...args) => withInvalidation(() => removeRecord(...args))
};
