const {
    get,
    push,
    ref,
    remove: removeValue,
    set,
    update
} = require("firebase/database");
const { getDatabaseInstance } = require("../config/database");
const { deleteImageByUrl } = require("./toolImageStorageService");

function normalizeText(value) {
    return String(value).trim().toLowerCase();
}

function matchesTextFilter(sourceValue, filterValue) {
    return normalizeText(sourceValue).includes(normalizeText(filterValue));
}

function serializeToolsFromSnapshot(snapshotValue) {
    if (!snapshotValue) {
        return [];
    }

    return Object.entries(snapshotValue).map(([id, tool]) => ({
        id,
        ...tool
    }));
}

function applyFilters(tools, filters = {}) {
    return tools.filter((tool) => {
        if (filters.id && tool.id !== filters.id) {
            return false;
        }

        if (filters.name && !matchesTextFilter(tool.name, filters.name)) {
            return false;
        }

        if (filters.type && !matchesTextFilter(tool.type, filters.type)) {
            return false;
        }

        if (filters.category && !matchesTextFilter(tool.category, filters.category)) {
            return false;
        }

        if (
            filters.description &&
            !matchesTextFilter(tool.description, filters.description)
        ) {
            return false;
        }

        if (filters.urlSrc && !matchesTextFilter(tool.urlSrc, filters.urlSrc)) {
            return false;
        }

        if (filters.state && !matchesTextFilter(tool.state, filters.state)) {
            return false;
        }

        if (filters.material && !matchesTextFilter(tool.material, filters.material)) {
            return false;
        }

        if (filters.q) {
            const searchableFields = [
                tool.name,
                tool.type,
                tool.category,
                tool.description,
                tool.urlSrc,
                tool.state,
                tool.material
            ];

            const matchesQuery = searchableFields.some((field) =>
                matchesTextFilter(field, filters.q)
            );

            if (!matchesQuery) {
                return false;
            }
        }

        if (typeof filters.minLong === "number" && tool.long < filters.minLong) {
            return false;
        }

        if (typeof filters.maxLong === "number" && tool.long > filters.maxLong) {
            return false;
        }

        return true;
    });
}

function compareValues(left, right) {