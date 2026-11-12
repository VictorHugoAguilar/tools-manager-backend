const { createHash } = require("node:crypto");

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const SENSITIVE = /token|password|secret|authorization|cookie|session|email|credential/i;

// Prefijos por dominio, para invalidar de forma selectiva con invalidatePrefix.
const PREFIX = Object.freeze({
    tools: "tools:",
    toolsList: "tools:list:",
    toolsAll: "tools:list:all",
    toolsDetail: "tools:detail:",
    workshop: "workshop:",
    workshopAll: "workshop:all",
    workshopSearch: "workshop:materials:search:",
    catalog: "catalog:"
});

const CATALOGS = Object.freeze(["tags", "locations", "tool-types", "technicians"]);

function normalize(value) {
    if (typeof value === "string") return value.trim().replace(/\s+/g, " ");
    if (typeof value === "number") {
        if (!Number.isFinite(value)) throw new TypeError("Parámetro de caché no válido.");
        return value;
    }
    if (typeof value === "boolean") return value;
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === "object") return normalizeParams(value);
    throw new TypeError("Parámetro de caché no válido.");
}

// Descarta vacíos y ordena las claves: el mismo conjunto de parámetros da siempre la misma serialización.
function normalizeParams(params = {}) {
    const result = {};
    for (const key of Object.keys(params).sort()) {
        if (SENSITIVE.test(key)) throw new TypeError("Un parámetro sensible no puede formar parte de una clave de caché.");
        const value = params[key];
        if (value === undefined || value === null || value === "") continue;
        const normalized = normalize(value);
        if (typeof normalized === "string" && normalized === "") continue;
        result[key] = normalized;
    }
    return result;
}

function hashParams(params) {
    return createHash("sha256").update(JSON.stringify(normalizeParams(params))).digest("hex").slice(0, 32);
}

function assertId(id) {
    if (typeof id !== "string" || !ID.test(id)) throw new TypeError("Identificador no válido para una clave de caché.");
    return id;
}

const cacheKeys = Object.freeze({
    toolsAll: () => PREFIX.toolsAll,
    toolsList: (params) => `${PREFIX.toolsList}${hashParams(params)}`,
    toolDetail: (id) => `${PREFIX.toolsDetail}${assertId(id)}`,
    workshopAll: () => PREFIX.workshopAll,
    workshopMaterialsSearch: (params) => `${PREFIX.workshopSearch}${hashParams(params)}`,
    catalog: (name) => {
        if (!CATALOGS.includes(name)) throw new TypeError("Catálogo desconocido.");
        return `${PREFIX.catalog}${name}`;
    }
});

module.exports = { cacheKeys, CACHE_PREFIXES: PREFIX, CATALOGS, normalizeParams };
