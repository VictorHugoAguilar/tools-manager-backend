const WRAPPED = Symbol.for("toolsManager.databaseInstrumented");
const CLIENT_OPERATIONS = ["get", "set", "update", "remove", "runTransaction"];
const ADMIN_QUERY_OPERATIONS = ["get", "once"];
const ADMIN_REFERENCE_OPERATIONS = ["set", "update", "remove", "transaction"];
const READ_OPERATIONS = new Set(["get", "once"]);
const RESOURCE = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;

let recorder = null;
let depth = 0;

// Solo se registran duración y éxito; nunca rutas, valores ni identificadores.
function setDatabaseRecorder(fn) {
    recorder = typeof fn === "function" ? fn : null;
}

// Solo el nombre fijo de la colección (y el subárbol de workshopStorage), nunca identificadores ni valores.
function describeOperation(name, target, args, refIsFirstArgument) {
    const kind = READ_OPERATIONS.has(name) ? "read" : name === "runTransaction" || name === "transaction" ? "transaction" : "write";
    let resource = "other";
    let scope = "item";
    try {
        const source = refIsFirstArgument ? args[0] : target;
        const raw = String(source?._path ?? source?.ref?._path ?? source?.toString?.() ?? "");
        const segments = raw.replace(/^https?:\/\/[^/]+/, "").split("?")[0].split("/").filter(Boolean);
        if (segments[0] && RESOURCE.test(segments[0])) {
            const nested = segments[0] === "workshopStorage" && segments[1] && RESOURCE.test(segments[1]);
            resource = nested ? `${segments[0]}/${segments[1]}` : segments[0];
            scope = segments.length <= (nested ? 2 : 1) ? "collection" : "item";
        }
    } catch {
        // Si no se puede describir, la operación se cuenta como «other».
    }
    return { source: "rtdb", kind, resource, scope };
}

function report(startedAt, failed, meta) {
    if (!recorder) return;
    try {
        recorder(Number(process.hrtime.bigint() - startedAt) / 1e6, failed, meta);
    } catch {
        // La telemetría nunca debe afectar a la operación.
    }
}

function wrap(original, name, refIsFirstArgument) {
    if (typeof original !== "function" || original[WRAPPED]) return original;
    const wrapped = function instrumented(...args) {
        if (depth > 0) return original.apply(this, args);
        const startedAt = process.hrtime.bigint();
        const meta = recorder ? describeOperation(name, this, args, refIsFirstArgument) : undefined;
        let result;
        depth += 1;
        try {
            result = original.apply(this, args);
        } catch (error) {
            report(startedAt, true, meta);
            throw error;
        } finally {
            depth -= 1;
        }
        if (result && typeof result.then === "function") {
            result.then(() => report(startedAt, false, meta), () => report(startedAt, true, meta));
        } else {
            report(startedAt, false, meta);
        }
        return result;
    };
    Object.defineProperty(wrapped, WRAPPED, { value: true });
    return wrapped;
}

function patchObject(target, names, refIsFirstArgument = false) {
    for (const name of names) {
        if (typeof target[name] === "function") target[name] = wrap(target[name], name, refIsFirstArgument);
    }
}

function instrumentClientSdk() {
    patchObject(require("@firebase/database"), CLIENT_OPERATIONS, true);
}

function instrumentAdminDatabase(database) {
    const reference = database.ref("instrumentation");
    let prototype = Object.getPrototypeOf(reference);
    while (prototype && prototype !== Object.prototype) {
        patchObject(prototype, ADMIN_REFERENCE_OPERATIONS.filter((name) => Object.hasOwn(prototype, name)));
        patchObject(prototype, ADMIN_QUERY_OPERATIONS.filter((name) => Object.hasOwn(prototype, name)));
        prototype = Object.getPrototypeOf(prototype);
    }
}

module.exports = { instrumentAdminDatabase, instrumentClientSdk, setDatabaseRecorder };
