const { get, ref, set } = require("firebase/database");
const { getDatabaseInstance } = require("../config/database");
const {
    normalizeStoredShelfConfig
} = require("../validators/shelfConfigValidator");

class ShelfConfigConflictError extends Error {
    constructor(message) {
        super(message);
        this.name = "ShelfConfigConflictError";
        this.code = "SHELF_CONFIG_CONFLICT";
    }
}

function getPosition(value) {
    return Number.isInteger(value) && value >= 1 ? value : 1;
}

function findOutOfBoundsBox(storageBoxes, config) {
    if (!storageBoxes || typeof storageBoxes !== "object") {
        return null;
    }

    for (const [id, box] of Object.entries(storageBoxes)) {
        const row = getPosition(box?.shelfRow);
        const column = getPosition(box?.shelfColumn);
        const boxIdentifier = box?.code || id;

        if (row > config.rows) {
            return {
                boxIdentifier,
                dimension: "row",
                position: row
            };
        }

        if (column > config.columns) {
            return {
                boxIdentifier,
                dimension: "column",
                position: column
            };
        }
    }

    return null;
}

async function getShelfConfig() {
    const database = getDatabaseInstance();
    const snapshot = await get(ref(database, "shelfConfig"));

    return normalizeStoredShelfConfig(
        snapshot.exists() ? snapshot.val() : undefined
    );
}

async function updateShelfConfig(config) {
    const database = getDatabaseInstance();
    const storageBoxesSnapshot = await get(ref(database, "storageBoxes"));
    const storageBoxes = storageBoxesSnapshot.exists()
        ? storageBoxesSnapshot.val()
        : {};
    const conflict = findOutOfBoundsBox(storageBoxes, config);

    if (conflict) {
        const positionLabel = conflict.dimension === "row"
            ? "Fila"
            : "Columna";
        const limit = conflict.dimension === "row"
            ? config.rows
            : config.columns;

        throw new ShelfConfigConflictError(
            `No se puede guardar la configuración: la caja ${conflict.boxIdentifier} está en ${positionLabel} ${conflict.position}, fuera del máximo de ${limit}.`
        );
    }

    const value = {
        rows: config.rows,
        columns: config.columns
    };

    await set(ref(database, "shelfConfig"), value);
    return value;
}

module.exports = {
    ShelfConfigConflictError,
    getShelfConfig,
    updateShelfConfig
};
