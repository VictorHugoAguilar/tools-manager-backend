const {
    get,
    push,
    ref,
    remove: removeValue,
    set,
    update
} = require("firebase/database");
const { getDatabaseInstance } = require("../config/database");
const { cache, cacheConfig } = require("../cache/sharedCache");
const { cacheKeys, CACHE_PREFIXES } = require("../cache/cacheKeys");
const { isWorkshopStorageAuditEnabled, transactWorkshopStorage } = require("../audit/businessOutbox");

const COLLECTIONS = ["shelves", "levels", "organizers", "compartments", "materials"];
const PARENT_COLLECTIONS = {
    levels: { field: "shelfId", collection: "shelves" },
    organizers: { field: "levelId", collection: "levels" },
    compartments: { field: "organizerId", collection: "organizers" },
    materials: { field: "compartmentId", collection: "compartments" }
};
const CHILD_COLLECTIONS = {
    shelves: ["levels"],
    levels: ["organizers"],
    organizers: ["compartments"],
    compartments: ["materials"],
    materials: []
};

function createServiceError(message, statusCode = 400) {
    return Object.assign(new Error(message), { statusCode });
}

function collectionRef(collection) {
    if (!COLLECTIONS.includes(collection)) {
        throw createServiceError("Unknown workshop storage collection");
    }

    return ref(getDatabaseInstance(), `workshopStorage/${collection}`);
}

function serializeCollection(collection, snapshot) {
    const value = snapshot.val() || {};

    return Object.entries(value).map(([id, entity]) => ({
        id,
        ...entity,
        collection
    }));
}

async function findCollection(collection) {
    return serializeCollection(collection, await get(collectionRef(collection)));
}

async function findEntity(collection, id) {
    if (!id || typeof id !== "string") {
        return null;
    }

    const snapshot = await get(ref(getDatabaseInstance(), `workshopStorage/${collection}/${id}`));
    return snapshot.exists() ? { id, ...snapshot.val(), collection } : null;
}

async function readAll() {
    const entries = await Promise.all(COLLECTIONS.map(async (collection) => [
        collection,
        await findCollection(collection)
    ]));

    return Object.fromEntries(entries);
}

// Las cinco colecciones se cachean juntas porque forman una única instantánea lógica
// (las relaciones entre estante, nivel, organizador, hueco y material deben ser coherentes).
// searchMaterials trabaja en memoria sobre esa misma instantánea, por lo que no necesita claves propias.
async function findAll() {
    return cache.getOrLoad(cacheKeys.workshopAll(), readAll, cacheConfig.ttlMs.workshop);
}

// Invalida tras la escritura, también si falla, porque su resultado en Firebase puede ser incierto.
async function withInvalidation(write) {
    try {
        return await write();
    } finally {
        cache.invalidatePrefix(CACHE_PREFIXES.workshop);
    }
}

async function assertParentExists(collection, payload) {
    const parent = PARENT_COLLECTIONS[collection];

    if (parent) {
        const parentEntity = await findEntity(parent.collection, payload[parent.field]);
        if (!parentEntity) {
            throw createServiceError(`${parent.collection.slice(0, -1)} not found`, 404);
        }

        if (collection === "compartments" && Number(payload.column) > Number(parentEntity.columns || 1)) {
            throw createServiceError("column exceeds the organizer's configured layout", 400);
        }

        if (collection === "compartments") {
            const siblings = await findCollection("compartments");
            const positionAlreadyUsed = siblings.some((compartment) =>
                compartment.id !== payload.id &&
                compartment.organizerId === payload.organizerId &&
                compartment.row === Number(payload.row) &&
                compartment.column === Number(payload.column)
            );
            if (positionAlreadyUsed) {
                throw createServiceError("another compartment already occupies this grid position", 409);
            }
        }

        if (collection === "organizers") {
            assertOrganizerFitsLevel(payload, parentEntity);
        }
    }
}

function organizerFitsLevel(organizer, level) {
    const organizerHasDimensions = Number(organizer.width) > 0 && Number(organizer.depth) > 0;
    const levelHasDimensions = Number(level.width) > 0 && Number(level.depth) > 0;

    if (!organizerHasDimensions || !levelHasDimensions) {
        return true;
    }

    const fitsNormally = organizer.width <= level.width && organizer.depth <= level.depth;
    const fitsRotated = organizer.depth <= level.width && organizer.width <= level.depth;
    return fitsNormally || fitsRotated;
}

function assertOrganizerFitsLevel(organizer, level) {
    if (!organizerFitsLevel(organizer, level)) {
        throw createServiceError("Organizer dimensions do not fit on the selected shelf level", 400);
    }
}

function validateAuditedChange(collection, id, entity, storage) {
    const parent = PARENT_COLLECTIONS[collection];
    if (parent) {
        const parentEntity = storage[parent.collection]?.[entity[parent.field]];
        if (!parentEntity) throw createServiceError(`${parent.collection.slice(0, -1)} not found`, 404);
        if (collection === "compartments") {
            if (Number(entity.column) > Number(parentEntity.columns || 1)) {
                throw createServiceError("column exceeds the organizer's configured layout", 400);
            }
            if (Object.entries(storage.compartments || {}).some(([otherId, other]) =>
                otherId !== id && other.organizerId === entity.organizerId &&
                other.row === Number(entity.row) && other.column === Number(entity.column))) {
                throw createServiceError("another compartment already occupies this grid position", 409);
            }
        }
        if (collection === "organizers") assertOrganizerFitsLevel(entity, parentEntity);
    }
    if (collection === "levels" && Object.values(storage.organizers || {}).some((organizer) =>
        organizer.levelId === id && !organizerFitsLevel(organizer, entity))) {
        throw createServiceError("Organizer does not fit within the updated shelf level", 409);
    }
    if (collection === "organizers" && Object.values(storage.compartments || {}).some((compartment) =>
        compartment.organizerId === id && compartment.column > Number(entity.columns))) {
        throw createServiceError("Move the compartments into the new column layout before saving", 409);
    }
}

async function createEntity(collection, payload, actorId) {
    if (isWorkshopStorageAuditEnabled()) {
        const entityRef = push(collectionRef(collection));
        const now = new Date().toISOString();
        return transactWorkshopStorage({ id: entityRef.key, actorId, collection, action: "created",
            change: (existing, _entities, root) => {
                if (existing) throw createServiceError("Record already exists", 409);
                const entity = { ...payload, createdAt: now, updatedAt: now };
                validateAuditedChange(collection, entityRef.key, entity, root.workshopStorage || {});
                return { value: entity, result: { id: entityRef.key, ...entity, collection } };
            } });
    }
    await assertParentExists(collection, payload);
    const entityRef = push(collectionRef(collection));
    const entity = {
        ...payload,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };

    await set(entityRef, entity);
    return { id: entityRef.key, ...entity, collection };
}

async function writeEntity(collection, id, payload, actorId, action = "updated") {
    if (isWorkshopStorageAuditEnabled()) {
        const updatedAt = new Date().toISOString();
        return transactWorkshopStorage({ id, actorId, collection, action,
            change: (existing, _entities, root) => {
                if (!existing) return null;
                const entity = { ...existing, ...payload, updatedAt };
                validateAuditedChange(collection, id, entity, root.workshopStorage || {});
                return { value: entity, result: { id, ...entity, collection } };
            } });
    }
    const existing = await findEntity(collection, id);

    if (!existing) {
        return null;
    }

    await assertParentExists(collection, { ...existing, ...payload });
    if (collection === "levels" && (payload.width !== undefined || payload.depth !== undefined)) {
        const [organizers, levels] = await Promise.all([
            findCollection("organizers"),
            findCollection("levels")
        ]);
        const updatedLevel = { ...existing, ...payload };
        const incompatibleOrganizer = organizers.find((organizer) =>
            organizer.levelId === id && !organizerFitsLevel(organizer, updatedLevel)
        );
        if (incompatibleOrganizer) {
            throw createServiceError(
                `Organizer ${incompatibleOrganizer.name} does not fit within the updated shelf level`,
                409
            );
        }
    }
    if (collection === "organizers" && payload.columns !== undefined) {
        const compartments = await findCollection("compartments");
        const incompatible = compartments.some((compartment) =>
            compartment.organizerId === id && compartment.column > Number(payload.columns)
        );
        if (incompatible) {
            throw createServiceError("Move the compartments into the new column layout before saving", 409);
        }
    }
    const updates = {
        ...payload,
        updatedAt: new Date().toISOString()
    };

    await update(ref(getDatabaseInstance(), `workshopStorage/${collection}/${id}`), updates);
    return { ...existing, ...updates };
}

async function removeEntity(collection, id, actorId) {
    if (isWorkshopStorageAuditEnabled()) {
        return Boolean(await transactWorkshopStorage({ id, actorId, collection, action: "deleted",
            change: (existing, _entities, root) => {
                if (!existing) return null;
                const storage = root.workshopStorage || {};
                for (const childCollection of CHILD_COLLECTIONS[collection]) {
                    const parentField = PARENT_COLLECTIONS[childCollection].field;
                    if (Object.values(storage[childCollection] || {}).some((child) => child[parentField] === id)) {
                        throw createServiceError(`Remove or move its ${childCollection} before deleting this record`, 409);
                    }
                }
                return { value: null, result: true };
            } }));
    }
    const existing = await findEntity(collection, id);

    if (!existing) {
        return false;
    }

    for (const childCollection of CHILD_COLLECTIONS[collection]) {
        const children = await findCollection(childCollection);
        const parentField = PARENT_COLLECTIONS[childCollection].field;

        if (children.some((child) => child[parentField] === id)) {
            throw createServiceError(
                `Remove or move its ${childCollection} before deleting this record`,
                409
            );
        }
    }

    await removeValue(ref(getDatabaseInstance(), `workshopStorage/${collection}/${id}`));
    return true;
}

function normalizeSearchText(value) {
    return String(value ?? "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLocaleLowerCase("es");
}

async function searchMaterials(query) {
    const stopWords = new Set(["de", "del", "el", "la", "los", "las", "un", "una", "unos", "unas"]);
    const terms = normalizeSearchText(query)
        .replace(/[^\p{L}\p{N}.,×]+/gu, " ")
        .replace(/[.,×]+(?=\s|$)/g, " ")
        .trim()
        .split(/\s+/)
        .filter((term) => term && !stopWords.has(term));

    if (!terms.length) {
        return [];
    }

    const data = await findAll();
    const shelves = new Map(data.shelves.map((shelf) => [shelf.id, shelf]));
    const levels = new Map(data.levels.map((level) => [level.id, level]));
    const organizers = new Map(data.organizers.map((organizer) => [organizer.id, organizer]));
    const compartments = new Map(data.compartments.map((compartment) => [compartment.id, compartment]));

    return data.materials.flatMap((material) => {
        const compartment = compartments.get(material.compartmentId);
        const organizer = compartment && organizers.get(compartment.organizerId);
        const level = organizer && levels.get(organizer.levelId);
        const shelf = level && shelves.get(level.shelfId);

        if (!compartment || !organizer || !level || !shelf) {
            return [];
        }

        const searchableText = normalizeSearchText([
            material.name,
            material.category,
            material.reference,
            material.diameter,
            material.diameter != null ? `diametro ${material.diameter} mm ${material.diameter}mm` : "",
            material.length,
            material.length != null ? `longitud ${material.length} mm ${material.length}mm` : "",
            material.innerDiameter,
            material.innerDiameter != null ? `interior ${material.innerDiameter} mm ${material.innerDiameter}mm` : "",
            material.outerDiameter,
            material.outerDiameter != null ? `exterior ${material.outerDiameter} mm ${material.outerDiameter}mm` : "",
            material.material,
            material.headType,
            material.threadType,
            material.notes,
            compartment.name,
            organizer.name,
            level.name,
            shelf.name
        ].join(" "));
        const compactSearchText = searchableText.replace(/[\s×]/g, "");

        if (!terms.every((term) =>
            searchableText.includes(term) || compactSearchText.includes(term.replace(/[\s×]/g, ""))
        )) {
            return [];
        }

        return [{
            material,
            compartment,
            organizer,
            level,
            shelf
        }];
    });
}

const create = (collection, payload, actorId) => withInvalidation(() => createEntity(collection, payload, actorId));
const updateEntity = (collection, id, payload, actorId, action) =>
    withInvalidation(() => writeEntity(collection, id, payload, actorId, action));
const deleteEntity = (collection, id, actorId) => withInvalidation(() => removeEntity(collection, id, actorId));

module.exports = {
    COLLECTIONS,
    create,
    deleteEntity,
    findAll,
    findCollection,
    findEntity,
    organizerFitsLevel,
    searchMaterials,
    updateEntity
};
