const {
    get,
    push,
    ref,
    remove: removeValue,
    set
} = require("firebase/database");
const { getDatabaseInstance } = require("../config/database");
const { isRepairAuditEnabled, transactRepair } = require("../audit/businessOutbox");

function auditedRepair(root, toolId, id, repairData) {
    if (!Object.hasOwn(root.tools || {}, toolId)) {
        throw Object.assign(new Error("Tool not found"), { statusCode: 404 });
    }
    const technician = Object.hasOwn(root.technicians || {}, repairData.technicianId)
        ? root.technicians[repairData.technicianId] : null;
    if (!technician) {
        throw Object.assign(new Error("technicianId does not reference an existing technician"), { statusCode: 400 });
    }
    return { id, toolId, ...repairData, technicianName: technician.name };
}

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

async function create(toolId, repairData, actorId) {
    const database = getDatabaseInstance();
    const repairsRef = ref(database, `toolRepairs/${toolId}`);
    const newRepairRef = push(repairsRef);
    if (isRepairAuditEnabled()) return transactRepair({
        id: newRepairRef.key, toolId, actorId, action: "repair.created",
        change: (existing, _repairs, root) => {
            if (existing) throw Object.assign(new Error("Repair already exists"), { statusCode: 409 });
            const repair = auditedRepair(root, toolId, newRepairRef.key, repairData);
            return { value: repair, result: repair };
        }
    });
    const repair = {
        id: newRepairRef.key,
        toolId,
        ...repairData
    };

    await set(newRepairRef, repair);
    return repair;
}

async function update(toolId, repairId, repairData, actorId) {
    if (isRepairAuditEnabled()) return transactRepair({
        id: repairId, toolId, actorId, action: "repair.updated",
        change: (existing, _repairs, root) => {
            if (!existing) return null;
            const repair = auditedRepair(root, toolId, repairId, repairData);
            return { value: repair, result: repair };
        }
    });
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

async function remove(toolId, repairId, actorId) {
    if (isRepairAuditEnabled()) return Boolean(await transactRepair({
        id: repairId, toolId, actorId, action: "repair.deleted",
        change: (existing) => existing ? { value: null, result: true } : null
    }));
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
