const WRAPPED = Symbol.for("toolsManager.firestoreInstrumented");
const RESOURCE = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;

let recorder = null;
let depth = 0;

function setFirestoreRecorder(fn) {
    recorder = typeof fn === "function" ? fn : null;
}

function collectionOf(target) {
    const id = target?.parent?.id ?? target?._queryOptions?.collectionId ?? target?._query?._queryOptions?.collectionId;
    return typeof id === "string" && RESOURCE.test(id) ? id : "other";
}

function unitsOf(kind, result) {
    if (kind === "write") return Array.isArray(result) ? Math.max(1, result.length) : 1;
    return typeof result?.size === "number" ? Math.max(1, result.size) : 1;
}

function report(startedAt, failed, meta, result) {
    if (!recorder) return;
    try {
        recorder(Number(process.hrtime.bigint() - startedAt) / 1e6, failed, {
            ...meta, units: failed ? 0 : unitsOf(meta.kind, result)
        });
    } catch {
        // La telemetría nunca debe afectar a la operación.
    }
}

function wrap(original, kind) {
    if (typeof original !== "function" || original[WRAPPED]) return original;
    const wrapped = function instrumented(...args) {
        if (depth > 0 || !recorder) return original.apply(this, args);
        const startedAt = process.hrtime.bigint();
        const meta = { source: "firestore", kind, resource: collectionOf(this), scope: "item" };
        if (this?._queryOptions || this?._query) meta.scope = "collection";
        depth += 1;
        let result;
        try {
            result = original.apply(this, args);
        } catch (error) {
            report(startedAt, true, meta);
            throw error;
        } finally {
            depth -= 1;
        }
        if (result && typeof result.then === "function") {
            result.then((value) => report(startedAt, false, meta, value), () => report(startedAt, true, meta));
        } else {
            report(startedAt, false, meta, result);
        }
        return result;
    };
    Object.defineProperty(wrapped, WRAPPED, { value: true });
    return wrapped;
}

function patch(prototype, names) {
    for (const [name, kind] of Object.entries(names)) {
        if (prototype && typeof prototype[name] === "function") prototype[name] = wrap(prototype[name], kind);
    }
}

// Cuenta documentos leídos/escritos tal como los factura Firestore; no cubre oyentes en tiempo real.
function instrumentFirestore(classes) {
    const firestore = classes || {
        ...require("@google-cloud/firestore"),
        AggregateQuery: require("@google-cloud/firestore/build/src/reference/aggregate-query").AggregateQuery
    };
    patch(firestore.DocumentReference?.prototype, { get: "read", set: "write", create: "write", update: "write", delete: "write" });
    patch(firestore.Query?.prototype, { get: "read" });
    patch(firestore.WriteBatch?.prototype, { commit: "write" });
    patch(firestore.Transaction?.prototype, { get: "read" });
    patch(firestore.AggregateQuery?.prototype, { get: "read" });
}

module.exports = { instrumentFirestore, setFirestoreRecorder };
