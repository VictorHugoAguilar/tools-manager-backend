const {
    get,
    push,
    ref,
    remove: removeValue,
    set
} = require("firebase/database");
const { getDatabaseInstance } = require("../config/database");

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

async function findAll() {
    const database = getDatabaseInstance();
    const snapshot = await get(ref(database, "technicians"));
    return serializeTechnicians(snapshot.val());
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

async function create(technicianData) {
    const database = getDatabaseInstance();
    const techniciansRef = ref(database, "technicians");
    const newTechnicianRef = push(techniciansRef);
    const technician = {
        id: newTechnicianRef.key,
        ...technicianData
    };

    await set(newTechnicianRef, technician);
    return technician;
}

async function update(id, technicianData) {
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

async function remove(id) {
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
    create,
    update,
    remove
};
