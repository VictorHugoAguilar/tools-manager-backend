const DEFAULT_MAX_ENTRIES = 500;

function assertKey(key) {
    if (typeof key !== "string" || key.length === 0) {
        throw new TypeError("La clave de caché debe ser un texto no vacío.");
    }
}

function assertTtl(ttlMs) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
        throw new RangeError("El TTL debe ser un número positivo en milisegundos.");
    }
}

// Los valores se copian al guardar y al devolver para que mutar un resultado no altere la caché.
function isolate(value) {
    return value === undefined ? value : structuredClone(value);
}

class CacheService {
    constructor({ enabled = true, maxEntries = DEFAULT_MAX_ENTRIES, now = () => Date.now() } = {}) {
        if (!Number.isInteger(maxEntries) || maxEntries < 1) {
            throw new RangeError("maxEntries debe ser un entero positivo.");
        }
        this.enabled = Boolean(enabled);
        this.maxEntries = maxEntries;
        this.now = now;
        this.entries = new Map(); // el orden de inserción actúa como LRU: el primero es el menos usado
        this.loads = new Map(); // clave -> carga en curso; invalidar la elimina para que su resultado no se guarde
        this.counters = { hits: 0, misses: 0, loads: 0, errors: 0, expirations: 0, invalidations: 0, evictions: 0 };
    }

    get(key) {
        assertKey(key);
        if (!this.enabled) return undefined;
        const entry = this.entries.get(key);
        if (!entry) {
            this.counters.misses += 1;
            return undefined;
        }
        if (entry.expiresAt <= this.now()) {
            this.entries.delete(key);
            this.counters.expirations += 1;
            this.counters.misses += 1;
            return undefined;
        }
        this.entries.delete(key);
        this.entries.set(key, entry);
        this.counters.hits += 1;
        return isolate(entry.value);
    }

    set(key, value, ttlMs) {
        assertKey(key);
        assertTtl(ttlMs);
        if (!this.enabled) return;
        this.store(key, value, ttlMs);
    }

    store(key, value, ttlMs) {
        this.entries.delete(key);
        this.purgeExpired();
        while (this.entries.size >= this.maxEntries) {
            this.entries.delete(this.entries.keys().next().value);
            this.counters.evictions += 1;
        }
        this.entries.set(key, { value: isolate(value), expiresAt: this.now() + ttlMs });
    }

    purgeExpired() {
        if (this.entries.size < this.maxEntries) return;
        const now = this.now();
        for (const [key, entry] of this.entries) {
            if (entry.expiresAt <= now) {
                this.entries.delete(key);
                this.counters.expirations += 1;
            }
        }
    }

    async getOrLoad(key, loader, ttlMs) {
        assertKey(key);
        assertTtl(ttlMs);
        if (typeof loader !== "function") throw new TypeError("El loader debe ser una función.");
        if (!this.enabled) return loader();

        const cached = this.get(key);
        if (cached !== undefined) return cached;

        let load = this.loads.get(key);
        if (!load) {
            load = { promise: null };
            this.loads.set(key, load);
            this.counters.loads += 1;
            load.promise = (async () => loader())().then(
                (value) => {
                    // Solo se guarda si nadie invalidó la clave mientras se cargaba.
                    if (this.loads.get(key) === load) {
                        this.loads.delete(key);
                        this.store(key, value, ttlMs);
                    }
                    return value;
                },
                (error) => {
                    if (this.loads.get(key) === load) this.loads.delete(key);
                    this.counters.errors += 1;
                    throw error;
                }
            );
        }
        return isolate(await load.promise);
    }

    invalidate(key) {
        assertKey(key);
        const removed = this.entries.delete(key);
        const pending = this.loads.delete(key);
        if (removed || pending) this.counters.invalidations += 1;
        return removed || pending;
    }

    invalidatePrefix(prefix) {
        assertKey(prefix);
        let count = 0;
        for (const key of [...this.entries.keys()]) {
            if (key.startsWith(prefix)) {
                this.entries.delete(key);
                count += 1;
            }
        }
        for (const key of [...this.loads.keys()]) {
            if (key.startsWith(prefix)) {
                this.loads.delete(key);
                count += 1;
            }
        }
        this.counters.invalidations += count;
        return count;
    }

    clear() {
        const count = this.entries.size + this.loads.size;
        this.entries.clear();
        this.loads.clear();
        this.counters.invalidations += count;
    }

    stats() {
        return { enabled: this.enabled, size: this.entries.size, maxEntries: this.maxEntries, ...this.counters };
    }
}

module.exports = { CacheService, DEFAULT_MAX_ENTRIES };
