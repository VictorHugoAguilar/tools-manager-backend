const { randomUUID } = require("node:crypto");
const { getAdminDatabase } = require("../config/firebaseAdmin");
const { deleteTaskAttachment, uploadTaskAttachment } = require("./taskBoardAttachmentService");

const INITIAL_COLUMNS = [
    { id: "todo", name: "Por hacer", color: "blue", position: 0 },
    { id: "in-progress", name: "En progreso", color: "mint", position: 1 },
    { id: "review", name: "En revisión", color: "yellow", position: 2 },
    { id: "done", name: "Hecho", color: "mint", position: 3 }
];
const INITIAL_LABELS = [
    { id: "project", name: "Proyecto", color: "#8edfc0" },
    { id: "home", name: "Hogar", color: "#cdb4ff" },
    { id: "work", name: "Trabajo", color: "#cdb4ff" },
    { id: "personal", name: "Personal", color: "#9fc9ff" },
    { id: "purchases", name: "Compras", color: "#ffb5c5" },
    { id: "maintenance", name: "Mantenimiento", color: "#ffaaa4" }
];
const PRIORITIES = new Set(["low", "medium", "high"]);
const COLOR_PATTERN = /^#[0-9a-f]{6}$/i;

function serviceError(message, statusCode = 400) {
    return Object.assign(new Error(message), { statusCode });
}

function boardRef(path = "") {
    const root = getAdminDatabase().ref("taskBoard");
    return path ? root.child(path) : root;
}

function sortByPosition(items) {
    return Object.entries(items || {})
        .map(([id, value]) => ({ id, ...value }))
        .sort((left, right) => Number(left.position || 0) - Number(right.position || 0));
}

function normalizeTask(id, value) {
    return {
        id,
        title: value.title || "",
        description: value.description || "",
        columnId: value.columnId || "",
        position: Number(value.position) || 0,
        priority: PRIORITIES.has(value.priority) ? value.priority : "medium",
        labelIds: Array.isArray(value.labelIds) ? value.labelIds : [],
        dueDate: value.dueDate || "",
        assigneeId: value.assigneeId || "",
        createdAt: value.createdAt || "",
        updatedAt: value.updatedAt || "",
        comments: Object.entries(value.comments || {}).map(([commentId, comment]) => ({
            id: commentId,
            ...comment
        })).sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
        attachments: Object.entries(value.attachments || {}).map(([attachmentId, attachment]) => ({
            id: attachmentId,
            ...attachment
        })),
        history: Object.entries(value.history || {}).map(([historyId, entry]) => ({
            id: historyId,
            ...entry
        })).sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    };
}

function normalizeName(value, label) {
    if (typeof value !== "string" || !value.trim() || value.trim().length > 120) {
        throw serviceError(`${label} es obligatorio y no puede superar 120 caracteres.`);
    }
    return value.trim();
}

function normalizeColor(value) {
    if (typeof value !== "string" || !COLOR_PATTERN.test(value)) {
        throw serviceError("El color debe ser un valor hexadecimal válido.");
    }
    return value.toLowerCase();
}

function validateDueDate(value) {
    if (value === "" || value === null || value === undefined) return "";
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
        Number.isNaN(Date.parse(`${value}T00:00:00.000Z`))) {
        throw serviceError("La fecha de vencimiento no es válida.");
    }
    return value;
}

function validateTaskPayload(payload, { partial = false } = {}) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw serviceError("Los datos de la tarea no son válidos.");
    }
    const allowed = new Set(["title", "description", "columnId", "priority", "labelIds", "dueDate", "assigneeId"]);
    if (Object.keys(payload).some((key) => !allowed.has(key))) {
        throw serviceError("La solicitud contiene campos de tarea no permitidos.");
    }

    const result = {};
    if (!partial || Object.hasOwn(payload, "title")) result.title = normalizeName(payload.title, "El título");
    if (!partial || Object.hasOwn(payload, "description")) {
        if (typeof (payload.description ?? "") !== "string" || (payload.description || "").length > 5000) {
            throw serviceError("La descripción no puede superar 5000 caracteres.");
        }
        result.description = payload.description || "";
    }
    if (!partial || Object.hasOwn(payload, "columnId")) {
        result.columnId = normalizeName(payload.columnId, "La lista");
    }
    if (!partial || Object.hasOwn(payload, "priority")) {
        if (!PRIORITIES.has(payload.priority)) throw serviceError("La prioridad indicada no es válida.");
        result.priority = payload.priority;
    }
    if (!partial || Object.hasOwn(payload, "labelIds")) {
        if (!Array.isArray(payload.labelIds) ||
            payload.labelIds.some((id) => typeof id !== "string" || !id || id.length > 120)) {
            throw serviceError("Las etiquetas de la tarea no son válidas.");
        }
        result.labelIds = [...new Set(payload.labelIds)];
    }
    if (!partial || Object.hasOwn(payload, "dueDate")) result.dueDate = validateDueDate(payload.dueDate);
    if (!partial || Object.hasOwn(payload, "assigneeId")) {
        if (typeof (payload.assigneeId ?? "") !== "string" || (payload.assigneeId || "").length > 120) {
            throw serviceError("El responsable no es válido.");
        }
        result.assigneeId = payload.assigneeId || "";
    }
    return result;
}

async function ensureInitialized() {
    const initialized = await boardRef("_meta/initialized").get();
    if (initialized.exists()) return;

    const [columns, labels] = await Promise.all([
        boardRef("columns").get(),
        boardRef("labels").get()
    ]);
    const initialData = {};
    if (!columns.exists()) {
        for (const column of INITIAL_COLUMNS) {
            const { id, ...value } = column;
            initialData[`columns/${id}`] = value;
        }
    }
    if (!labels.exists()) {
        for (const label of INITIAL_LABELS) {
            const { id, ...value } = label;
            initialData[`labels/${id}`] = value;
        }
    }
    initialData["_meta/initialized"] = true;
    if (Object.keys(initialData).length) await boardRef().update(initialData);
}

async function getMembers() {
    const snapshot = await getAdminDatabase().ref("authUsers").get();
    return Object.entries(snapshot.val() || {})
        .filter(([, user]) => user?.isActive !== false)
        .map(([id, user]) => ({
            id,
            firstName: user.firstName || "",
            lastName: user.lastName || "",
            profileImage: user.profileImage || ""
        }))
        .sort((left, right) => left.firstName.localeCompare(right.firstName));
}

async function getBoard(filters = {}) {
    await ensureInitialized();
    const [columnsSnapshot, tasksSnapshot, labelsSnapshot, members] = await Promise.all([
        boardRef("columns").get(),
        boardRef("tasks").get(),
        boardRef("labels").get(),
        getMembers()
    ]);
    const columns = sortByPosition(columnsSnapshot.val());
    const labels = Object.entries(labelsSnapshot.val() || {}).map(([id, value]) => ({ id, ...value }));
    const labelNames = new Map(labels.map((label) => [label.id, label.name.toLowerCase()]));
    const tasks = Object.entries(tasksSnapshot.val() || {})
        .map(([id, value]) => normalizeTask(id, value))
        .filter((task) => {
            const query = String(filters.search || "").trim().toLowerCase();
            if (query && !`${task.title} ${task.description}`.toLowerCase().includes(query)) return false;
            if (filters.columnId && task.columnId !== filters.columnId) return false;
            if (filters.priority && task.priority !== filters.priority) return false;
            if (filters.assigneeId && task.assigneeId !== filters.assigneeId) return false;
            if (filters.labelId && !task.labelIds.includes(filters.labelId)) return false;
            if (filters.overdue === "true" && (!task.dueDate || task.dueDate >= new Date().toISOString().slice(0, 10))) return false;
            if (filters.dueDate && task.dueDate !== filters.dueDate) return false;
            if (filters.label && !task.labelIds.some((id) => labelNames.get(id)?.includes(String(filters.label).toLowerCase()))) return false;
            return true;
        })
        .sort((left, right) => left.position - right.position);
    return { columns, tasks, labels, members };
}

async function getTask(taskId) {
    const snapshot = await boardRef(`tasks/${taskId}`).get();
    return snapshot.exists() ? normalizeTask(taskId, snapshot.val()) : null;
}

async function assertColumnExists(columnId) {
    if (!await boardRef(`columns/${columnId}`).get().then((snapshot) => snapshot.exists())) {
        throw serviceError("La lista seleccionada no existe.", 404);
    }
}

async function assertLabelsExist(labelIds) {
    const labelsSnapshot = await boardRef("labels").get();
    const labels = labelsSnapshot.val() || {};
    if (labelIds.some((id) => !labels[id])) throw serviceError("Una o más etiquetas ya no existen.", 409);
}

async function assertAssigneeExists(assigneeId) {
    if (!assigneeId) return;
    const member = await getAdminDatabase().ref(`authUsers/${assigneeId}`).get();
    if (!member.exists() || member.val()?.isActive === false) {
        throw serviceError("El responsable seleccionado no está disponible.", 400);
    }
}

async function createColumn(payload) {
    await ensureInitialized();
    const name = normalizeName(payload?.name, "El nombre de la lista");
    const color = payload?.color ?? "blue";
    if (!["blue", "mint", "yellow", "rose"].includes(color)) {
        throw serviceError("El color de la lista no es válido.");
    }
    const columns = sortByPosition((await boardRef("columns").get()).val());
    const id = randomUUID();
    const column = { name, color, position: columns.length };
    await boardRef(`columns/${id}`).set(column);
    return { id, ...column };
}

async function updateColumn(id, payload) {
    const ref = boardRef(`columns/${id}`);
    const snapshot = await ref.get();
    if (!snapshot.exists()) return null;
    const changes = {};
    if (Object.hasOwn(payload || {}, "name")) changes.name = normalizeName(payload.name, "El nombre de la lista");
    if (Object.hasOwn(payload || {}, "color")) {
        if (!["blue", "mint", "yellow", "rose"].includes(payload.color)) throw serviceError("El color de la lista no es válido.");
        changes.color = payload.color;
    }
    if (!Object.keys(changes).length) throw serviceError("No hay cambios para guardar.");
    await ref.update(changes);
    return { id, ...snapshot.val(), ...changes };
}

async function reorderColumns(ids) {
    const columns = sortByPosition((await boardRef("columns").get()).val());
    if (!Array.isArray(ids) || ids.length !== columns.length ||
        new Set(ids).size !== columns.length || ids.some((id) => !columns.some((column) => column.id === id))) {
        throw serviceError("El nuevo orden de listas no es válido.");
    }
    const updates = {};
    ids.forEach((id, position) => updates[`columns/${id}/position`] = position);
    await boardRef().update(updates);
    return sortByPosition((await boardRef("columns").get()).val());
}

async function deleteColumn(id) {
    const [column, tasks] = await Promise.all([
        boardRef(`columns/${id}`).get(),
        boardRef("tasks").get()
    ]);
    if (!column.exists()) return false;
    if (Object.values(tasks.val() || {}).some((task) => task?.columnId === id)) {
        throw serviceError("Esta lista contiene tareas. Muévelas o elimínalas antes de borrar la lista.", 409);
    }
    await boardRef(`columns/${id}`).remove();
    const remaining = sortByPosition((await boardRef("columns").get()).val());
    const updates = {};
    remaining.forEach((item, position) => updates[`columns/${item.id}/position`] = position);
    if (Object.keys(updates).length) await boardRef().update(updates);
    return true;
}

async function createTask(payload, actor) {
    const task = validateTaskPayload(payload);
    await Promise.all([
        assertColumnExists(task.columnId),
        assertLabelsExist(task.labelIds),
        assertAssigneeExists(task.assigneeId)
    ]);
    const tasks = (await boardRef("tasks").get()).val() || {};
    const position = Object.values(tasks).filter((value) => value?.columnId === task.columnId).length;
    const id = randomUUID();
    const now = new Date().toISOString();
    const historyId = randomUUID();
    const data = {
        ...task,
        position,
        createdAt: now,
        updatedAt: now,
        comments: {},
        attachments: {},
        history: {
            [historyId]: {
                text: `Tarea creada por ${actor.firstName} ${actor.lastName}`.trim(),
                actorId: actor.id,
                actorName: `${actor.firstName} ${actor.lastName}`.trim(),
                createdAt: now
            }
        }
    };
    await boardRef(`tasks/${id}`).set(data);
    return normalizeTask(id, data);
}

async function updateTask(id, payload, actor) {
    const ref = boardRef(`tasks/${id}`);
    const snapshot = await ref.get();
    if (!snapshot.exists()) return null;
    const existing = normalizeTask(id, snapshot.val());
    const changes = validateTaskPayload(payload, { partial: true });
    await Promise.all([
        changes.columnId ? assertColumnExists(changes.columnId) : Promise.resolve(),
        changes.labelIds ? assertLabelsExist(changes.labelIds) : Promise.resolve(),
        changes.assigneeId !== undefined ? assertAssigneeExists(changes.assigneeId) : Promise.resolve()
    ]);
    const updated = { ...snapshot.val(), ...changes, updatedAt: new Date().toISOString() };
    const movingColumn = changes.columnId && changes.columnId !== existing.columnId;
    const diffs = Object.entries(changes)
        .filter(([key, value]) => JSON.stringify(existing[key]) !== JSON.stringify(value))
        .map(([key]) => key);
    if (diffs.length) {
        const historyId = randomUUID();
        updated.history = {
            ...(snapshot.val().history || {}),
            [historyId]: {
                text: `${actor.firstName} ${actor.lastName} actualizó ${diffs.join(", ")}`.trim(),
                actorId: actor.id,
                actorName: `${actor.firstName} ${actor.lastName}`.trim(),
                createdAt: updated.updatedAt
            }
        };
    }
    if (movingColumn) {
        const tasks = Object.entries((await boardRef("tasks").get()).val() || {});
        const sortTasks = (items) => items.sort((left, right) =>
            Number(left[1].position || 0) - Number(right[1].position || 0)
        );
        const source = sortTasks(tasks.filter(([taskId, task]) =>
            taskId !== id && task?.columnId === existing.columnId
        ));
        const target = sortTasks(tasks.filter(([taskId, task]) =>
            taskId !== id && task?.columnId === changes.columnId
        ));
        target.push([id, updated]);
        const updates = { [`tasks/${id}`]: updated };
        target.forEach(([taskId], position) => {
            if (taskId === id) {
                updated.position = position;
                updates[`tasks/${id}`] = updated;
            } else {
                updates[`tasks/${taskId}/position`] = position;
            }
        });
        source.forEach(([taskId], position) => {
            updates[`tasks/${taskId}/position`] = position;
        });
        await boardRef().update(updates);
    } else {
        await ref.set(updated);
    }
    return normalizeTask(id, updated);
}

async function moveTask(id, columnId, position, actor) {
    const task = await getTask(id);
    if (!task) return null;
    await assertColumnExists(columnId);
    if (!Number.isInteger(position) || position < 0) throw serviceError("La posición de la tarea no es válida.");

    const allTasks = (await boardRef("tasks").get()).val() || {};
    const source = Object.entries(allTasks)
        .filter(([taskId, item]) => taskId !== id && item?.columnId === task.columnId)
        .sort((left, right) => Number(left[1].position || 0) - Number(right[1].position || 0));
    const target = task.columnId === columnId
        ? source
        : Object.entries(allTasks)
            .filter(([taskId, item]) => taskId !== id && item?.columnId === columnId)
            .sort((left, right) => Number(left[1].position || 0) - Number(right[1].position || 0));
    target.splice(Math.min(position, target.length), 0, [id, { ...allTasks[id], columnId }]);
    const updates = {};
    target.forEach(([taskId, value], index) => {
        updates[`tasks/${taskId}/columnId`] = columnId;
        updates[`tasks/${taskId}/position`] = index;
    });
    if (task.columnId !== columnId) {
        source.forEach(([taskId], index) => {
            updates[`tasks/${taskId}/position`] = index;
        });
    }
    const now = new Date().toISOString();
    updates[`tasks/${id}/updatedAt`] = now;
    updates[`tasks/${id}/history/${randomUUID()}`] = {
        text: `${actor.firstName} ${actor.lastName} movió la tarea a otra lista`.trim(),
        actorId: actor.id,
        actorName: `${actor.firstName} ${actor.lastName}`.trim(),
        createdAt: now
    };
    await boardRef().update(updates);
    return getTask(id);
}

async function deleteTask(id) {
    const task = await getTask(id);
    if (!task) return false;
    await Promise.all(task.attachments.map((attachment) => deleteTaskAttachment(attachment.path)));
    await boardRef(`tasks/${id}`).remove();
    return true;
}

async function createLabel(payload) {
    const name = normalizeName(payload?.name, "El nombre de la etiqueta");
    const color = normalizeColor(payload?.color);
    const labels = (await boardRef("labels").get()).val() || {};
    if (Object.values(labels).some((label) => label?.name?.toLowerCase() === name.toLowerCase())) {
        throw serviceError("Ya existe una etiqueta con ese nombre.", 409);
    }
    const id = randomUUID();
    const label = { name, color };
    await boardRef(`labels/${id}`).set(label);
    return { id, ...label };
}

async function updateLabel(id, payload) {
    const ref = boardRef(`labels/${id}`);
    const snapshot = await ref.get();
    if (!snapshot.exists()) return null;
    const changes = {};
    if (Object.hasOwn(payload || {}, "name")) changes.name = normalizeName(payload.name, "El nombre de la etiqueta");
    if (Object.hasOwn(payload || {}, "color")) changes.color = normalizeColor(payload.color);
    if (!Object.keys(changes).length) throw serviceError("No hay cambios para guardar.");
    const labels = (await boardRef("labels").get()).val() || {};
    if (changes.name && Object.entries(labels).some(([labelId, label]) =>
        labelId !== id && label?.name?.toLowerCase() === changes.name.toLowerCase()
    )) throw serviceError("Ya existe una etiqueta con ese nombre.", 409);
    await ref.update(changes);
    return { id, ...snapshot.val(), ...changes };
}

async function deleteLabel(id) {
    const labelRef = boardRef(`labels/${id}`);
    if (!(await labelRef.get()).exists()) return false;
    const tasks = (await boardRef("tasks").get()).val() || {};
    const updates = { [`labels/${id}`]: null };
    for (const [taskId, task] of Object.entries(tasks)) {
        if (task?.labelIds?.includes(id)) {
            updates[`tasks/${taskId}/labelIds`] = task.labelIds.filter((labelId) => labelId !== id);
        }
    }
    await boardRef().update(updates);
    return true;
}

async function addComment(taskId, text, actor) {
    const ref = boardRef(`tasks/${taskId}`);
    if (!(await ref.get()).exists()) return null;
    const comment = {
        text: normalizeName(text, "El comentario"),
        authorId: actor.id,
        authorName: `${actor.firstName} ${actor.lastName}`.trim(),
        createdAt: new Date().toISOString()
    };
    const commentRef = ref.child("comments").push();
    const updates = {
        [`comments/${commentRef.key}`]: comment,
        updatedAt: comment.createdAt,
        [`history/${randomUUID()}`]: {
            text: `${actor.firstName} ${actor.lastName} añadió un comentario`.trim(),
            actorId: actor.id,
            actorName: `${actor.firstName} ${actor.lastName}`.trim(),
            createdAt: comment.createdAt
        }
    };
    await ref.update(updates);
    return { id: commentRef.key, ...comment };
}

async function addAttachment(taskId, file, actor) {
    const taskRef = boardRef(`tasks/${taskId}`);
    if (!(await taskRef.get()).exists()) return null;
    const attachment = await uploadTaskAttachment(taskId, file, actor);
    try {
        const attachmentRef = taskRef.child("attachments").child(attachment.id);
        await attachmentRef.set(attachment);
        return attachment;
    } catch (error) {
        await deleteTaskAttachment(attachment.path);
        throw error;
    }
}

async function removeAttachment(taskId, attachmentId) {
    const ref = boardRef(`tasks/${taskId}/attachments/${attachmentId}`);
    const snapshot = await ref.get();
    if (!snapshot.exists()) return false;
    await deleteTaskAttachment(snapshot.val().path);
    await ref.remove();
    return true;
}

module.exports = {
    MAX_ATTACHMENT_SIZE: 15 * 1024 * 1024,
    addAttachment,
    addComment,
    createColumn,
    createLabel,
    createTask,
    deleteColumn,
    deleteLabel,
    deleteTask,
    getBoard,
    moveTask,
    removeAttachment,
    reorderColumns,
    updateColumn,
    updateLabel,
    updateTask
};
