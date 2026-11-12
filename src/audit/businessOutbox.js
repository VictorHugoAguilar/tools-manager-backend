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

function isUserAuditEnabled() {
    return process.env.AUDIT_ADMIN_USERS_ENABLED === "true";
}

function isSelfUserAuditEnabled() {
    return process.env.AUDIT_SELF_USERS_ENABLED === "true";
}

function isRecoveryAuditEnabled() {
    return process.env.AUDIT_PASSWORD_RECOVERY_ENABLED === "true";
}

function isRegistrationAuditEnabled() {
    return process.env.AUDIT_REGISTRATION_ENABLED === "true";
}

function isWorkshopStorageAuditEnabled() {
    return process.env.AUDIT_WORKSHOP_STORAGE_ENABLED === "true";
}

function isStorageBoxAuditEnabled() {
    return process.env.AUDIT_STORAGE_BOXES_ENABLED === "true";
}

function isRepairAuditEnabled() {
    return process.env.AUDIT_REPAIRS_ENABLED === "true";
}

function isCatalogAuditEnabled() {
    return process.env.AUDIT_CATALOGS_ENABLED === "true";
}

function isTaskBoardCatalogAuditEnabled() {
    return process.env.AUDIT_TASK_BOARD_CATALOGS_ENABLED === "true";
}

function isTaskBoardTaskAuditEnabled() {
    const enabled = process.env.AUDIT_TASK_BOARD_TASKS_ENABLED === "true";
    if (enabled && !isTaskBoardCatalogAuditEnabled()) {
        throw new Error("AUDIT_TASK_BOARD_TASKS_ENABLED requiere AUDIT_TASK_BOARD_CATALOGS_ENABLED.");
    }
    return enabled;
}

function isTodoProjectAuditEnabled() {
    return process.env.AUDIT_TODO_PROJECTS_ENABLED === "true";
}

function isTodoSectionAuditEnabled() {
    const enabled = process.env.AUDIT_TODO_SECTIONS_ENABLED === "true";
    if (enabled && !isTodoProjectAuditEnabled()) {
        throw new Error("AUDIT_TODO_SECTIONS_ENABLED requiere AUDIT_TODO_PROJECTS_ENABLED.");
    }
    return enabled;
}

function isTodoLabelAuditEnabled() {
    return process.env.AUDIT_TODO_LABELS_ENABLED === "true";
}

function isTodoItemAuditEnabled() {
    const enabled = process.env.AUDIT_TODO_ITEMS_ENABLED === "true";
    if (enabled && !isTodoSectionAuditEnabled()) {
        throw new Error("AUDIT_TODO_ITEMS_ENABLED requiere AUDIT_TODO_SECTIONS_ENABLED.");
    }
    return enabled;
}

function isDrawingDocumentAuditEnabled() {
    return process.env.AUDIT_DRAWING_DOCUMENTS_ENABLED === "true";
}

function isDrawingPageAuditEnabled() {
    return process.env.AUDIT_DRAWING_PAGES_ENABLED === "true";
}

async function transactEntity({ id, actorId, action, change, database, collection, allowEmptyRoot, collectionPath, targetId = id, auditScope }) {
    if (typeof id !== "string" || !id || /[.#$/\[\]\u0000-\u001f\u007f]/.test(id) ||
        typeof targetId !== "string" || !targetId || /[.#$/\[\]\u0000-\u001f\u007f]/.test(targetId) ||
        typeof actorId !== "string" || !actorId || typeof change !== "function") {
        throw new Error("Datos de auditoría no válidos.");
    }
    const eventId = randomUUID();
    const event = {
        schemaVersion: 1, eventId, action, actorId, targetId,
        occurredAt: new Date().toISOString(),
        ...(auditScope ? { auditScope } : {})
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
        let parent = root;
        const path = collectionPath || [collection];
        for (const segment of path.slice(0, -1)) {
            parent[segment] = parent[segment] || {};
            parent = parent[segment];
        }
        const entities = path.length ? parent[path.at(-1)] || {} : root;
        let outcome;
        try {
            outcome = change(Object.hasOwn(entities, id) ? entities[id] : null, entities, root);
        } catch (error) {
            transactionError = error;
            return;
        }
        if (!outcome) return;
        resultValue = outcome.result;
        if (outcome.unchanged) return root;
        if (outcome.value === null) delete entities[id];
        else entities[id] = outcome.value;
        if (path.length) parent[path.at(-1)] = entities;
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

function transactStorageBox({ id, targetId = id, actorId, action, change, database = getAdminDatabase() }) {
    const actions = ["box.created", "box.updated", "box.deleted", "box.image.updated",
        "box.product.created", "box.product.updated", "box.product.deleted", "box.product.image.updated"];
    if (!actions.includes(action)) throw new Error("Acción de auditoría de cajas no válida.");
    return transactEntity({ id, targetId, actorId, action, change, database, collection: "storageBoxes", allowEmptyRoot: false, auditScope: "boxes" });
}

function transactStorageSettings({ id, actorId, action, change, database = getAdminDatabase() }) {
    const paths = {
        "workshop.category.created": ["workshopStorageSettings"],
        "workshop.category.deleted": ["workshopStorageSettings"],
        "box.shelf-config.updated": []
    };
    if (!Object.hasOwn(paths, action)) throw new Error("Acción de configuración de almacenamiento no válida.");
    return transactEntity({ id, actorId, action, change, database, collectionPath: paths[action], allowEmptyRoot: false,
        auditScope: action.startsWith("workshop.") ? "workshop" : "boxes" });
}

function transactWorkshopStorage({ id, actorId, collection, action, change, database = getAdminDatabase() }) {
    const collections = ["shelves", "levels", "organizers", "compartments", "materials"];
    if (!collections.includes(collection) || !["created", "updated", "deleted", "image.updated"].includes(action)) {
        throw new Error("Acción de auditoría de almacenamiento no válida.");
    }
    return transactEntity({
        id, actorId, change, database, collectionPath: ["workshopStorage", collection],
        action: `workshop.${collection}.${action}`, allowEmptyRoot: false, auditScope: "workshop"
    });
}

function transactTool({ id, actorId, action, change, database = getAdminDatabase() }) {
    if (!TOOL_ACTIONS.has(action)) throw new Error("Acción de auditoría de herramienta no válida.");
    return transactEntity({ id, actorId, action, change, database, collection: "tools", allowEmptyRoot: action === "tool.created" });
}

function transactRepair({ id, toolId, actorId, action, change, database = getAdminDatabase() }) {
    if (typeof toolId !== "string" || !toolId || /[.#$/\[\]\u0000-\u001f\u007f]/.test(toolId) ||
        !["repair.created", "repair.updated", "repair.deleted"].includes(action)) {
        throw new Error("Datos de auditoría de reparación no válidos.");
    }
    return transactEntity({ id, actorId, action, change: (current, entities, root) => {
        const outcome = change(current, entities, root);
        return outcome ? { ...outcome, auditDetails: { toolId } } : outcome;
    }, database, collectionPath: ["toolRepairs", toolId], allowEmptyRoot: false });
}

function transactCatalog({ id, actorId, collection, operation, change, database = getAdminDatabase() }) {
    const names = { locations: "location", technicians: "technician", toolTypes: "tool_type", tags: "tag" };
    if (!Object.hasOwn(names, collection) || !["created", "updated", "deleted"].includes(operation)) {
        throw new Error("Acción de auditoría de catálogo no válida.");
    }
    return transactEntity({ id, actorId, action: `${names[collection]}.${operation}`, change, database,
        collection, allowEmptyRoot: operation === "created" });
}

function transactTaskBoardCatalog({ targetId, actorId, action, change, database = getAdminDatabase() }) {
    const actions = [
        "task_board.column.created", "task_board.column.updated", "task_board.column.deleted",
        "task_board.column.reordered", "task_board.label.created", "task_board.label.updated",
        "task_board.label.deleted"
    ];
    if (!actions.includes(action)) throw new Error("Acción de auditoría de tablero no válida.");
    return transactEntity({
        id: "taskBoard", targetId, actorId, action, change: (current) => change(current || {}),
        database, collectionPath: [],
        allowEmptyRoot: action.endsWith(".created") || action === "task_board.column.reordered"
    });
}

function transactTaskBoardTask({ targetId, actorId, action, change, database = getAdminDatabase() }) {
    const actions = [
        "task_board.task.created", "task_board.task.updated", "task_board.task.moved",
        "task_board.task.deleted", "task_board.comment.created", "task_board.comment.updated",
        "task_board.comment.deleted", "task_board.attachment.created", "task_board.attachment.deleted"
    ];
    if (!actions.includes(action)) throw new Error("Acción de auditoría de tarea del tablero no válida.");
    return transactEntity({
        id: "taskBoard", targetId, actorId, action, database, collectionPath: [],
        allowEmptyRoot: false, change: (board, _entities, root) => change(board || {}, root)
    });
}

async function transactTodoProject({ targetId, actorId, action, projectId, change, database = getAdminDatabase() }) {
    const actions = [
        "todo.project.created", "todo.project.updated", "todo.project.archived",
        "todo.project.restored", "todo.project.deleted", "todo.project.reordered",
        "todo.member.added", "todo.member.removed"
    ];
    if (!actions.includes(action)) throw new Error("Acción de auditoría de proyecto no válida.");
    if (action.startsWith("todo.member.") &&
        (typeof projectId !== "string" || !projectId || /[.#$/\[\]\u0000-\u001f\u007f]/.test(projectId))) {
        throw new Error("Identificador de proyecto de auditoría no válido.");
    }
    const result = await transactEntity({
        id: "todoList", targetId, actorId, action, database, collectionPath: [],
        allowEmptyRoot: false, change: (data, _entities, root) => {
            const outcome = change(data || {}, root);
            return outcome && action.startsWith("todo.member.")
                ? { ...outcome, auditDetails: { projectId } } : outcome;
        }
    });
    if (result === null) {
        throw Object.assign(new Error("No se pudo confirmar la operación auditada de proyectos."), { statusCode: 503 });
    }
    return result;
}

async function transactTodoSection({ targetId, actorId, action, change, database = getAdminDatabase() }) {
    const actions = ["todo.section.created", "todo.section.updated", "todo.section.deleted", "todo.section.reordered"];
    if (!actions.includes(action)) throw new Error("Acción de auditoría de sección no válida.");
    const result = await transactEntity({
        id: "todoList", targetId, actorId, action, database, collectionPath: [],
        allowEmptyRoot: false, change: (data) => change(data || {})
    });
    if (result === null) {
        throw Object.assign(new Error("No se pudo confirmar la operación auditada de secciones."), { statusCode: 503 });
    }
    return result;
}

async function transactTodoLabel({ targetId, actorId, action, change, database = getAdminDatabase() }) {
    if (!["todo.label.created", "todo.label.updated", "todo.label.deleted"].includes(action)) {
        throw new Error("Acción de auditoría de etiqueta no válida.");
    }
    const result = await transactEntity({
        id: "todoList", targetId, actorId, action, database, collectionPath: [],
        allowEmptyRoot: action === "todo.label.created", change: (data) => change(data || {})
    });
    if (result === null) {
        throw Object.assign(new Error("No se pudo confirmar la operación auditada de etiquetas."), { statusCode: 503 });
    }
    return result;
}

async function transactTodoItem({ targetId, actorId, action, change, database = getAdminDatabase() }) {
    if (!["todo.item.created", "todo.item.updated", "todo.item.moved", "todo.item.completed", "todo.item.reopened",
        "todo.item.archived", "todo.item.unarchived",
        "todo.item.importance.updated", "todo.item.priority.updated", "todo.item.reordered",
        "todo.child.created", "todo.child.updated", "todo.child.deleted",
        "todo.comment.created", "todo.comment.updated", "todo.comment.deleted",
        "todo.reminder.created", "todo.reminder.updated", "todo.reminder.deleted"].includes(action)) {
        throw new Error("Acción de auditoría de tarea no válida.");
    }
    const result = await transactEntity({
        id: "todoList", targetId, actorId, action, database, collectionPath: [],
        allowEmptyRoot: false, change: (data, _entities, root) => change(data || {}, root)
    });
    if (result === null) {
        throw Object.assign(new Error("No se pudo confirmar la operación auditada de tareas."), { statusCode: 503 });
    }
    return result;
}

function transactDrawingDocument({ targetId, actorId, action, change, database = getAdminDatabase() }) {
    const actions = [
        "drawing.document.created", "drawing.document.updated", "drawing.document.archived",
        "drawing.document.restored", "drawing.document.deleted", "drawing.document.duplicated"
    ];
    if (!actions.includes(action)) throw new Error("Acción de auditoría de pizarra no válida.");
    return transactEntity({
        id: "drawing", targetId, actorId, action, database, collectionPath: [],
        allowEmptyRoot: action === "drawing.document.created",
        change: (data, _entities, root) => change(data || {}, root)
    });
}

function transactDrawingPage({ targetId, actorId, action, change, database = getAdminDatabase() }) {
    const actions = ["drawing.page.created", "drawing.page.updated", "drawing.page.deleted", "drawing.page.reordered",
        "drawing.page.duplicated", "drawing.version.restored"];
    if (!actions.includes(action)) throw new Error("Acción de auditoría de página no válida.");
    return transactEntity({
        id: "drawing", targetId, actorId, action, database, collectionPath: [],
        allowEmptyRoot: false, change: (data) => change(data || {})
    });
}

function transactRolePermissions({ id, actorId, change, database = getAdminDatabase() }) {
    return transactEntity({
        id, actorId, change, database, collection: "authRoles", allowEmptyRoot: false,
        action: "role.permissions.updated"
    });
}

function transactAdminUser({ id, actorId, action, change, database = getAdminDatabase() }) {
    const actions = ["user.created", "user.updated", "user.deleted", "user.role.updated",
        "user.status.updated", "user.password.reset", "user.avatar.updated",
        "user.profile.updated", "user.password.changed", "user.password.recovered",
        "user.registered", "user.registration.rolled_back"];
    if (!actions.includes(action)) throw new Error("Acción de auditoría de usuario no válida.");
    return transactEntity({ id, actorId, action, change, database, collection: "authUsers", allowEmptyRoot: false });
}

module.exports = {
    isToolAuditEnabled, isRoleAuditEnabled, isUserAuditEnabled, isSelfUserAuditEnabled, isRecoveryAuditEnabled,
    isRegistrationAuditEnabled, isWorkshopStorageAuditEnabled, isStorageBoxAuditEnabled, isRepairAuditEnabled,
    isCatalogAuditEnabled, isTaskBoardCatalogAuditEnabled, isTaskBoardTaskAuditEnabled,
    isTodoProjectAuditEnabled, isTodoSectionAuditEnabled, isTodoItemAuditEnabled, isTodoLabelAuditEnabled,
    isDrawingDocumentAuditEnabled, isDrawingPageAuditEnabled,
    transactTool, transactRolePermissions, transactAdminUser, transactWorkshopStorage, transactStorageBox,
    transactStorageSettings, transactRepair, transactCatalog, transactTaskBoardCatalog, transactTaskBoardTask,
    transactTodoProject, transactTodoSection, transactTodoItem, transactTodoLabel,
    transactDrawingDocument, transactDrawingPage, MAX_ROOT_BYTES
};
