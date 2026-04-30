const {
    get,
    push,
    ref,
    remove: removeValue,
    set
} = require("firebase/database");
const { getDatabaseInstance } = require("../config/database");

function sortRepairs(repairs) {
    return repairs.sort((left, right) => right.entryDate.localeCompare(left.entryDate));
}

function serializeRepairs(toolId, snapshotValue) {
    if (!snapshotValue) {
        return [];
    }

    return sortRepairs(
        Object.entries(snapshotValue).map(([id, repair]) => ({
            id,
            toolId,
            ...repair
        }))
    );
}

async function findAllByToolId(toolId) {
    if (!toolId || typeof toolId !== "string") {
        return [];
    }

    const database = getDatabaseInstance();
    const snapshot = await get(ref(database, `toolRepairs/${toolId}`));
    return serializeRepairs(toolId, snapshot.val());
}

async function findById(toolId, repairId) {
    if (!toolId || !repairId || typeof toolId !== "string" || typeof repairId !== "string") {
        return null;
    }

    const database = getDatabaseInstance();
    const snapshot = await get(ref(database, `toolRepairs/${toolId}/${repairId}`));

    if (!snapshot.exists()) {
        return null;
    }

    return {
        id: repairId,
        toolId,
        ...snapshot.val()
    };
}

async function create(toolId, repairData) {
    const database = getDatabaseInstance();
    const repairsRef = ref(database, `toolRepairs/${toolId}`);
    const newRepairRef = push(repairsRef);
    const repair = {
        id: newRepairRef.key,
        toolId,
        ...repairData
    };

    await set(newRepairRef, repair);
    return repair;
}

async function update(toolId, repairId, repairData) {
    const existing = await findById(toolId, repairId);

    if (!existing) {
        return null;
    }

    const database = getDatabaseInstance();
    const repair = {
        id: repairId,
        toolId,
        ...repairData
    };

    await set(ref(database, `toolRepairs/${toolId}/${repairId}`), repair);
    return repair;
}

async function remove(toolId, repairId) {
    const existing = await findById(toolId, repairId);

    if (!existing) {
        return false;
    }

    const database = getDatabaseInstance();
    await removeValue(ref(database, `toolRepairs/${toolId}/${repairId}`));
    return true;
}

module.exports = {
    findAllByToolId,
    findById,
    create,
    update,
    remove
};
