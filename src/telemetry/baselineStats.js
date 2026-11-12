const { AsyncLocalStorage } = require("node:async_hooks");

const MAX_KEYS = 300;
const REPEAT_WINDOW_MS = 5000;

function emptyOperation() {
    return { count: 0, errors: 0, totalMs: 0, maxMs: 0, units: 0, repeated: 0 };
}

// Línea base en memoria: sin escrituras a Firestore, sin rutas con identificadores ni contenido de documentos.
class BaselineStats {
    constructor({ enabled = true, now = () => Date.now() } = {}) {
        this.enabled = enabled;
        this.now = now;
        this.storage = new AsyncLocalStorage();
        this.reset();
    }

    reset() {
        this.startedAt = this.now();
        this.operations = new Map();
        this.requests = new Map();
        this.lastRead = new Map();
        this.overflow = 0;
    }

    createContext() {
        return { rtdbReads: 0, rtdbWrites: 0, firestoreReads: 0, firestoreWrites: 0, dbMs: 0 };
    }

    run(context, callback) {
        return this.storage.run(context, callback);
    }

    entry(map, key, factory) {
        let value = map.get(key);
        if (!value) {
            if (map.size >= MAX_KEYS) {
                this.overflow += 1;
                key = "other";
                value = map.get(key);
            }
            if (!value) {
                value = factory();
                map.set(key, value);
            }
        }
        return value;
    }

    recordOperation(meta, durationMs, failed) {
        if (!this.enabled || !meta) return;
        const { source, kind, resource, scope } = meta;
        const units = Number.isFinite(meta.units) ? meta.units : (failed ? 0 : 1);
        const key = `${source}|${resource}|${kind}|${scope}`;
        const operation = this.entry(this.operations, key, emptyOperation);
        operation.count += 1;
        operation.units += units;
        operation.totalMs += durationMs;
        operation.maxMs = Math.max(operation.maxMs, durationMs);
        if (failed) operation.errors += 1;
        if (kind === "read") {
            const now = this.now();
            const last = this.lastRead.get(key);
            if (last !== undefined && now - last < REPEAT_WINDOW_MS) operation.repeated += 1;
            if (this.lastRead.size < MAX_KEYS || this.lastRead.has(key)) this.lastRead.set(key, now);
        }
        const context = this.storage.getStore();
        if (context) {
            const prefix = source === "firestore" ? "firestore" : "rtdb";
            if (kind === "read") context[`${prefix}Reads`] += units;
            else context[`${prefix}Writes`] += units;
            context.dbMs += durationMs;
        }
    }

    recordRequest(context, { method, route, statusCode, durationMs }) {
        if (!this.enabled || !context) return;
        const request = this.entry(this.requests, `${method} ${route}`, () => ({
            count: 0, errors: 0, totalMs: 0, maxMs: 0, dbMs: 0,
            rtdbReads: 0, rtdbWrites: 0, firestoreReads: 0, firestoreWrites: 0
        }));
        request.count += 1;
        request.totalMs += durationMs;
        request.maxMs = Math.max(request.maxMs, durationMs);
        if (statusCode >= 500) request.errors += 1;
        for (const field of ["dbMs", "rtdbReads", "rtdbWrites", "firestoreReads", "firestoreWrites"]) {
            request[field] += context[field];
        }
    }

    snapshot() {
        const round = (value) => Math.round(value * 100) / 100;
        const average = (total, count) => (count ? round(total / count) : null);
        const operations = [...this.operations].map(([key, value]) => {
            const [source, resource, kind, scope] = key.split("|");
            return {
                source, resource, kind, scope, count: value.count, errors: value.errors, units: value.units,
                repeatedWithin5s: value.repeated, averageMs: average(value.totalMs, value.count), maxMs: round(value.maxMs)
            };
        }).sort((a, b) => b.count - a.count);
        const requests = [...this.requests].map(([key, value]) => {
            const [method, ...route] = key.split(" ");
            return {
                method, route: route.join(" "), count: value.count, errors5xx: value.errors,
                averageMs: average(value.totalMs, value.count), maxMs: round(value.maxMs),
                rtdbReads: value.rtdbReads, rtdbWrites: value.rtdbWrites,
                firestoreReads: value.firestoreReads, firestoreWrites: value.firestoreWrites,
                rtdbReadsPerRequest: average(value.rtdbReads, value.count),
                databaseAverageMs: average(value.dbMs, value.count)
            };
        }).sort((a, b) => b.count - a.count);
        return {
            enabled: this.enabled,
            since: new Date(this.startedAt).toISOString(),
            elapsedSeconds: Math.round((this.now() - this.startedAt) / 1000),
            overflowedKeys: this.overflow,
            operations,
            requests
        };
    }
}

module.exports = { BaselineStats };
