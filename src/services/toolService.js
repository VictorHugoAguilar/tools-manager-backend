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
const { cache, cacheConfig } = require("../cache/sharedCache");
const { cacheKeys, CACHE_PREFIXES } = require("../cache/cacheKeys");

const PREFIX_LISTS = CACHE_PREFIXES.toolsList;
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

async function readAllTools() {
    const database = getDatabaseInstance();
    const snapshot = await get(ref(database, "tools"));
    return serializeToolsFromSnapshot(snapshot.val());
}

// Se cachea la colección base porque filtros, orden y paginación ya se aplican en memoria sobre ella:
// una sola entrada sirve a todas las consultas y evita claves por combinación de parámetros.
async function findAll(options = {}) {
    const tools = await cache.getOrLoad(cacheKeys.toolsAll(), readAllTools, cacheConfig.ttlMs.tools);
    const filteredTools = applyFilters(tools, options.filters);
    const sortedTools = applySorting(filteredTools, options.sorting);
    const pagination = options.pagination || { enabled: false };
    return applyPagination(sortedTools, pagination);
}

async function readToolById(id) {
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

// Los ids que no cumplen el formato de clave no se cachean y se consultan directamente.
async function findById(id) {
    if (!id || typeof id !== "string") {
        return null;
    }
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
        return readToolById(id);
    }

    const key = cacheKeys.toolDetail(id);
    const tool = await cache.getOrLoad(key, () => readToolById(id), cacheConfig.ttlMs.tools);
    // Las herramientas inexistentes no se cachean: otra instancia podría crearlas.
    if (tool === null) cache.invalidate(key);
    return tool;
}

// Las comprobaciones previas a una escritura leen siempre de Firebase, nunca de la caché.
const readExistingTool = readToolById;

// Invalida tras la escritura, también si falla, porque su resultado en Firebase puede ser incierto.
async function withInvalidation(id, write) {
    try {
        return await write();
    } finally {
        cache.invalidate(cacheKeys.toolsAll());
        cache.invalidatePrefix(PREFIX_LISTS);
        if (typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id)) cache.invalidate(cacheKeys.toolDetail(id));
    }
}

async function createTool(toolData, actorId) {
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
    const existingTool = await readExistingTool(id);

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

async function changeState(id, state, actorId) {
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
    const existingTool = await readExistingTool(id);

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

async function changeImageUrl(id, urlSrc, actorId) {
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
    const existingTool = await readExistingTool(id);

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

async function removeTool(id, actorId) {
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
    const existingTool = await readExistingTool(id);

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
    create: async (toolData, actorId) => {
        const created = await withInvalidation(null, () => createTool(toolData, actorId));
        // El id de una herramienta nueva solo se conoce tras crearla.
        if (created?.id) cache.invalidate(cacheKeys.toolDetail(created.id));
        return created;
    },
    update: (id, toolData, actorId) => withInvalidation(id, () => updateTool(id, toolData, actorId)),
    updateState: (id, state, actorId) => withInvalidation(id, () => changeState(id, state, actorId)),
    updateImageUrl: (id, urlSrc, actorId) => withInvalidation(id, () => changeImageUrl(id, urlSrc, actorId)),
    remove: (id, actorId) => withInvalidation(id, () => removeTool(id, actorId))
};
