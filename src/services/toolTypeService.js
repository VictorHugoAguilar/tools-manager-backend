const {
    get,
    push,
    ref,
    remove: removeValue,
    set
} = require("firebase/database");
const { getDatabaseInstance } = require("../config/database");

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

async function findAll() {
    const database = getDatabaseInstance();
    const snapshot = await get(ref(database, "toolTypes"));
    return serializeToolTypes(snapshot.val());
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

async function create(toolTypeData) {
    const database = getDatabaseInstance();
    const toolTypesRef = ref(database, "toolTypes");
    const newToolTypeRef = push(toolTypesRef);
    const toolType = {
        id: newToolTypeRef.key,
        ...toolTypeData
    };

    await set(newToolTypeRef, toolType);
    return toolType;
}

async function update(id, toolTypeData) {
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

async function remove(id) {
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
    create,
    update,
    remove
};
