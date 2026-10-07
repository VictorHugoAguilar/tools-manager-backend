const {
    get,
    push,
    ref,
    remove: removeValue,
    set
} = require("firebase/database");
const { getDatabaseInstance } = require("../config/database");

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

async function findAll() {
    const database = getDatabaseInstance();
    const snapshot = await get(ref(database, "tags"));
    return serializeTags(snapshot.val());
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

    const tags = await findAll();
    return tags.find((tag) => normalizeName(tag.name) === normalizedName) ?? null;
}

async function create(tagData) {
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

async function update(id, tagData) {
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

async function remove(id) {
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
    create,
    update,
    remove
};
