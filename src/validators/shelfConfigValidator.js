const MIN_SHELF_DIMENSION = 1;
const MAX_SHELF_DIMENSION = 10;
const DEFAULT_SHELF_CONFIG = Object.freeze({
    rows: 5,
    columns: 6
});

function isShelfDimension(value) {
    return Number.isInteger(value)
        && value >= MIN_SHELF_DIMENSION
        && value <= MAX_SHELF_DIMENSION;
}

function defaultShelfConfig() {
    return {
        rows: DEFAULT_SHELF_CONFIG.rows,
        columns: DEFAULT_SHELF_CONFIG.columns
    };
}

function normalizeStoredShelfConfig(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return defaultShelfConfig();
    }

    if (!isShelfDimension(value.rows) || !isShelfDimension(value.columns)) {
        return defaultShelfConfig();
    }

    return {
        rows: value.rows,
        columns: value.columns
    };
}

function validateShelfConfigPayload(payload) {
    const errors = [];

    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        return {
            isValid: false,
            errors: ["Body must be a valid JSON object"],
            data: null
        };
    }

    if (!isShelfDimension(payload.rows)) {
        errors.push(
            `rows must be an integer between ${MIN_SHELF_DIMENSION} and ${MAX_SHELF_DIMENSION}`
        );
    }

    if (!isShelfDimension(payload.columns)) {
        errors.push(
            `columns must be an integer between ${MIN_SHELF_DIMENSION} and ${MAX_SHELF_DIMENSION}`
        );
    }

    return {
        isValid: errors.length === 0,
        errors,
        data: errors.length === 0
            ? { rows: payload.rows, columns: payload.columns }
            : null
    };
}

module.exports = {
    DEFAULT_SHELF_CONFIG,
    MAX_SHELF_DIMENSION,
    normalizeStoredShelfConfig,
    validateShelfConfigPayload
};

