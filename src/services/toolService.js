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
const { isToolAuditEnabled, transactTool } = require("../audit/businessOutbox");

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

        if (filters.serialNumber && !matchesTextFilter(tool.serialNumber, filters.serialNumber)) {
            return false;
        }

        if (filters.location && !matchesTextFilter(tool.location, filters.location)) {
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
                tool.material,
                tool.serialNumber,
                tool.location
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
    if (typeof left === "number" && typeof right === "number") {
        return left - right;
    }

    return String(left).localeCompare(String(right), undefined, {
        sensitivity: "base",
        numeric: true
    });
}

function applySorting(tools, sorting = {}) {
    if (!sorting.enabled) {
        return tools;
    }

    return [...tools].sort((leftTool, rightTool) => {
        const comparison = compareValues(
            leftTool[sorting.sortBy],
            rightTool[sorting.sortBy]
        );

        return sorting.sortOrder === "desc" ? comparison * -1 : comparison;
    });
}

function applyPagination(tools, pagination = {}) {
    if (!pagination.enabled) {
        return tools;
    }

    const startIndex = (pagination.page - 1) * pagination.limit;
    const items = tools.slice(startIndex, startIndex + pagination.limit);
    const totalItems = tools.length;
    const totalPages = totalItems === 0
        ? 0
        : Math.ceil(totalItems / pagination.limit);

    return {
        items,
        meta: {
            totalItems,
            totalPages,
            currentPage: pagination.page,
            limit: pagination.limit,
            hasNextPage: pagination.page < totalPages,
            hasPreviousPage: pagination.page > 1
        }
    };
}

async function findAll(options = {}) {
    const database = getDatabaseInstance();
    const snapshot = await get(ref(database, "tools"));
    const tools = serializeToolsFromSnapshot(snapshot.val());
    const filteredTools = applyFilters(tools, options.filters);
    const sortedTools = applySorting(filteredTools, options.sorting);
    const pagination = options.pagination || { enabled: false };
    return applyPagination(sortedTools, pagination);
}

async function findById(id) {
    if (!id || typeof id !== "string") {
        return null;
    }

    const database = getDatabaseInstance();
    const snapshot = await get(ref(database, `tools/${id}`));

    if (!snapshot.exists()) {
        return null;
    }

    return {
        id,
        ...snapshot.val()
    };
}

async function create(toolData, actorId) {
    const database = getDatabaseInstance();
    const toolsRef = ref(database, "tools");
    const newToolRef = push(toolsRef);
    const newTool = {
        id: newToolRef.key,
        ...toolData
    };

    if (isToolAuditEnabled()) {
        const created = await transactTool({
            id: newToolRef.key, actorId, action: "tool.created",
            change: (current) => current ? null : { value: newTool, result: newTool }
        });
        if (!created) throw new Error("No se pudo crear la herramienta auditada.");
        return created;
    }
    await set(newToolRef, newTool);
    return newTool;
}

async function updateTool(id, toolData, actorId) {
    if (!id || typeof id !== "string") {
        return null;
    }

    if (isToolAuditEnabled()) {
        const updatedTool = { ...toolData, id };
        return transactTool({
            id, actorId, action: "tool.updated",
            change: (current) => current ? { value: updatedTool, result: updatedTool } : null
        });
    }
    const existingTool = await findById(id);

    if (!existingTool) {
        return null;
    }

    const database = getDatabaseInstance();
    const updatedTool = {
        ...toolData,
        id
    };

    await set(ref(database, `tools/${id}`), updatedTool);
    return updatedTool;
}

async function updateState(id, state, actorId) {
    if (!id || typeof id !== "string") {
        return null;
    }

    if (isToolAuditEnabled()) {
        return transactTool({
            id, actorId, action: "tool.state.updated",
            change: (current) => {
                if (!current) return null;
                const updated = { ...current, id, state };
                return { value: updated, result: updated };
            }
        });
    }
    const existingTool = await findById(id);

    if (!existingTool) {
        return null;
    }

    const database = getDatabaseInstance();
    await update(ref(database, `tools/${id}`), { state });

    return {
        ...existingTool,
        state
    };
}

async function updateImageUrl(id, urlSrc, actorId) {
    if (!id || typeof id !== "string") {
        return null;
    }

    if (isToolAuditEnabled()) {
        return transactTool({
            id, actorId, action: "tool.image.updated",
            change: (current) => {
                if (!current) return null;
                const updated = { ...current, id, urlSrc };
                return { value: updated, result: updated };
            }
        });
    }
    const existingTool = await findById(id);

    if (!existingTool) {
        return null;
    }

    const database = getDatabaseInstance();
    await update(ref(database, `tools/${id}`), { urlSrc });

    return {
        ...existingTool,
        urlSrc
    };
}

async function remove(id, actorId) {
    if (!id || typeof id !== "string") {
        return false;
    }

    if (isToolAuditEnabled()) {
        const removed = await transactTool({
            id, actorId, action: "tool.deleted",
            change: (current) => current ? { value: null, result: current } : null
        });
        if (!removed) return false;
        await deleteImageByUrl(removed.urlSrc);
        return true;
    }
    const existingTool = await findById(id);

    if (!existingTool) {
        return false;
    }

    const database = getDatabaseInstance();
    await removeValue(ref(database, `tools/${id}`));
    await deleteImageByUrl(existingTool.urlSrc);
    return true;
}

module.exports = {
    findAll,
    findById,
    create,
    update: updateTool,
    updateState,
    updateImageUrl,
    remove
};
