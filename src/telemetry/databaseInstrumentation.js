const WRAPPED = Symbol.for("toolsManager.databaseInstrumented");
const CLIENT_OPERATIONS = ["get", "set", "update", "remove", "runTransaction"];
const ADMIN_QUERY_OPERATIONS = ["get", "once"];
const ADMIN_REFERENCE_OPERATIONS = ["set", "update", "remove", "transaction"];

let recorder = null;
let depth = 0;

// Solo se registran duración y éxito; nunca rutas, valores ni identificadores.
function setDatabaseRecorder(fn) {
    recorder = typeof fn === "function" ? fn : null;
}

function report(startedAt, failed) {
    if (!recorder) return;
    try {
        recorder(Number(process.hrtime.bigint() - startedAt) / 1e6, failed);
    } catch {
        // La telemetría nunca debe afectar a la operación.
    }
}

function wrap(original) {
    if (typeof original !== "function" || original[WRAPPED]) return original;
    const wrapped = function instrumented(...args) {
        if (depth > 0) return original.apply(this, args);
        const startedAt = process.hrtime.bigint();
        let result;
        depth += 1;
        try {
            result = original.apply(this, args);
        } catch (error) {
            report(startedAt, true);
            throw error;
        } finally {
            depth -= 1;
        }
        if (result && typeof result.then === "function") {
            result.then(() => report(startedAt, false), () => report(startedAt, true));
        } else {
            report(startedAt, false);
        }
        return result;
    };
    Object.defineProperty(wrapped, WRAPPED, { value: true });
    return wrapped;
}

function patchObject(target, names) {
    for (const name of names) {
        if (typeof target[name] === "function") target[name] = wrap(target[name]);
    }
}

function instrumentClientSdk() {
    patchObject(require("@firebase/database"), CLIENT_OPERATIONS);
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
