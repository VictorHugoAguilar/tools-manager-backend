const DEFAULT_MAX_ENTRIES = 500;
const MIN_TTL_MS = 1000;
const MAX_TTL_MS = 10 * 60 * 1000;
const MAX_ENTRIES_LIMIT = 10000;

// Valores conservadores: unos segundos de retraso máximo en datos que cambian poco.
const DEFAULT_TTL_MS = Object.freeze({
    tools: 30 * 1000,
    workshop: 30 * 1000,
    catalogs: 60 * 1000
});

const TTL_ENV = Object.freeze({
    tools: "CACHE_TTL_TOOLS_MS",
    workshop: "CACHE_TTL_WORKSHOP_MS",
    catalogs: "CACHE_TTL_CATALOGS_MS"
});

function parseInteger(raw, { min, max, fallback }) {
    if (raw === undefined || raw === "") return fallback;
    const text = String(raw).trim();
    if (!/^\d+$/.test(text)) return fallback;
    const value = Number(text);
    return value >= min && value <= max ? value : fallback;
}

// La caché es opt-out: solo "false" la desactiva. Cualquier otro valor la deja activa.
function loadCacheConfig(env = process.env) {
    const ttlMs = {};
    for (const [domain, variable] of Object.entries(TTL_ENV)) {
        ttlMs[domain] = parseInteger(env[variable], { min: MIN_TTL_MS, max: MAX_TTL_MS, fallback: DEFAULT_TTL_MS[domain] });
    }
    return Object.freeze({
        enabled: String(env.CACHE_ENABLED ?? "true").trim().toLowerCase() !== "false",
        maxEntries: parseInteger(env.CACHE_MAX_ENTRIES, { min: 1, max: MAX_ENTRIES_LIMIT, fallback: DEFAULT_MAX_ENTRIES }),
        ttlMs: Object.freeze(ttlMs)
    });
}

module.exports = { loadCacheConfig, DEFAULT_TTL_MS, DEFAULT_MAX_ENTRIES, MIN_TTL_MS, MAX_TTL_MS, MAX_ENTRIES_LIMIT };
