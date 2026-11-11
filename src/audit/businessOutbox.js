const { randomUUID } = require("node:crypto");
const { getAdminDatabase } = require("../config/firebaseAdmin");

const MAX_ROOT_BYTES = 8 * 1024 * 1024;
const TOOL_ACTIONS = new Set([
    "tool.created", "tool.updated", "tool.state.updated", "tool.image.updated", "tool.deleted"
]);

function isToolAuditEnabled() {
    return process.env.AUDIT_TOOLS_ENABLED === "true";
}

function isRoleAuditEnabled() {
    return process.env.AUDIT_ROLES_ENABLED === "true";
}

async function transactEntity({ id, actorId, action, change, database, collection, allowEmptyRoot }) {
    if (typeof id !== "string" || !id || /[.#$/\[\]\u0000-\u001f\u007f]/.test(id) ||
        typeof actorId !== "string" || !actorId || typeof change !== "function") {
        throw new Error("Datos de auditoría no válidos.");
    }
    const eventId = randomUUID();
    const event = {
        schemaVersion: 1, eventId, action, actorId, targetId: id,
        occurredAt: new Date().toISOString()
    };
    let resultValue;
    let transactionError;
    const transaction = await database.ref().transaction((current) => {
        resultValue = undefined;
        transactionError = undefined;
        if (current === null && !allowEmptyRoot) return null;
        const root = current || {};
        if (Buffer.byteLength(JSON.stringify(root), "utf8") > MAX_ROOT_BYTES) {
            transactionError = Object.assign(new Error("La base supera el límite seguro para la auditoría de negocio."), { statusCode: 503 });
            return;
        }
        const entities = root[collection] || {};
        const outcome = change(entities[id] || null);
        if (!outcome) return;
        resultValue = outcome.result;
        if (outcome.value === null) delete entities[id];
        else entities[id] = outcome.value;
        root[collection] = entities;
        root.auditOutbox = root.auditOutbox || {};
        root.auditOutbox[eventId] = { ...event, ...outcome.auditDetails };
        if (Buffer.byteLength(JSON.stringify(root), "utf8") > MAX_ROOT_BYTES) {
            transactionError = Object.assign(new Error("La base supera el límite seguro para la auditoría de negocio."), { statusCode: 503 });
            return;
        }
        return root;
    }, undefined, false);
    if (transactionError) throw transactionError;
    if (!transaction.committed && resultValue !== undefined) {
        throw Object.assign(new Error("No se pudo confirmar la operación auditada."), { statusCode: 503 });
    }
    if (!transaction.committed || resultValue === undefined) return null;
    return resultValue;
}

function transactTool({ id, actorId, action, change, database = getAdminDatabase() }) {
    if (!TOOL_ACTIONS.has(action)) throw new Error("Acción de auditoría de herramienta no válida.");
    return transactEntity({ id, actorId, action, change, database, collection: "tools", allowEmptyRoot: action === "tool.created" });
}

function transactRolePermissions({ id, actorId, change, database = getAdminDatabase() }) {
    return transactEntity({
        id, actorId, change, database, collection: "authRoles", allowEmptyRoot: false,
        action: "role.permissions.updated"
    });
}

module.exports = { isToolAuditEnabled, isRoleAuditEnabled, transactTool, transactRolePermissions, MAX_ROOT_BYTES };
