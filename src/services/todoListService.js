const { randomUUID } = require("node:crypto");
const { getAdminDatabase } = require("../config/firebaseAdmin");
const {
    isTodoProjectAuditEnabled, transactTodoProject, isTodoSectionAuditEnabled, transactTodoSection,
    isTodoItemAuditEnabled, transactTodoItem, isTodoLabelAuditEnabled, transactTodoLabel
} = require("../audit/businessOutbox");
const {
    todoListDeleteAttachment,
    todoListGetAttachmentUrl,
    todoListUploadAttachment
} = require("./todoListAttachmentService");

const TODO_LIST_ROOT = "todoList";
const TODO_LIST_RECURRENCES = new Set([
    "daily", "weekdays", "weekly", "biweekly", "monthly", "yearly", "custom"
]);
const TODO_LIST_PRIORITIES = new Set([1, 2, 3, 4]);
const TODO_LIST_COLORS = new Set(["blue", "mint", "yellow", "rose", "purple", "coral"]);
const TODO_LIST_MAX_PAGE_SIZE = 100;
const TODO_LIST_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function todoListError(message, statusCode = 400) {
    return Object.assign(new Error(message), { statusCode });
}

function todoListRef(path = "") {
    if (path && path.split("/").some((segment) => !/^[A-Za-z0-9_-]+$/.test(segment))) {
        throw todoListError("El identificador solicitado no es válido.");
    }
    const todoListRootRef = getAdminDatabase().ref(TODO_LIST_ROOT);
    return path ? todoListRootRef.child(path) : todoListRootRef;
}

function todoListValues(snapshot) {
    return Object.entries(snapshot.val() || {}).map(([id, value]) => ({ id, ...value }));
}

function todoListNormalizeName(value, field = "El nombre", maxLength = 120) {
    if (typeof value !== "string" || !value.trim() || value.trim().length > maxLength) {
        throw todoListError(`${field} es obligatorio y no puede superar ${maxLength} caracteres.`);
    }
    return value.trim();
}

function todoListNormalizeDescription(value) {
    if (value === undefined || value === null) return "";
    if (typeof value !== "string" || value.length > 5000) {
        throw todoListError("La descripción no puede superar 5000 caracteres.");
    }
    return value.trim();
}

function todoListValidateDate(value, field = "La fecha") {
    if (value === "" || value === null || value === undefined) return "";
    if (typeof value !== "string" || !TODO_LIST_DATE_PATTERN.test(value)) {
        throw todoListError(`${field} no es válida.`);
    }
    const date = new Date(`${value}T00:00:00.000Z`);
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
        throw todoListError(`${field} no es válida.`);
    }
    return value;
}

function todoListValidateTime(value) {
    if (value === "" || value === null || value === undefined) return "";
    if (typeof value !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
        throw todoListError("La hora no es válida.");
    }
    return value;
}

function todoListValidateTimeZone(value) {
    if (typeof value !== "string" || value.length > 80) {
        throw todoListError("La zona horaria no es válida.");
    }
    try {
        new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    } catch {
        throw todoListError("La zona horaria no es válida.");
    }
    return value;
}

function todoListValidatePriority(value) {
    const priority = Number(value ?? 4);
    if (!TODO_LIST_PRIORITIES.has(priority)) {
        throw todoListError("La prioridad debe estar entre 1 y 4.");
    }
    return priority;
}

function todoListValidateColor(value) {
    if (typeof value !== "string" || !TODO_LIST_COLORS.has(value)) {
        throw todoListError("El color seleccionado no es válido.");
    }
    return value;
}

function todoListValidateLabelColor(value) {
    if (typeof value === "string" && (TODO_LIST_COLORS.has(value) || /^#[0-9a-f]{6}$/i.test(value))) {
        return value;
    }
    throw todoListError("El color seleccionado no es válido.");
}

function todoListValidateStringArray(value, label) {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry || entry.length > 120)) {
        throw todoListError(`${label} no son válidos.`);
    }
    return [...new Set(value)];
}

function todoListGetLocalDate(todoListTimeZone = "UTC", todoListNow = new Date()) {
    const dateParts = new Intl.DateTimeFormat("en-CA", {
        timeZone: todoListTimeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
    }).formatToParts(todoListNow);
    const values = Object.fromEntries(dateParts.map(({ type, value }) => [type, value]));
    return `${values.year}-${values.month}-${values.day}`;
}

function todoListNextOccurrenceDate(todoListDate, todoListRecurrence) {
    const currentDate = new Date(`${todoListValidateDate(todoListDate)}T00:00:00.000Z`);
    const interval = Math.max(1, Math.min(365, Number(todoListRecurrence.interval) || 1));
    const frequency = todoListRecurrence.frequency;

    if (frequency === "daily") currentDate.setUTCDate(currentDate.getUTCDate() + interval);
    else if (frequency === "weekdays") {
        let remainingDays = interval;
        while (remainingDays > 0) {
            currentDate.setUTCDate(currentDate.getUTCDate() + 1);
            if (currentDate.getUTCDay() !== 0 && currentDate.getUTCDay() !== 6) remainingDays -= 1;
        }
    } else if (frequency === "weekly" || frequency === "biweekly") {
        const weekInterval = frequency === "biweekly" ? 2 : interval;
        const days = todoListValidateStringArray(
            (todoListRecurrence.daysOfWeek || []).map(String),
            "Los días de repetición"
        ).map(Number).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6);
        if (days.length) {
            const start = currentDate.getTime();
            for (let offset = 1; offset <= 21 * weekInterval; offset += 1) {
                currentDate.setTime(start);
                currentDate.setUTCDate(currentDate.getUTCDate() + offset);
                const week = Math.floor((currentDate.getTime() - start) / (7 * 86400000));
                if (week % weekInterval === 0 && days.includes(currentDate.getUTCDay())) return currentDate.toISOString().slice(0, 10);
            }
        } else {
            currentDate.setUTCDate(currentDate.getUTCDate() + weekInterval * 7);
        }
    } else if (frequency === "monthly") {
        const originalDay = currentDate.getUTCDate();
        const nextMonth = new Date(Date.UTC(currentDate.getUTCFullYear(), currentDate.getUTCMonth() + interval, 1));
        nextMonth.setUTCDate(Math.min(originalDay, new Date(Date.UTC(
            nextMonth.getUTCFullYear(),
            nextMonth.getUTCMonth() + 1,
            0
        )).getUTCDate()));
        currentDate.setTime(nextMonth.getTime());
    } else if (frequency === "yearly") {
        const month = currentDate.getUTCMonth();
        const day = currentDate.getUTCDate();
        currentDate.setUTCFullYear(currentDate.getUTCFullYear() + interval);
        if (currentDate.getUTCMonth() !== month) {
            currentDate.setUTCMonth(month + 1, 0);
        } else if (currentDate.getUTCDate() !== day) {
            currentDate.setUTCDate(0);
        }
    } else if (frequency === "custom") {
        const unit = todoListRecurrence.unit;
        if (unit === "days") currentDate.setUTCDate(currentDate.getUTCDate() + interval);
        else if (unit === "weeks") currentDate.setUTCDate(currentDate.getUTCDate() + interval * 7);
        else if (unit === "months") currentDate.setUTCMonth(currentDate.getUTCMonth() + interval);
        else throw todoListError("La unidad de recurrencia personalizada no es válida.");
    } else {
        throw todoListError("La frecuencia de recurrencia no es válida.");
    }
    return currentDate.toISOString().slice(0, 10);
}

function todoListSort(items, sortBy = "position", order = "asc") {
    const direction = order === "desc" ? -1 : 1;
    return [...items].sort((left, right) => {
        const leftValue = left[sortBy];
        const rightValue = right[sortBy];
        if (sortBy === "dueDate") {
            const leftDate = leftValue || "9999-12-31";
            const rightDate = rightValue || "9999-12-31";
            return leftDate.localeCompare(rightDate) * direction;
        }
        if (typeof leftValue === "number" && typeof rightValue === "number") {
            return (leftValue - rightValue) * direction;
        }
        return String(leftValue || "").localeCompare(String(rightValue || "")) * direction;
    });
}

async function todoListInitialize() {
    const todoListMetadataRef = todoListRef("Metadata");
    const todoListSnapshot = await todoListMetadataRef.get();
    if (!todoListSnapshot.exists()) {
        await todoListMetadataRef.set({ schemaVersion: 1, initializedAt: new Date().toISOString() });
    }
}

async function todoListGetUser(todoListUserId) {
    if (typeof todoListUserId !== "string" || !/^[A-Za-z0-9_-]+$/.test(todoListUserId)) {
        throw todoListError("El usuario no está disponible.", 404);
    }
    const todoListSnapshot = await getAdminDatabase().ref(`authUsers/${todoListUserId}`).get();
    const todoListUser = todoListSnapshot.val();
    if (!todoListUser || todoListUser.isActive === false) {
        throw todoListError("El usuario no está disponible.", 404);
    }
    return {
        id: todoListUserId,
        firstName: todoListUser.firstName || "",
        lastName: todoListUser.lastName || "",
        profileImage: todoListUser.profileImage || ""
    };
}

async function todoListGetUsers() {
    const todoListSnapshot = await getAdminDatabase().ref("authUsers").get();
    return Object.entries(todoListSnapshot.val() || {})
        .filter(([, todoListUser]) => todoListUser?.isActive !== false)
        .map(([id, todoListUser]) => ({
            id,
            firstName: todoListUser.firstName || "",
            lastName: todoListUser.lastName || "",
            profileImage: todoListUser.profileImage || ""
        }))
        .sort((left, right) => left.firstName.localeCompare(right.firstName));
}

async function todoListGetProjectAccess(todoListId, todoListUserId) {
    const [todoListProjectSnapshot, todoListMemberSnapshot] = await Promise.all([
        todoListRef(`TodoLists/${todoListId}`).get(),
        todoListRef(`TodoListMembers/${todoListId}/${todoListUserId}`).get()
    ]);
    if (!todoListProjectSnapshot.exists()) throw todoListError("El proyecto no existe.", 404);
    const todoListProject = { id: todoListId, ...todoListProjectSnapshot.val() };
    const todoListMembership = todoListMemberSnapshot.val();
    if (todoListProject.ownerUserId !== todoListUserId && !todoListMembership) {
        throw todoListError("El proyecto no existe o no tienes permiso para acceder.", 404);
    }
    return {
        project: todoListProject,
        role: todoListProject.ownerUserId === todoListUserId ? "owner" : todoListMembership.role
    };
}

async function todoListAssertProjectPermission(todoListId, todoListUserId, write = false, ownerOnly = false) {
    const todoListAccess = await todoListGetProjectAccess(todoListId, todoListUserId);
    const todoListCanWrite = todoListAccess.role === "owner" || todoListAccess.role === "editor";
    if (ownerOnly && todoListAccess.role !== "owner" || write && !todoListCanWrite) {
        throw todoListError("No tienes permiso para modificar este proyecto.", 403);
    }
    return todoListAccess;
}

async function todoListGetItemAccess(todoListItemId, todoListUserId, write = false) {
    const todoListItemSnapshot = await todoListRef(`TodoListItems/${todoListItemId}`).get();
    if (!todoListItemSnapshot.exists()) throw todoListError("La tarea no existe.", 404);
    const todoListItem = { id: todoListItemId, ...todoListItemSnapshot.val() };
    if (todoListItem.todoListId) {
        const todoListAccess = await todoListAssertProjectPermission(
            todoListItem.todoListId,
            todoListUserId,
            write
        );
        return { item: todoListItem, projectRole: todoListAccess.role };
    }

    const todoListIsOwner = todoListItem.createdByUserId === todoListUserId;
    const todoListAssignedToUser = Boolean(
        (await todoListRef(`TodoListItemAssignees/${todoListItemId}/${todoListUserId}`).get()).val()
    );
    if (!todoListIsOwner && !todoListAssignedToUser) {
        throw todoListError("La tarea no existe o no tienes permiso para acceder.", 404);
    }
    if (write && !todoListIsOwner && !todoListAssignedToUser) {
        throw todoListError("No tienes permiso para modificar esta tarea.", 403);
    }
    return { item: todoListItem, projectRole: todoListIsOwner ? "owner" : "assignee" };
}

async function todoListGetRelationshipIds(collection, todoListItemId) {
    const todoListSnapshot = await todoListRef(`${collection}/${todoListItemId}`).get();
    return Object.keys(todoListSnapshot.val() || {}).filter((todoListId) => todoListSnapshot.val()[todoListId]);
}

async function todoListAssertAssignees(todoListItem, todoListAssigneeIds, todoListActorId) {
    const todoListUniqueAssignees = [...new Set(todoListAssigneeIds)];
    let todoListProjectOwnerId = todoListItem.ownerUserId;
    if (todoListItem.todoListId) {
        const { project } = await todoListGetProjectAccess(todoListItem.todoListId, todoListActorId);
        todoListProjectOwnerId = project.ownerUserId;
    }
    for (const todoListAssigneeId of todoListUniqueAssignees) {
        await todoListGetUser(todoListAssigneeId);
        if (todoListItem.todoListId) {
            const todoListMembership = await todoListRef(
                `TodoListMembers/${todoListItem.todoListId}/${todoListAssigneeId}`
            ).get();
            if (todoListAssigneeId !== todoListProjectOwnerId && !todoListMembership.exists()) {
                throw todoListError("Solo se pueden asignar tareas a usuarios del proyecto.", 400);
            }
        } else if (todoListAssigneeId !== todoListActorId) {
            throw todoListError("Añade la tarea a un proyecto compartido para asignarla a otra persona.", 400);
        }
    }
}

async function todoListAssertLabels(todoListLabelIds, todoListOwnerId) {
    for (const todoListLabelId of todoListLabelIds) {
        const todoListLabelSnapshot = await todoListRef(`TodoListLabels/${todoListLabelId}`).get();
        if (!todoListLabelSnapshot.exists() || todoListLabelSnapshot.val().ownerUserId !== todoListOwnerId) {
            throw todoListError("Una de las etiquetas seleccionadas no está disponible.", 400);
        }
    }
}

async function todoListReplaceRelations(collection, todoListItemId, todoListIds) {
    const todoListRefPath = todoListRef(`${collection}/${todoListItemId}`);
    const todoListCurrent = (await todoListRefPath.get()).val() || {};
    const todoListUpdates = {};
    for (const todoListId of Object.keys(todoListCurrent)) {
        if (!todoListIds.includes(todoListId)) todoListUpdates[todoListId] = null;
    }
    for (const todoListId of todoListIds) todoListUpdates[todoListId] = true;
    await todoListRefPath.update(todoListUpdates);
}

async function todoListAddActivity(todoListItemId, todoListUserId, action, previousValue = null, newValue = null) {
    const todoListActivityId = randomUUID();
    await todoListRef(`TodoListActivities/${todoListItemId}/${todoListActivityId}`).set({
        todoListItemId,
        userId: todoListUserId,
        action,
        previousValue,
        newValue,
        createdAt: new Date().toISOString()
    });
}

function todoListAuditedProject(data, projectId, userId) {
    if (typeof projectId !== "string" || !/^[A-Za-z0-9_-]+$/.test(projectId) ||
        typeof userId !== "string" || !/^[A-Za-z0-9_-]+$/.test(userId)) {
        throw todoListError("El identificador solicitado no es válido.");
    }
    const projects = data.TodoLists || {};
    if (!Object.hasOwn(projects, projectId)) throw todoListError("El proyecto no existe.", 404);
    const project = projects[projectId];
    if (project.ownerUserId !== userId) {
        if (!data.TodoListMembers?.[projectId]?.[userId]) {
            throw todoListError("El proyecto no existe o no tienes permiso para acceder.", 404);
        }
        throw todoListError("No tienes permiso para modificar este proyecto.", 403);
    }
    return project;
}

function todoListValidateAuditId(id) {
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]+$/.test(id)) {
        throw todoListError("El identificador solicitado no es válido.");
    }
}

function todoListAuditedProjectResult(data, projectId, project) {
    const sections = Object.entries(data.TodoListSections || {})
        .map(([id, value]) => ({ id, ...value }))
        .filter((section) => section.todoListId === projectId)
        .sort((left, right) => left.position - right.position);
    return { id: projectId, ...project, sections };
}

function todoListAuditedProjects(data, userId) {
    const memberships = data.TodoListMembers || {};
    const items = Object.values(data.TodoListItems || {});
    return Object.entries(data.TodoLists || {})
        .map(([id, project]) => ({ id, ...project }))
        .filter((project) => project.ownerUserId === userId ||
            (Object.hasOwn(memberships, project.id) &&
                Object.hasOwn(memberships[project.id], userId) && Boolean(memberships[project.id][userId])))
        .map((project) => ({
            ...project,
            pendingCount: items.filter((item) => item?.todoListId === project.id &&
                item.status !== "completed" && item.isArchived !== true).length
        }))
        .sort((left, right) => left.position - right.position);
}

async function todoListCreateProject(todoListPayload, todoListUserId) {
    if (isTodoProjectAuditEnabled()) {
        if (typeof todoListUserId !== "string" || !/^[A-Za-z0-9_-]+$/.test(todoListUserId)) {
            throw todoListError("El usuario no está disponible.", 404);
        }
        const id = randomUUID();
        const now = new Date().toISOString();
        return transactTodoProject({ targetId: id, actorId: todoListUserId, action: "todo.project.created",
            change: (data, root) => {
                const users = root.authUsers || {};
                if (!Object.hasOwn(users, todoListUserId) || !users[todoListUserId] || users[todoListUserId].isActive === false) {
                    throw todoListError("El usuario no está disponible.", 404);
                }
                const projects = data.TodoLists || {};
                if (Object.hasOwn(projects, id)) throw todoListError("El proyecto ya existe.", 409);
                const project = {
                    name: todoListNormalizeName(todoListPayload?.name, "El nombre del proyecto"),
                    description: todoListNormalizeDescription(todoListPayload?.description),
                    color: todoListValidateColor(todoListPayload?.color || "blue"),
                    ownerUserId: todoListUserId,
                    position: Object.values(projects).filter((value) => value.ownerUserId === todoListUserId).length,
                    isArchived: false, createdAt: now, updatedAt: now
                };
                data.TodoLists = { ...projects, [id]: project };
                return { value: data, result: { id, ...project } };
            } });
    }
    const todoListOwner = await todoListGetUser(todoListUserId);
    const todoListProjectId = randomUUID();
    const todoListProjects = await todoListRef("TodoLists").get();
    const todoListPosition = todoListValues(todoListProjects)
        .filter((project) => project.ownerUserId === todoListUserId)
        .length;
    const todoListNow = new Date().toISOString();
    const todoListProject = {
        name: todoListNormalizeName(todoListPayload?.name, "El nombre del proyecto"),
        description: todoListNormalizeDescription(todoListPayload?.description),
        color: todoListValidateColor(todoListPayload?.color || "blue"),
        ownerUserId: todoListOwner.id,
        position: todoListPosition,
        isArchived: false,
        createdAt: todoListNow,
        updatedAt: todoListNow
    };
    await todoListRef(`TodoLists/${todoListProjectId}`).set(todoListProject);
    return { id: todoListProjectId, ...todoListProject };
}

async function todoListListProjects(todoListUserId, includeArchived = false) {
    await todoListInitialize();
    const [todoListProjectsSnapshot, todoListMembershipSnapshot, todoListItemsSnapshot] = await Promise.all([
        todoListRef("TodoLists").get(),
        todoListRef("TodoListMembers").get(),
        todoListRef("TodoListItems").get()
    ]);
    const todoListMemberships = todoListMembershipSnapshot.val() || {};
    const todoListItems = Object.entries(todoListItemsSnapshot.val() || {});
    return todoListValues(todoListProjectsSnapshot)
        .filter((project) =>
            project.ownerUserId === todoListUserId ||
            Boolean(todoListMemberships[project.id]?.[todoListUserId])
        )
        .filter((project) => includeArchived || !project.isArchived)
        .map((project) => ({
            ...project,
            pendingCount: todoListItems.filter(([, item]) =>
                item?.todoListId === project.id &&
                item.status !== "completed" &&
                item.isArchived !== true
            ).length
        }))
        .sort((left, right) => left.position - right.position);
}

async function todoListGetProject(todoListId, todoListUserId) {
    const { project } = await todoListGetProjectAccess(todoListId, todoListUserId);
    return {
        ...project,
        sections: await todoListListSections(todoListId, todoListUserId)
    };
}

async function todoListUpdateProject(todoListId, todoListPayload, todoListUserId) {
    if (isTodoProjectAuditEnabled()) {
        todoListValidateAuditId(todoListId);
        todoListValidateAuditId(todoListUserId);
        const now = new Date().toISOString();
        return transactTodoProject({ targetId: todoListId, actorId: todoListUserId, action: "todo.project.updated",
            change: (data) => {
                const project = todoListAuditedProject(data, todoListId, todoListUserId);
                const changes = {};
                if (Object.hasOwn(todoListPayload || {}, "name")) changes.name = todoListNormalizeName(todoListPayload.name, "El nombre del proyecto");
                if (Object.hasOwn(todoListPayload || {}, "description")) changes.description = todoListNormalizeDescription(todoListPayload.description);
                if (Object.hasOwn(todoListPayload || {}, "color")) changes.color = todoListValidateColor(todoListPayload.color);
                if (!Object.keys(changes).length) throw todoListError("No hay cambios para guardar.");
                Object.assign(project, changes, { updatedAt: now });
                return { value: data, result: todoListAuditedProjectResult(data, todoListId, project) };
            } });
    }
    await todoListAssertProjectPermission(todoListId, todoListUserId, true, true);
    const todoListChanges = {};
    if (Object.hasOwn(todoListPayload || {}, "name")) {
        todoListChanges.name = todoListNormalizeName(todoListPayload.name, "El nombre del proyecto");
    }
    if (Object.hasOwn(todoListPayload || {}, "description")) {
        todoListChanges.description = todoListNormalizeDescription(todoListPayload.description);
    }
    if (Object.hasOwn(todoListPayload || {}, "color")) {
        todoListChanges.color = todoListValidateColor(todoListPayload.color);
    }
    if (!Object.keys(todoListChanges).length) throw todoListError("No hay cambios para guardar.");
    todoListChanges.updatedAt = new Date().toISOString();
    await todoListRef(`TodoLists/${todoListId}`).update(todoListChanges);
    return todoListGetProject(todoListId, todoListUserId);
}

async function todoListArchiveProject(todoListId, isArchived, todoListUserId) {
    if (isTodoProjectAuditEnabled()) {
        todoListValidateAuditId(todoListId);
        todoListValidateAuditId(todoListUserId);
        const now = new Date().toISOString();
        return transactTodoProject({ targetId: todoListId, actorId: todoListUserId,
            action: isArchived ? "todo.project.archived" : "todo.project.restored",
            change: (data) => {
                const project = todoListAuditedProject(data, todoListId, todoListUserId);
                if (typeof isArchived !== "boolean") throw todoListError("El valor de archivado no es válido.");
                Object.assign(project, { isArchived, updatedAt: now });
                return { value: data, result: todoListAuditedProjectResult(data, todoListId, project) };
            } });
    }
    await todoListAssertProjectPermission(todoListId, todoListUserId, true, true);
    if (typeof isArchived !== "boolean") throw todoListError("El valor de archivado no es válido.");
    await todoListRef(`TodoLists/${todoListId}`).update({
        isArchived,
        updatedAt: new Date().toISOString()
    });
    return todoListGetProject(todoListId, todoListUserId);
}

async function todoListDeleteProject(todoListId, todoListUserId) {
    if (isTodoProjectAuditEnabled()) {
        todoListValidateAuditId(todoListId);
        todoListValidateAuditId(todoListUserId);
        await transactTodoProject({ targetId: todoListId, actorId: todoListUserId, action: "todo.project.deleted",
            change: (data) => {
                todoListAuditedProject(data, todoListId, todoListUserId);
                if (Object.values(data.TodoListItems || {}).some((item) => item?.todoListId === todoListId)) {
                    throw todoListError("El proyecto contiene tareas. Muévelas o elimínalas antes de borrar el proyecto.", 409);
                }
                delete data.TodoLists[todoListId];
                if (data.TodoListMembers) delete data.TodoListMembers[todoListId];
                for (const [id, section] of Object.entries(data.TodoListSections || {})) {
                    if (section.todoListId === todoListId) delete data.TodoListSections[id];
                }
                return { value: data, result: true };
            } });
        return;
    }
    await todoListAssertProjectPermission(todoListId, todoListUserId, true, true);
    const todoListItemsSnapshot = await todoListRef("TodoListItems").get();
    if (Object.values(todoListItemsSnapshot.val() || {}).some((item) => item?.todoListId === todoListId)) {
        throw todoListError("El proyecto contiene tareas. Muévelas o elimínalas antes de borrar el proyecto.", 409);
    }
    const todoListUpdates = {
        [`TodoLists/${todoListId}`]: null,
        [`TodoListMembers/${todoListId}`]: null
    };
    const todoListSectionsSnapshot = await todoListRef("TodoListSections").get();
    for (const [todoListSectionId, todoListSection] of Object.entries(todoListSectionsSnapshot.val() || {})) {
        if (todoListSection.todoListId === todoListId) {
            todoListUpdates[`TodoListSections/${todoListSectionId}`] = null;
        }
    }
    await todoListRef().update(todoListUpdates);
}

async function todoListReorderProjects(todoListIds, todoListUserId) {
    if (isTodoProjectAuditEnabled()) {
        todoListValidateAuditId(todoListUserId);
        return transactTodoProject({
        targetId: "todoList", actorId: todoListUserId, action: "todo.project.reordered",
        change: (data) => {
            if (!Array.isArray(todoListIds) || new Set(todoListIds).size !== todoListIds.length) {
                throw todoListError("El orden de proyectos no es válido.");
            }
            const owned = Object.entries(data.TodoLists || {}).filter(([, project]) => project.ownerUserId === todoListUserId);
            if (owned.length !== todoListIds.length ||
                todoListIds.some((id) => !owned.some(([ownedId]) => ownedId === id))) {
                throw todoListError("Solo puedes reordenar tus propios proyectos.");
            }
            if (!todoListIds.length) return { unchanged: true, result: todoListAuditedProjects(data, todoListUserId) };
            todoListIds.forEach((id, position) => { data.TodoLists[id].position = position; });
            return { value: data, result: todoListAuditedProjects(data, todoListUserId) };
        }
        });
    }
    if (!Array.isArray(todoListIds) || new Set(todoListIds).size !== todoListIds.length) {
        throw todoListError("El orden de proyectos no es válido.");
    }
    const todoListOwnedProjects = (await todoListListProjects(todoListUserId, true))
        .filter((project) => project.ownerUserId === todoListUserId);
    if (todoListOwnedProjects.length !== todoListIds.length ||
        todoListIds.some((id) => !todoListOwnedProjects.some((project) => project.id === id))) {
        throw todoListError("Solo puedes reordenar tus propios proyectos.");
    }
    const todoListUpdates = {};
    todoListIds.forEach((id, position) => { todoListUpdates[`TodoLists/${id}/position`] = position; });
    await todoListRef().update(todoListUpdates);
    return todoListListProjects(todoListUserId, true);
}

async function todoListGetMembers(todoListId, todoListUserId) {
    await todoListGetProjectAccess(todoListId, todoListUserId);
    const [todoListMemberSnapshot, todoListUsers] = await Promise.all([
        todoListRef(`TodoListMembers/${todoListId}`).get(),
        todoListGetUsers()
    ]);
    const todoListMembers = todoListMemberSnapshot.val() || {};
    return todoListUsers
        .filter((user) => todoListMembers[user.id])
        .map((user) => ({ ...user, role: todoListMembers[user.id].role }));
}

async function todoListAddMember(todoListId, todoListMemberId, role, todoListUserId) {
    if (isTodoProjectAuditEnabled()) {
        todoListValidateAuditId(todoListId);
        todoListValidateAuditId(todoListUserId);
        if (typeof todoListMemberId !== "string" || !/^[A-Za-z0-9_-]+$/.test(todoListMemberId)) {
            throw todoListError("El usuario no está disponible.", 404);
        }
        const now = new Date().toISOString();
        return transactTodoProject({ targetId: todoListMemberId, projectId: todoListId,
            actorId: todoListUserId, action: "todo.member.added",
            change: (data, root) => {
                todoListAuditedProject(data, todoListId, todoListUserId);
                if (!["editor", "viewer"].includes(role)) throw todoListError("El permiso del miembro no es válido.");
                if (typeof todoListMemberId !== "string" || !/^[A-Za-z0-9_-]+$/.test(todoListMemberId)) {
                    throw todoListError("El usuario no está disponible.", 404);
                }
                const users = root.authUsers || {};
                const member = Object.hasOwn(users, todoListMemberId) ? users[todoListMemberId] : null;
                if (!member || member.isActive === false) throw todoListError("El usuario no está disponible.", 404);
                data.TodoListMembers = data.TodoListMembers || {};
                data.TodoListMembers[todoListId] = {
                    ...(Object.hasOwn(data.TodoListMembers, todoListId) ? data.TodoListMembers[todoListId] : {}),
                    [todoListMemberId]: { role, addedByUserId: todoListUserId, addedAt: now }
                };
                return { value: data, result: {
                    id: todoListMemberId, firstName: member.firstName || "", lastName: member.lastName || "",
                    profileImage: member.profileImage || "", role
                } };
            } });
    }
    await todoListAssertProjectPermission(todoListId, todoListUserId, true, true);
    if (!["editor", "viewer"].includes(role)) throw todoListError("El permiso del miembro no es válido.");
    const todoListMember = await todoListGetUser(todoListMemberId);
    const todoListNow = new Date().toISOString();
    await todoListRef(`TodoListMembers/${todoListId}/${todoListMemberId}`).set({
        role,
        addedByUserId: todoListUserId,
        addedAt: todoListNow
    });
    return { ...todoListMember, role };
}

async function todoListRemoveMember(todoListId, todoListMemberId, todoListUserId) {
    if (isTodoProjectAuditEnabled()) {
        todoListValidateAuditId(todoListId);
        todoListValidateAuditId(todoListMemberId);
        todoListValidateAuditId(todoListUserId);
        await transactTodoProject({ targetId: todoListMemberId, projectId: todoListId,
            actorId: todoListUserId, action: "todo.member.removed",
            change: (data) => {
                const project = todoListAuditedProject(data, todoListId, todoListUserId);
                if (typeof todoListMemberId !== "string" || !/^[A-Za-z0-9_-]+$/.test(todoListMemberId)) {
                    throw todoListError("El identificador solicitado no es válido.");
                }
                if (project.ownerUserId === todoListMemberId) {
                    throw todoListError("No se puede retirar al propietario del proyecto.", 409);
                }
                const members = data.TodoListMembers?.[todoListId];
                let changed = Boolean(members && Object.hasOwn(members, todoListMemberId));
                if (members) delete members[todoListMemberId];
                for (const [id, item] of Object.entries(data.TodoListItems || {})) {
                    const assignees = data.TodoListItemAssignees?.[id];
                    if (item.todoListId === todoListId && assignees && Object.hasOwn(assignees, todoListMemberId)) {
                        delete assignees[todoListMemberId];
                        changed = true;
                    }
                }
                return changed ? { value: data, result: true } : { unchanged: true, result: true };
            } });
        return;
    }
    const { project } = await todoListAssertProjectPermission(todoListId, todoListUserId, true, true);
    if (project.ownerUserId === todoListMemberId) {
        throw todoListError("No se puede retirar al propietario del proyecto.", 409);
    }
    await todoListRef(`TodoListMembers/${todoListId}/${todoListMemberId}`).remove();
    const todoListItemsSnapshot = await todoListRef("TodoListItems").get();
    const todoListUpdates = {};
    for (const [todoListItemId, todoListItem] of Object.entries(todoListItemsSnapshot.val() || {})) {
        if (todoListItem.todoListId === todoListId) {
            todoListUpdates[`TodoListItemAssignees/${todoListItemId}/${todoListMemberId}`] = null;
        }
    }
    if (Object.keys(todoListUpdates).length) await todoListRef().update(todoListUpdates);
}

async function todoListListSections(todoListId, todoListUserId) {
    await todoListGetProjectAccess(todoListId, todoListUserId);
    return todoListValues(await todoListRef("TodoListSections").get())
        .filter((section) => section.todoListId === todoListId)
        .sort((left, right) => left.position - right.position);
}

function todoListAuditedSectionProject(data, projectId, userId) {
    todoListValidateAuditId(projectId);
    const projects = data.TodoLists || {};
    if (!Object.hasOwn(projects, projectId) || !projects[projectId]) throw todoListError("El proyecto no existe.", 404);
    if (projects[projectId].ownerUserId === userId) return;
    const memberships = data.TodoListMembers || {};
    const members = Object.hasOwn(memberships, projectId) ? memberships[projectId] : null;
    const member = members && Object.hasOwn(members, userId) ? members[userId] : null;
    if (!member) throw todoListError("El proyecto no existe o no tienes permiso para acceder.", 404);
    if (member.role !== "editor") throw todoListError("No tienes permiso para modificar este proyecto.", 403);
}

function todoListAuditedSection(data, sectionId, userId) {
    const sections = data.TodoListSections || {};
    if (!Object.hasOwn(sections, sectionId) || !sections[sectionId]) throw todoListError("La sección no existe.", 404);
    const section = sections[sectionId];
    todoListAuditedSectionProject(data, section.todoListId, userId);
    return section;
}

function todoListAuditedSections(data, projectId) {
    return Object.entries(data.TodoListSections || {})
        .map(([id, section]) => ({ id, ...section }))
        .filter((section) => section.todoListId === projectId)
        .sort((left, right) => left.position - right.position);
}

async function todoListCreateSection(todoListId, payload, todoListUserId) {
    if (isTodoSectionAuditEnabled()) {
        todoListValidateAuditId(todoListId);
        todoListValidateAuditId(todoListUserId);
        const id = randomUUID();
        const now = new Date().toISOString();
        return transactTodoSection({ targetId: id, actorId: todoListUserId, action: "todo.section.created",
            change: (data) => {
                todoListAuditedSectionProject(data, todoListId, todoListUserId);
                const sections = data.TodoListSections || {};
                if (Object.hasOwn(sections, id)) throw todoListError("La sección ya existe.", 409);
                const section = {
                    todoListId, name: todoListNormalizeName(payload?.name, "El nombre de la sección"),
                    position: todoListAuditedSections(data, todoListId).length, createdAt: now, updatedAt: now
                };
                data.TodoListSections = { ...sections, [id]: section };
                return { value: data, result: { id, ...section } };
            } });
    }
    await todoListAssertProjectPermission(todoListId, todoListUserId, true);
    const todoListSections = await todoListListSections(todoListId, todoListUserId);
    const todoListSectionId = randomUUID();
    const todoListNow = new Date().toISOString();
    const todoListSection = {
        todoListId,
        name: todoListNormalizeName(payload?.name, "El nombre de la sección"),
        position: todoListSections.length,
        createdAt: todoListNow,
        updatedAt: todoListNow
    };
    await todoListRef(`TodoListSections/${todoListSectionId}`).set(todoListSection);
    return { id: todoListSectionId, ...todoListSection };
}

async function todoListGetSectionAccess(todoListSectionId, todoListUserId, write = false) {
    const todoListSectionSnapshot = await todoListRef(`TodoListSections/${todoListSectionId}`).get();
    if (!todoListSectionSnapshot.exists()) throw todoListError("La sección no existe.", 404);
    const todoListSection = { id: todoListSectionId, ...todoListSectionSnapshot.val() };
    await todoListAssertProjectPermission(todoListSection.todoListId, todoListUserId, write);
    return todoListSection;
}

async function todoListUpdateSection(todoListSectionId, payload, todoListUserId) {
    if (isTodoSectionAuditEnabled()) {
        todoListValidateAuditId(todoListSectionId);
        todoListValidateAuditId(todoListUserId);
        const now = new Date().toISOString();
        return transactTodoSection({ targetId: todoListSectionId, actorId: todoListUserId, action: "todo.section.updated",
            change: (data) => {
                const section = todoListAuditedSection(data, todoListSectionId, todoListUserId);
                if (!Object.hasOwn(payload || {}, "name")) throw todoListError("No hay cambios para guardar.");
                section.name = todoListNormalizeName(payload.name, "El nombre de la sección");
                section.updatedAt = now;
                return { value: data, result: { id: todoListSectionId, ...section } };
            } });
    }
    await todoListGetSectionAccess(todoListSectionId, todoListUserId, true);
    const todoListChanges = {};
    if (Object.hasOwn(payload || {}, "name")) {
        todoListChanges.name = todoListNormalizeName(payload.name, "El nombre de la sección");
    }
    if (!Object.keys(todoListChanges).length) throw todoListError("No hay cambios para guardar.");
    todoListChanges.updatedAt = new Date().toISOString();
    await todoListRef(`TodoListSections/${todoListSectionId}`).update(todoListChanges);
    return { id: todoListSectionId, ...(await todoListRef(`TodoListSections/${todoListSectionId}`).get()).val() };
}

async function todoListDeleteSection(todoListSectionId, todoListUserId) {
    if (isTodoSectionAuditEnabled()) {
        todoListValidateAuditId(todoListSectionId);
        todoListValidateAuditId(todoListUserId);
        return transactTodoSection({ targetId: todoListSectionId, actorId: todoListUserId, action: "todo.section.deleted",
            change: (data) => {
                const section = todoListAuditedSection(data, todoListSectionId, todoListUserId);
                if (Object.values(data.TodoListItems || {}).some((item) => item?.sectionId === todoListSectionId)) {
                    throw todoListError("La sección contiene tareas. Muévelas a otra sección antes de eliminarla.", 409);
                }
                const result = { id: todoListSectionId, ...section };
                delete data.TodoListSections[todoListSectionId];
                return { value: data, result };
            } });
    }
    const todoListSection = await todoListGetSectionAccess(todoListSectionId, todoListUserId, true);
    const todoListItemsSnapshot = await todoListRef("TodoListItems").get();
    if (Object.values(todoListItemsSnapshot.val() || {}).some((item) => item?.sectionId === todoListSectionId)) {
        throw todoListError("La sección contiene tareas. Muévelas a otra sección antes de eliminarla.", 409);
    }
    await todoListRef(`TodoListSections/${todoListSectionId}`).remove();
    return todoListSection;
}

async function todoListSetSectionPosition(todoListSectionId, position, todoListUserId) {
    if (isTodoSectionAuditEnabled()) {
        todoListValidateAuditId(todoListSectionId);
        todoListValidateAuditId(todoListUserId);
        return transactTodoSection({ targetId: todoListSectionId, actorId: todoListUserId, action: "todo.section.reordered",
            change: (data) => {
                const section = todoListAuditedSection(data, todoListSectionId, todoListUserId);
                const sections = todoListAuditedSections(data, section.todoListId);
                if (!Number.isInteger(position) || position < 0 || position >= sections.length) {
                    throw todoListError("La posición de la sección no es válida.");
                }
                const [moved] = sections.splice(todoListMovedIndex(sections, todoListSectionId), 1);
                sections.splice(position, 0, moved);
                sections.forEach((item, index) => { data.TodoListSections[item.id].position = index; item.position = index; });
                return { value: data, result: sections };
            } });
    }
    const todoListSection = await todoListGetSectionAccess(todoListSectionId, todoListUserId, true);
    const todoListSections = await todoListListSections(todoListSection.todoListId, todoListUserId);
    if (!Number.isInteger(position) || position < 0 || position >= todoListSections.length) {
        throw todoListError("La posición de la sección no es válida.");
    }
    const todoListReordered = [...todoListSections];
    const [todoListMoved] = todoListReordered.splice(todoListMovedIndex(todoListReordered, todoListSectionId), 1);
    todoListReordered.splice(position, 0, todoListMoved);
    const todoListUpdates = {};
    todoListReordered.forEach((item, index) => {
        todoListUpdates[`TodoListSections/${item.id}/position`] = index;
    });
    await todoListRef().update(todoListUpdates);
    return todoListListSections(todoListSection.todoListId, todoListUserId);
}

function todoListMovedIndex(items, id) {
    return items.findIndex((item) => item.id === id);
}

async function todoListGetLabels(todoListUserId) {
    return todoListValues(await todoListRef("TodoListLabels").get())
        .filter((label) => label.ownerUserId === todoListUserId)
        .sort((left, right) => left.name.localeCompare(right.name));
}

async function todoListCreateLabel(payload, todoListUserId) {
    const todoListName = todoListNormalizeName(payload?.name, "El nombre de la etiqueta");
    if (isTodoLabelAuditEnabled()) {
        todoListValidateAuditId(todoListUserId);
        const id = randomUUID();
        const now = new Date().toISOString();
        return transactTodoLabel({ targetId: id, actorId: todoListUserId, action: "todo.label.created",
            change: (data) => {
                const labels = data.TodoListLabels || {};
                if (Object.hasOwn(labels, id)) throw todoListError("La etiqueta ya existe.", 409);
                if (Object.values(labels).some((label) => label?.ownerUserId === todoListUserId &&
                    label.name.toLocaleLowerCase() === todoListName.toLocaleLowerCase())) {
                    throw todoListError("Ya existe una etiqueta con ese nombre.", 409);
                }
                const label = { name: todoListName, color: todoListValidateLabelColor(payload?.color || "mint"),
                    ownerUserId: todoListUserId, createdAt: now, updatedAt: now };
                data.TodoListLabels = { ...labels, [id]: label };
                return { value: data, result: { id, ...label } };
            } });
    }
    const todoListLabels = await todoListGetLabels(todoListUserId);
    if (todoListLabels.some((label) => label.name.toLocaleLowerCase() === todoListName.toLocaleLowerCase())) {
        throw todoListError("Ya existe una etiqueta con ese nombre.", 409);
    }
    const todoListLabelId = randomUUID();
    const todoListNow = new Date().toISOString();
    const todoListLabel = {
        name: todoListName,
        color: todoListValidateLabelColor(payload?.color || "mint"),
        ownerUserId: todoListUserId,
        createdAt: todoListNow,
        updatedAt: todoListNow
    };
    await todoListRef(`TodoListLabels/${todoListLabelId}`).set(todoListLabel);
    return { id: todoListLabelId, ...todoListLabel };
}

async function todoListUpdateLabel(todoListLabelId, payload, todoListUserId) {
    if (isTodoLabelAuditEnabled()) {
        todoListValidateAuditId(todoListLabelId);
        todoListValidateAuditId(todoListUserId);
        const now = new Date().toISOString();
        return transactTodoLabel({ targetId: todoListLabelId, actorId: todoListUserId, action: "todo.label.updated",
            change: (data) => {
                const labels = data.TodoListLabels || {};
                const label = Object.hasOwn(labels, todoListLabelId) ? labels[todoListLabelId] : null;
                if (!label || label.ownerUserId !== todoListUserId) throw todoListError("La etiqueta no existe.", 404);
                const changes = {};
                if (Object.hasOwn(payload || {}, "name")) {
                    const name = todoListNormalizeName(payload.name, "El nombre de la etiqueta");
                    if (Object.entries(labels).some(([id, other]) => id !== todoListLabelId &&
                        other?.ownerUserId === todoListUserId && other.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
                        throw todoListError("Ya existe una etiqueta con ese nombre.", 409);
                    }
                    changes.name = name;
                }
                if (Object.hasOwn(payload || {}, "color")) changes.color = todoListValidateLabelColor(payload.color);
                if (!Object.keys(changes).length) throw todoListError("No hay cambios para guardar.");
                Object.assign(label, changes, { updatedAt: now });
                return { value: data, result: { id: todoListLabelId, ...label } };
            } });
    }
    const todoListLabelRef = todoListRef(`TodoListLabels/${todoListLabelId}`);
    const todoListSnapshot = await todoListLabelRef.get();
    if (!todoListSnapshot.exists() || todoListSnapshot.val().ownerUserId !== todoListUserId) {
        throw todoListError("La etiqueta no existe.", 404);
    }
    const todoListChanges = {};
    if (Object.hasOwn(payload || {}, "name")) {
        const todoListName = todoListNormalizeName(payload.name, "El nombre de la etiqueta");
        const todoListLabels = await todoListGetLabels(todoListUserId);
        if (todoListLabels.some((label) =>
            label.id !== todoListLabelId && label.name.toLocaleLowerCase() === todoListName.toLocaleLowerCase()
        )) throw todoListError("Ya existe una etiqueta con ese nombre.", 409);
        todoListChanges.name = todoListName;
    }
    if (Object.hasOwn(payload || {}, "color")) todoListChanges.color = todoListValidateLabelColor(payload.color);
    if (!Object.keys(todoListChanges).length) throw todoListError("No hay cambios para guardar.");
    todoListChanges.updatedAt = new Date().toISOString();
    await todoListLabelRef.update(todoListChanges);
    return { id: todoListLabelId, ...todoListSnapshot.val(), ...todoListChanges };
}

async function todoListDeleteLabel(todoListLabelId, todoListUserId) {
    if (isTodoLabelAuditEnabled()) {
        todoListValidateAuditId(todoListLabelId);
        todoListValidateAuditId(todoListUserId);
        await transactTodoLabel({ targetId: todoListLabelId, actorId: todoListUserId, action: "todo.label.deleted",
            change: (data) => {
                const labels = data.TodoListLabels || {};
                const label = Object.hasOwn(labels, todoListLabelId) ? labels[todoListLabelId] : null;
                if (!label || label.ownerUserId !== todoListUserId) throw todoListError("La etiqueta no existe.", 404);
                delete labels[todoListLabelId];
                for (const relations of Object.values(data.TodoListItemLabels || {})) {
                    if (relations && Object.hasOwn(relations, todoListLabelId)) delete relations[todoListLabelId];
                }
                return { value: data, result: true };
            } });
        return;
    }
    const todoListLabelRef = todoListRef(`TodoListLabels/${todoListLabelId}`);
    const todoListLabelSnapshot = await todoListLabelRef.get();
    if (!todoListLabelSnapshot.exists() || todoListLabelSnapshot.val().ownerUserId !== todoListUserId) {
        throw todoListError("La etiqueta no existe.", 404);
    }
    await todoListLabelRef.remove();
    const todoListRelationsSnapshot = await todoListRef("TodoListItemLabels").get();
    const todoListUpdates = {};
    for (const [todoListItemId, todoListRelations] of Object.entries(todoListRelationsSnapshot.val() || {})) {
        if (todoListRelations[todoListLabelId]) {
            todoListUpdates[`TodoListItemLabels/${todoListItemId}/${todoListLabelId}`] = null;
        }
    }
    if (Object.keys(todoListUpdates).length) await todoListRef().update(todoListUpdates);
}

function todoListNormalizeRecurrence(value, dueDate) {
    if (value === null || value === undefined || value === false) return null;
    if (!value || typeof value !== "object" || !TODO_LIST_RECURRENCES.has(value.frequency)) {
        throw todoListError("La configuración de repetición no es válida.");
    }
    if (!dueDate) throw todoListError("Las tareas recurrentes necesitan una fecha de vencimiento.");
    const interval = value.interval === undefined ? 1 : value.interval;
    if (!Number.isInteger(interval) || interval < 1 || interval > 365) {
        throw todoListError("El intervalo de repetición debe estar entre 1 y 365.");
    }
    const daysOfWeek = value.daysOfWeek === undefined ? [] : value.daysOfWeek;
    if (!Array.isArray(daysOfWeek) ||
        daysOfWeek.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) {
        throw todoListError("Los días de repetición no son válidos.");
    }
    const unit = value.unit || "";
    if (value.frequency === "custom" && !["days", "weeks", "months"].includes(unit)) {
        throw todoListError("La unidad de repetición personalizada no es válida.");
    }
    const recurrence = {
        frequency: value.frequency,
        interval,
        daysOfWeek: [...new Set(daysOfWeek)],
        unit,
        startDate: todoListValidateDate(value.startDate || dueDate, "La fecha inicial"),
        endDate: todoListValidateDate(value.endDate || "", "La fecha final"),
        isActive: true
    };
    if (recurrence.endDate && recurrence.endDate < recurrence.startDate) {
        throw todoListError("La fecha final debe ser posterior a la fecha inicial.");
    }
    return recurrence;
}

function todoListAuditedItemDestination(data, root, listId, sectionId, userId, labelIds, assigneeIds, moving = false) {
    let ownerId = userId;
    if (listId) {
        todoListValidateAuditId(listId);
        todoListAuditedSectionProject(data, listId, userId);
        const project = data.TodoLists[listId];
        if (project.isArchived) {
            throw todoListError(moving
                ? "No se pueden mover tareas a un proyecto archivado."
                : "No se pueden añadir tareas a un proyecto archivado.", 409);
        }
        ownerId = project.ownerUserId;
    }
    if (sectionId) {
        todoListValidateAuditId(sectionId);
        const sections = data.TodoListSections || {};
        if (!Object.hasOwn(sections, sectionId) || !sections[sectionId]) throw todoListError("La sección no existe.", 404);
        todoListAuditedSectionProject(data, sections[sectionId].todoListId, userId);
        if (sections[sectionId].todoListId !== listId) throw todoListError("La sección no pertenece al proyecto seleccionado.", 400);
    }
    const labels = data.TodoListLabels || {};
    for (const id of labelIds) {
        todoListValidateAuditId(id);
        if (!Object.hasOwn(labels, id) || labels[id]?.ownerUserId !== ownerId) {
            throw todoListError("Una de las etiquetas seleccionadas no está disponible.", 400);
        }
    }
    const users = root.authUsers || {};
    const memberships = data.TodoListMembers || {};
    const members = listId && Object.hasOwn(memberships, listId) ? memberships[listId] : {};
    for (const id of assigneeIds) {
        if (typeof id !== "string" || !/^[A-Za-z0-9_-]+$/.test(id) ||
            !Object.hasOwn(users, id) || !users[id] || users[id].isActive === false) {
            throw todoListError("El usuario no está disponible.", 404);
        }
        if (listId && id !== ownerId && !Object.hasOwn(members || {}, id)) {
            throw todoListError("Solo se pueden asignar tareas a usuarios del proyecto.", 400);
        }
        if (!listId && id !== userId) {
            throw todoListError("Añade la tarea a un proyecto compartido para asignarla a otra persona.", 400);
        }
    }
    return ownerId;
}

function todoListAuditedItem(data, itemId, userId) {
    const items = data.TodoListItems || {};
    if (!Object.hasOwn(items, itemId) || !items[itemId]) throw todoListError("La tarea no existe.", 404);
    const item = items[itemId];
    if (item.todoListId) todoListAuditedSectionProject(data, item.todoListId, userId);
    else {
        const relations = data.TodoListItemAssignees || {};
        const assignees = Object.hasOwn(relations, itemId) ? relations[itemId] : {};
        if (item.createdByUserId !== userId && !(Object.hasOwn(assignees || {}, userId) && assignees[userId])) {
            throw todoListError("La tarea no existe o no tienes permiso para acceder.", 404);
        }
    }
    return item;
}

function todoListAuditedRelationIds(data, collection, itemId) {
    const relations = data[collection] || {};
    const entry = Object.hasOwn(relations, itemId) ? relations[itemId] : {};
    return Object.keys(entry || {}).filter((id) => entry[id]);
}

function todoListAuditedActivity(data, itemId, activityId, userId, action, previousValue, newValue, now) {
    data.TodoListActivities = data.TodoListActivities || {};
    const activities = Object.hasOwn(data.TodoListActivities, itemId) ? data.TodoListActivities[itemId] : {};
    if (Object.hasOwn(activities || {}, activityId)) throw todoListError("La actividad ya existe.", 409);
    data.TodoListActivities[itemId] = { ...activities, [activityId]: {
        todoListItemId: itemId, userId, action, previousValue, newValue, createdAt: now
    } };
}

async function todoListCreateItem(payload, todoListUserId) {
    if (isTodoItemAuditEnabled()) {
        todoListValidateAuditId(todoListUserId);
        const id = randomUUID();
        const activityId = randomUUID();
        const recurrenceId = randomUUID();
        const now = new Date().toISOString();
        await transactTodoItem({ targetId: id, actorId: todoListUserId, action: "todo.item.created",
            change: (data, root) => {
                const title = todoListNormalizeName(payload?.title, "El título", 200);
                const listId = payload?.todoListId || "";
                const sectionId = payload?.sectionId || "";
                const dueDate = todoListValidateDate(payload?.dueDate || "");
                if (payload?.isImportant !== undefined && typeof payload.isImportant !== "boolean") {
                    throw todoListError("La importancia debe ser verdadera o falsa.");
                }
                const assignees = todoListValidateStringArray(payload?.assigneeUserIds, "Los responsables");
                const labels = todoListValidateStringArray(payload?.labelIds, "Las etiquetas");
                const recurrence = todoListNormalizeRecurrence(payload?.recurrence, dueDate);
                const ownerId = todoListAuditedItemDestination(data, root, listId, sectionId, todoListUserId, labels, assignees);
                const items = data.TodoListItems || {};
                if (Object.hasOwn(items, id)) throw todoListError("La tarea ya existe.", 409);
                if (recurrence && Object.hasOwn(data.TodoListRecurrences || {}, recurrenceId)) {
                    throw todoListError("La recurrencia ya existe.", 409);
                }
                const item = {
                    title, description: todoListNormalizeDescription(payload?.description), todoListId: listId, sectionId,
                    parentItemId: payload?.parentItemId || "", ownerUserId: ownerId, status: "pending",
                    priority: todoListValidatePriority(payload?.priority), isImportant: payload?.isImportant ?? false,
                    dueDate, dueTime: todoListValidateTime(payload?.dueTime || ""),
                    timeZone: todoListValidateTimeZone(payload?.timeZone || "UTC"),
                    recurrenceId: recurrence ? recurrenceId : "",
                    position: Object.values(items).filter((entry) => entry?.todoListId === listId &&
                        entry?.sectionId === sectionId && entry?.isArchived !== true).length,
                    createdByUserId: todoListUserId, completedAt: "", isArchived: false, createdAt: now, updatedAt: now
                };
                data.TodoListItems = { ...items, [id]: item };
                if (labels.length) data.TodoListItemLabels = { ...(data.TodoListItemLabels || {}),
                    [id]: Object.fromEntries(labels.map((label) => [label, true])) };
                if (assignees.length) data.TodoListItemAssignees = { ...(data.TodoListItemAssignees || {}),
                    [id]: Object.fromEntries(assignees.map((assignee) => [assignee, true])) };
                if (recurrence) data.TodoListRecurrences = { ...(data.TodoListRecurrences || {}), [recurrenceId]: {
                    ...recurrence, todoListItemId: id, ownerUserId: todoListUserId, nextDueDate: dueDate
                } };
                todoListAuditedActivity(data, id, activityId, todoListUserId, "created", null, { title }, now);
                return { value: data, result: true };
            } });
        return todoListGetItem(id, todoListUserId);
    }
    const todoListTitle = todoListNormalizeName(payload?.title, "El título", 200);
    const todoListId = payload?.todoListId || "";
    let todoListOwnerUserId = todoListUserId;
    if (todoListId) {
        const { project } = await todoListAssertProjectPermission(todoListId, todoListUserId, true);
        if (project.isArchived) throw todoListError("No se pueden añadir tareas a un proyecto archivado.", 409);
        todoListOwnerUserId = project.ownerUserId;
    }

    const todoListSectionId = payload?.sectionId || "";
    if (todoListSectionId) {
        const todoListSection = await todoListGetSectionAccess(todoListSectionId, todoListUserId);
        if (todoListSection.todoListId !== todoListId) throw todoListError("La sección no pertenece al proyecto.", 400);
    }
    const todoListDueDate = todoListValidateDate(payload?.dueDate || "");
    if (payload?.isImportant !== undefined && typeof payload.isImportant !== "boolean") {
        throw todoListError("La importancia debe ser verdadera o falsa.");
    }
    const todoListAssignees = todoListValidateStringArray(payload?.assigneeUserIds, "Los responsables");
    const todoListLabels = todoListValidateStringArray(payload?.labelIds, "Las etiquetas");
    const todoListRecurrence = todoListNormalizeRecurrence(payload?.recurrence, todoListDueDate);
    const todoListNow = new Date().toISOString();
    const todoListItemId = randomUUID();
    const todoListItems = await todoListRef("TodoListItems").get();
    const todoListPosition = Object.values(todoListItems.val() || {}).filter((item) =>
        item?.todoListId === todoListId && item?.sectionId === todoListSectionId && item?.isArchived !== true
    ).length;
    const todoListItem = {
        title: todoListTitle,
        description: todoListNormalizeDescription(payload?.description),
        todoListId,
        sectionId: todoListSectionId,
        parentItemId: payload?.parentItemId || "",
        ownerUserId: todoListOwnerUserId,
        status: "pending",
        priority: todoListValidatePriority(payload?.priority),
        isImportant: payload?.isImportant ?? false,
        dueDate: todoListDueDate,
        dueTime: todoListValidateTime(payload?.dueTime || ""),
        timeZone: todoListValidateTimeZone(payload?.timeZone || "UTC"),
        recurrenceId: "",
        position: todoListPosition,
        createdByUserId: todoListUserId,
        completedAt: "",
        isArchived: false,
        createdAt: todoListNow,
        updatedAt: todoListNow
    };
    await todoListAssertLabels(todoListLabels, todoListOwnerUserId);
    await todoListAssertAssignees(todoListItem, todoListAssignees, todoListUserId);

    let todoListRecurrenceId = "";
    if (todoListRecurrence) {
        todoListRecurrenceId = randomUUID();
        todoListItem.recurrenceId = todoListRecurrenceId;
    }
    const todoListUpdates = { [`TodoListItems/${todoListItemId}`]: todoListItem };
    for (const todoListLabelId of todoListLabels) {
        todoListUpdates[`TodoListItemLabels/${todoListItemId}/${todoListLabelId}`] = true;
    }
    for (const todoListAssigneeId of todoListAssignees) {
        todoListUpdates[`TodoListItemAssignees/${todoListItemId}/${todoListAssigneeId}`] = true;
    }
    if (todoListRecurrenceId) {
        todoListUpdates[`TodoListRecurrences/${todoListRecurrenceId}`] = {
            ...todoListRecurrence,
            todoListItemId,
            ownerUserId: todoListUserId,
            nextDueDate: todoListDueDate
        };
    }
    await todoListRef().update(todoListUpdates);
    await todoListAddActivity(todoListItemId, todoListUserId, "created", null, { title: todoListTitle });
    return todoListGetItem(todoListItemId, todoListUserId);
}

async function todoListGetDecoratedItems(todoListUserId) {
    const [todoListItemsSnapshot, todoListLabelsSnapshot, todoListAssigneesSnapshot] = await Promise.all([
        todoListRef("TodoListItems").get(),
        todoListRef("TodoListItemLabels").get(),
        todoListRef("TodoListItemAssignees").get()
    ]);
    const todoListItems = todoListItemsSnapshot.val() || {};
    const todoListLabels = todoListLabelsSnapshot.val() || {};
    const todoListAssignees = todoListAssigneesSnapshot.val() || {};
    const todoListVisible = [];

    for (const [todoListItemId, todoListValue] of Object.entries(todoListItems)) {
        try {
            await todoListGetItemAccess(todoListItemId, todoListUserId);
            todoListVisible.push({
                id: todoListItemId,
                ...todoListValue,
                labelIds: Object.keys(todoListLabels[todoListItemId] || {})
                    .filter((id) => todoListLabels[todoListItemId][id]),
                assigneeUserIds: Object.keys(todoListAssignees[todoListItemId] || {})
                    .filter((id) => todoListAssignees[todoListItemId][id])
            });
        } catch (error) {
            if (error.statusCode === 404) continue;
            throw error;
        }
    }
    return todoListVisible;
}

async function todoListListItems(todoListFilters, todoListUserId) {
    const todoListTimeZone = todoListValidateTimeZone(todoListFilters.timeZone || "UTC");
    const todoListToday = todoListGetLocalDate(todoListTimeZone);
    const todoListSearch = String(todoListFilters.search || "").trim().toLocaleLowerCase();
    const todoListLabelFilter = todoListFilters.labelId || "";
    const todoListAssigneeFilter = todoListFilters.assigneeUserId || "";
    const todoListProjectId = todoListFilters.todoListId || "";
    if (todoListProjectId) await todoListGetProjectAccess(todoListProjectId, todoListUserId);
    const todoListSectionId = todoListFilters.sectionId || "";
    const todoListPriority = todoListFilters.priority ? todoListValidatePriority(todoListFilters.priority) : 0;
    const todoListView = todoListFilters.view || "inbox";
    if (!["inbox", "today", "upcoming", "important", "completed", "archived", "project", "overdue", "all"].includes(todoListView)) {
        throw todoListError("La vista solicitada no es válida.");
    }
    let todoListItems = await todoListGetDecoratedItems(todoListUserId);
    const todoListProjects = await todoListListProjects(todoListUserId, true);
    const todoListProjectNames = new Map(todoListProjects.map((project) => [project.id, project.name]));
    const todoListLabels = await todoListGetLabels(todoListUserId);
    const todoListLabelNames = new Map(todoListLabels.map((label) => [label.id, label.name]));

    todoListItems = todoListItems.filter((item) => {
        const isCompleted = item.status === "completed";
        const isArchived = item.isArchived === true;
        if (todoListFilters.status === "completed" && !isCompleted) return false;
        if (todoListFilters.status === "pending" && isCompleted) return false;
        if (todoListView === "inbox" && (item.todoListId || isCompleted || isArchived)) return false;
        if (todoListView === "today" && (item.dueDate !== todoListToday || isCompleted || isArchived)) return false;
        if (todoListView === "upcoming" && (!item.dueDate || item.dueDate < todoListToday || isCompleted || isArchived)) return false;
        if (todoListView === "overdue" && (!item.dueDate || item.dueDate >= todoListToday || isCompleted || isArchived)) return false;
        if (todoListView === "important" && (!item.isImportant || isCompleted || isArchived)) return false;
        if (todoListView === "completed" && !isCompleted) return false;
        if (todoListView === "archived" && !isArchived) return false;
        if (todoListView === "project" && item.todoListId !== todoListProjectId) return false;
        if (!["completed", "archived"].includes(todoListView) && !todoListFilters.includeArchived && isArchived) return false;
        if (todoListProjectId && item.todoListId !== todoListProjectId) return false;
        if (todoListSectionId && item.sectionId !== todoListSectionId) return false;
        if (todoListPriority && item.priority !== todoListPriority) return false;
        if (todoListFilters.important === "true" && !item.isImportant) return false;
        if (todoListFilters.important === "false" && item.isImportant) return false;
        if (todoListLabelFilter && !item.labelIds.includes(todoListLabelFilter)) return false;
        if (todoListAssigneeFilter && !item.assigneeUserIds.includes(todoListAssigneeFilter)) return false;
        if (todoListFilters.overdue === "true" &&
            (!item.dueDate || item.dueDate >= todoListToday || isCompleted || isArchived)) return false;
        if (todoListFilters.noDueDate === "true" && item.dueDate) return false;
        if (todoListFilters.recurring === "true" && !item.recurrenceId) return false;
        if (todoListFilters.dueDate && item.dueDate !== todoListValidateDate(todoListFilters.dueDate)) return false;
        if (todoListSearch) {
            const todoListRelatedLabels = item.labelIds.map((id) => todoListLabelNames.get(id) || "").join(" ");
            const todoListProjectName = todoListProjectNames.get(item.todoListId) || "";
            if (!`${item.title} ${item.description} ${todoListProjectName} ${todoListRelatedLabels}`
                .toLocaleLowerCase().includes(todoListSearch)) return false;
        }
        return true;
    });

    const todoListSortField = ["dueDate", "priority", "createdAt", "updatedAt", "position"].includes(todoListFilters.sort)
        ? todoListFilters.sort
        : "dueDate";
    todoListItems = todoListSort(todoListItems, todoListSortField, todoListFilters.order);
    const todoListPage = Math.max(1, Number.parseInt(todoListFilters.page, 10) || 1);
    const todoListLimit = Math.min(
        TODO_LIST_MAX_PAGE_SIZE,
        Math.max(1, Number.parseInt(todoListFilters.limit, 10) || 100)
    );
    const todoListTotal = todoListItems.length;
    const todoListPageItems = todoListItems.slice((todoListPage - 1) * todoListLimit, todoListPage * todoListLimit);
    const [todoListChildrenSnapshot, todoListCommentsSnapshot] = await Promise.all([
        todoListRef("TodoListChildItems").get(),
        todoListRef("TodoListItemComments").get()
    ]);
    const todoListChildren = todoListChildrenSnapshot.val() || {};
    const todoListComments = todoListCommentsSnapshot.val() || {};

    return {
        items: todoListPageItems.map((item) => {
            const children = Object.values(todoListChildren)
                .filter((child) => child.todoListItemId === item.id);
            const comments = todoListComments[item.id] || {};
            return {
                ...item,
                projectName: todoListProjectNames.get(item.todoListId) || "Bandeja de entrada",
                childCount: children.length,
                completedChildCount: children.filter((child) => child.status === "completed").length,
                commentCount: Object.keys(comments).length
            };
        }),
        total: todoListTotal,
        page: todoListPage,
        limit: todoListLimit,
        pages: Math.ceil(todoListTotal / todoListLimit)
    };
}

async function todoListGetItem(todoListItemId, todoListUserId) {
    const { item } = await todoListGetItemAccess(todoListItemId, todoListUserId);
    const [
        todoListLabelIds,
        todoListAssigneeIds,
        todoListChildrenSnapshot,
        todoListCommentsSnapshot,
        todoListAttachmentsSnapshot,
        todoListRecurrenceSnapshot,
        todoListActivitiesSnapshot,
        todoListRemindersSnapshot
    ] = await Promise.all([
        todoListGetRelationshipIds("TodoListItemLabels", todoListItemId),
        todoListGetRelationshipIds("TodoListItemAssignees", todoListItemId),
        todoListRef("TodoListChildItems").get(),
        todoListRef(`TodoListItemComments/${todoListItemId}`).get(),
        todoListRef(`TodoListItemAttachments/${todoListItemId}`).get(),
        item.recurrenceId ? todoListRef(`TodoListRecurrences/${item.recurrenceId}`).get() : Promise.resolve(null),
        todoListRef(`TodoListActivities/${todoListItemId}`).get(),
        todoListRef(`TodoListReminders/${todoListItemId}`).get()
    ]);
    const todoListUsers = await todoListGetUsers();
    const todoListUserNames = new Map(todoListUsers.map((user) => [user.id, `${user.firstName} ${user.lastName}`.trim()]));
    return {
        ...item,
        labelIds: todoListLabelIds,
        assigneeUserIds: todoListAssigneeIds,
        children: todoListValues(todoListChildrenSnapshot)
            .filter((child) => child.todoListItemId === todoListItemId)
            .sort((left, right) => left.position - right.position),
        comments: todoListValues(todoListCommentsSnapshot)
            .map((comment) => ({
                ...comment,
                authorName: todoListUserNames.get(comment.userId) || "Usuario"
            }))
            .sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
        attachments: await Promise.all(todoListValues(todoListAttachmentsSnapshot).map(async (attachment) => ({
            ...attachment,
            url: await todoListGetAttachmentUrl(attachment.storagePath)
        }))),
        recurrence: todoListRecurrenceSnapshot?.val() || null,
        reminders: todoListValues(todoListRemindersSnapshot),
        activities: todoListValues(todoListActivitiesSnapshot)
            .map((activity) => ({
                ...activity,
                userName: todoListUserNames.get(activity.userId) || "Usuario"
            }))
            .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    };
}

async function todoListUpdateItem(todoListItemId, payload, todoListUserId) {
    const { item: todoListExisting } = await todoListGetItemAccess(todoListItemId, todoListUserId, true);
    const todoListChanges = {};
    if (Object.hasOwn(payload || {}, "title")) {
        todoListChanges.title = todoListNormalizeName(payload.title, "El título", 200);
    }
    if (Object.hasOwn(payload || {}, "description")) {
        todoListChanges.description = todoListNormalizeDescription(payload.description);
    }
    if (Object.hasOwn(payload || {}, "todoListId")) {
        todoListChanges.todoListId = payload.todoListId || "";
        if (todoListChanges.todoListId) {
            const { project } = await todoListAssertProjectPermission(todoListChanges.todoListId, todoListUserId, true);
            if (project.isArchived) throw todoListError("No se pueden mover tareas a un proyecto archivado.", 409);
        }
    }
    const todoListFinalListId = todoListChanges.todoListId ?? todoListExisting.todoListId;
    if (Object.hasOwn(payload || {}, "todoListId")) {
        todoListChanges.ownerUserId = todoListFinalListId
            ? (await todoListGetProjectAccess(todoListFinalListId, todoListUserId)).project.ownerUserId
            : todoListUserId;
    }
    if (Object.hasOwn(payload || {}, "sectionId")) todoListChanges.sectionId = payload.sectionId || "";
    const todoListFinalSectionId = todoListChanges.sectionId ?? todoListExisting.sectionId;
    if (todoListFinalSectionId) {
        const todoListSection = await todoListGetSectionAccess(todoListFinalSectionId, todoListUserId, true);
        if (todoListSection.todoListId !== todoListFinalListId) {
            throw todoListError("La sección no pertenece al proyecto seleccionado.", 400);
        }
    }
    if (Object.hasOwn(payload || {}, "priority")) {
        todoListChanges.priority = todoListValidatePriority(payload.priority);
    }
    if (Object.hasOwn(payload || {}, "isImportant")) {
        if (typeof payload.isImportant !== "boolean") throw todoListError("La importancia debe ser verdadera o falsa.");
        todoListChanges.isImportant = payload.isImportant;
    }
    if (Object.hasOwn(payload || {}, "dueDate")) todoListChanges.dueDate = todoListValidateDate(payload.dueDate);
    if (Object.hasOwn(payload || {}, "dueTime")) todoListChanges.dueTime = todoListValidateTime(payload.dueTime);
    if (Object.hasOwn(payload || {}, "timeZone")) todoListChanges.timeZone = todoListValidateTimeZone(payload.timeZone);
    const todoListHasAssignees = Object.hasOwn(payload || {}, "assigneeUserIds");
    const todoListHasLabels = Object.hasOwn(payload || {}, "labelIds");
    const todoListAssignees = todoListHasAssignees
        ? todoListValidateStringArray(payload.assigneeUserIds, "Los responsables")
        : await todoListGetRelationshipIds("TodoListItemAssignees", todoListItemId);
    const todoListLabels = todoListHasLabels
        ? todoListValidateStringArray(payload.labelIds, "Las etiquetas")
        : await todoListGetRelationshipIds("TodoListItemLabels", todoListItemId);
    const todoListUpdated = { ...todoListExisting, ...todoListChanges };
    await todoListAssertLabels(todoListLabels, todoListFinalListId
        ? (await todoListGetProjectAccess(todoListFinalListId, todoListUserId)).project.ownerUserId
        : todoListUserId);
    await todoListAssertAssignees(todoListUpdated, todoListAssignees, todoListUserId);
    if (Object.hasOwn(payload || {}, "recurrence")) {
        const todoListRecurrence = todoListNormalizeRecurrence(
            payload.recurrence,
            todoListChanges.dueDate ?? todoListExisting.dueDate
        );
        if (todoListRecurrence && !todoListExisting.recurrenceId) {
            const todoListRecurrenceId = randomUUID();
            todoListChanges.recurrenceId = todoListRecurrenceId;
            todoListChanges._recurrence = todoListRecurrence;
        } else if (todoListRecurrence && todoListExisting.recurrenceId) {
            todoListChanges._recurrence = todoListRecurrence;
        } else if (!todoListRecurrence && todoListExisting.recurrenceId) {
            todoListChanges._removeRecurrence = todoListExisting.recurrenceId;
            todoListChanges.recurrenceId = "";
        }
    }

    const todoListInternal = { ...todoListChanges };
    const todoListRecurrenceToSave = todoListInternal._recurrence;
    const todoListRecurrenceToRemove = todoListInternal._removeRecurrence;
    delete todoListInternal._recurrence;
    delete todoListInternal._removeRecurrence;
    if (todoListFinalListId !== todoListExisting.todoListId ||
        todoListFinalSectionId !== todoListExisting.sectionId) {
        todoListInternal.position = Object.values((await todoListRef("TodoListItems").get()).val() || {})
            .filter((other) =>
                other.todoListId === todoListFinalListId &&
                other.sectionId === todoListFinalSectionId &&
                other.isArchived !== true
            ).length;
    }
    if (!Object.keys(todoListInternal).length && !todoListHasAssignees && !todoListHasLabels) {
        throw todoListError("No hay cambios para guardar.");
    }
    todoListInternal.updatedAt = new Date().toISOString();
    const todoListUpdates = { [`TodoListItems/${todoListItemId}`]: { ...todoListExisting, ...todoListInternal } };
    if (todoListHasLabels) {
        const current = await todoListRef(`TodoListItemLabels/${todoListItemId}`).get();
        for (const id of Object.keys(current.val() || {})) {
            if (!todoListLabels.includes(id)) todoListUpdates[`TodoListItemLabels/${todoListItemId}/${id}`] = null;
        }
        for (const id of todoListLabels) todoListUpdates[`TodoListItemLabels/${todoListItemId}/${id}`] = true;
    }
    if (todoListHasAssignees) {
        const current = await todoListRef(`TodoListItemAssignees/${todoListItemId}`).get();
        for (const id of Object.keys(current.val() || {})) {
            if (!todoListAssignees.includes(id)) todoListUpdates[`TodoListItemAssignees/${todoListItemId}/${id}`] = null;
        }
        for (const id of todoListAssignees) todoListUpdates[`TodoListItemAssignees/${todoListItemId}/${id}`] = true;
    }
    if (todoListRecurrenceToSave) {
        const recurrenceId = todoListInternal.recurrenceId || todoListExisting.recurrenceId;
        todoListUpdates[`TodoListRecurrences/${recurrenceId}`] = {
            ...todoListRecurrenceToSave,
            todoListItemId,
            ownerUserId: todoListUserId,
            nextDueDate: todoListInternal.dueDate || todoListExisting.dueDate
        };
    }
    if (todoListRecurrenceToRemove) {
        todoListUpdates[`TodoListRecurrences/${todoListRecurrenceToRemove}/isActive`] = false;
    }
    if (["dueDate", "dueTime", "timeZone"].some((field) => Object.hasOwn(payload || {}, field))) {
        const todoListReminderSnapshot = await todoListRef(`TodoListReminders/${todoListItemId}`).get();
        const todoListUpdatedItem = { ...todoListExisting, ...todoListInternal };
        for (const [reminderId, reminder] of Object.entries(todoListReminderSnapshot.val() || {})) {
            if (!["scheduled", "processing"].includes(reminder.status)) continue;
            if (reminder.type !== "custom" && !todoListUpdatedItem.dueDate) {
                todoListUpdates[`TodoListReminders/${todoListItemId}/${reminderId}/status`] = "cancelled";
            } else {
                if (reminder.type !== "custom") {
                    todoListUpdates[`TodoListReminders/${todoListItemId}/${reminderId}/reminderDateTime`] =
                        todoListReminderDateTime(
                            todoListUpdatedItem.dueDate,
                            todoListUpdatedItem.dueTime,
                            todoListUpdatedItem.timeZone,
                            reminder.type
                        );
                }
                if (reminder.status === "processing") {
                    todoListUpdates[`TodoListReminders/${todoListItemId}/${reminderId}/status`] = "scheduled";
                    todoListUpdates[`TodoListReminders/${todoListItemId}/${reminderId}/processingLeaseUntil`] = null;
                }
            }
        }
    }
    await todoListRef().update(todoListUpdates);
    if (["dueDate", "dueTime", "timeZone"].some((field) => Object.hasOwn(payload || {}, field))) {
        void todoListRunReminderProcessor();
    }
    await todoListAddActivity(todoListItemId, todoListUserId, "updated", null, todoListInternal);
    return todoListGetItem(todoListItemId, todoListUserId);
}

async function todoListDeleteItem(todoListItemId, todoListUserId) {
    const { item: todoListItem, projectRole } = await todoListGetItemAccess(todoListItemId, todoListUserId, true);
    if (!todoListItem.todoListId && todoListItem.createdByUserId !== todoListUserId) {
        throw todoListError("Solo quien creó esta tarea puede eliminarla.", 403);
    }
    if (todoListItem.todoListId && projectRole === "viewer") {
        throw todoListError("No tienes permiso para eliminar esta tarea.", 403);
    }
    const [todoListAttachmentsSnapshot, todoListRemindersSnapshot, todoListChildrenSnapshot] = await Promise.all([
        todoListRef(`TodoListItemAttachments/${todoListItemId}`).get(),
        todoListRef(`TodoListReminders/${todoListItemId}`).get(),
        todoListRef("TodoListChildItems").get()
    ]);
    const todoListAttachments = todoListValues(todoListAttachmentsSnapshot);
    await Promise.all(todoListAttachments.map((attachment) => todoListDeleteAttachment(attachment.storagePath)));
    const todoListUpdates = {
        [`TodoListItems/${todoListItemId}`]: null,
        [`TodoListItemLabels/${todoListItemId}`]: null,
        [`TodoListItemAssignees/${todoListItemId}`]: null,
        [`TodoListItemComments/${todoListItemId}`]: null,
        [`TodoListItemAttachments/${todoListItemId}`]: null,
        [`TodoListActivities/${todoListItemId}`]: null,
        [`TodoListReminders/${todoListItemId}`]: null
    };
    for (const [reminderId, reminder] of Object.entries(todoListRemindersSnapshot.val() || {})) {
        todoListUpdates[`TodoListNotifications/${reminder.userId}/${reminderId}`] = null;
    }
    for (const [id, child] of Object.entries(todoListChildrenSnapshot.val() || {})) {
        if (child.todoListItemId === todoListItemId) todoListUpdates[`TodoListChildItems/${id}`] = null;
    }
    if (todoListItem.recurrenceId) {
        todoListUpdates[`TodoListRecurrences/${todoListItem.recurrenceId}/isActive`] = false;
    }
    await todoListRef().update(todoListUpdates);
}

async function todoListGetRecurrence(todoListRecurrenceId) {
    if (!todoListRecurrenceId) return null;
    return (await todoListRef(`TodoListRecurrences/${todoListRecurrenceId}`).get()).val();
}

async function todoListEnsureNextOccurrence(todoListItem, todoListUserId) {
    if (!todoListItem.recurrenceId) return;
    const todoListRecurrenceRef = todoListRef(`TodoListRecurrences/${todoListItem.recurrenceId}`);
    const todoListInitialRecurrence = await todoListGetRecurrence(todoListItem.recurrenceId);
    if (!todoListInitialRecurrence?.isActive) return;
    if (todoListInitialRecurrence.lastCompletedItemId !== todoListItem.id) {
        const todoListNextDate = todoListNextOccurrenceDate(
            todoListInitialRecurrence.nextDueDate || todoListItem.dueDate,
            todoListInitialRecurrence
        );
        if (todoListInitialRecurrence.endDate && todoListNextDate > todoListInitialRecurrence.endDate) {
            await todoListRecurrenceRef.transaction((current) => {
                if (!current || !current.isActive || current.lastCompletedItemId === todoListItem.id) return;
                return {
                    ...current,
                    isActive: false,
                    lastCompletedItemId: todoListItem.id,
                    updatedAt: new Date().toISOString()
                };
            });
            return;
        }

        const todoListNextItemId = `${todoListItem.recurrenceId}_${todoListNextDate.replaceAll("-", "")}`;
        await todoListRecurrenceRef.transaction((current) => {
            if (!current || !current.isActive || current.lastCompletedItemId === todoListItem.id) return;
            return {
                ...current,
                nextDueDate: todoListNextDate,
                lastCompletedItemId: todoListItem.id,
                lastOccurrenceId: todoListNextItemId,
                updatedAt: new Date().toISOString()
            };
        });
    }
    const todoListRecurrence = await todoListGetRecurrence(todoListItem.recurrenceId);
    if (!todoListRecurrence?.isActive || todoListRecurrence.lastCompletedItemId !== todoListItem.id) return;
    const todoListNextDate = todoListRecurrence.nextDueDate;
    const todoListNextItemId = todoListRecurrence.lastOccurrenceId ||
        `${todoListItem.recurrenceId}_${todoListNextDate.replaceAll("-", "")}`;
    const todoListExistingNext = await todoListRef(`TodoListItems/${todoListNextItemId}`).get();
    if (!todoListExistingNext.exists()) {
        const todoListNow = new Date().toISOString();
        const todoListItemFields = { ...todoListItem };
        delete todoListItemFields.id;
        const todoListNextItem = {
            ...todoListItemFields,
            parentItemId: "",
            status: "pending",
            dueDate: todoListNextDate,
            completedAt: "",
            isArchived: false,
            position: todoListItem.position,
            createdByUserId: todoListUserId,
            createdAt: todoListNow,
            updatedAt: todoListNow
        };
        const todoListCreateResult = await todoListRef(`TodoListItems/${todoListNextItemId}`).transaction(
            (current) => current || todoListNextItem
        );
        if (!todoListCreateResult.committed) return;
        const [todoListLabels, todoListAssignees] = await Promise.all([
            todoListGetRelationshipIds("TodoListItemLabels", todoListItem.id),
            todoListGetRelationshipIds("TodoListItemAssignees", todoListItem.id)
        ]);
        const todoListRelationUpdates = {};
        for (const labelId of todoListLabels) {
            todoListRelationUpdates[`TodoListItemLabels/${todoListNextItemId}/${labelId}`] = true;
        }
        for (const assigneeId of todoListAssignees) {
            todoListRelationUpdates[`TodoListItemAssignees/${todoListNextItemId}/${assigneeId}`] = true;
        }
        if (Object.keys(todoListRelationUpdates).length) await todoListRef().update(todoListRelationUpdates);
        await todoListAddActivity(todoListNextItemId, todoListUserId, "recurrence-generated", null, {
            sourceItemId: todoListItem.id
        });
    }
}

async function todoListSetItemStatus(todoListItemId, status, todoListUserId) {
    if (!["pending", "completed"].includes(status)) throw todoListError("El estado indicado no es válido.");
    const { item: todoListItem } = await todoListGetItemAccess(todoListItemId, todoListUserId, true);
    if (todoListItem.status === status) {
        if (status === "completed") {
            const todoListReminders = (await todoListRef(`TodoListReminders/${todoListItemId}`).get()).val() || {};
            const todoListReminderUpdates = {};
            for (const [reminderId, reminder] of Object.entries(todoListReminders)) {
                if (["scheduled", "processing"].includes(reminder.status)) {
                    todoListReminderUpdates[`TodoListReminders/${todoListItemId}/${reminderId}/status`] = "cancelled";
                    todoListReminderUpdates[`TodoListReminders/${todoListItemId}/${reminderId}/processingLeaseUntil`] = null;
                }
            }
            if (Object.keys(todoListReminderUpdates).length) await todoListRef().update(todoListReminderUpdates);
            await todoListEnsureNextOccurrence(todoListItem, todoListUserId);
        }
        return todoListGetItem(todoListItemId, todoListUserId);
    }
    const todoListNow = new Date().toISOString();
    const todoListUpdates = {
        [`TodoListItems/${todoListItemId}/status`]: status,
        [`TodoListItems/${todoListItemId}/completedAt`]: status === "completed" ? todoListNow : "",
        [`TodoListItems/${todoListItemId}/updatedAt`]: todoListNow
    };
    if (status === "completed") {
        const todoListReminders = (await todoListRef(`TodoListReminders/${todoListItemId}`).get()).val() || {};
        for (const [reminderId, reminder] of Object.entries(todoListReminders)) {
            if (["scheduled", "processing"].includes(reminder.status)) {
                todoListUpdates[`TodoListReminders/${todoListItemId}/${reminderId}/status`] = "cancelled";
                todoListUpdates[`TodoListReminders/${todoListItemId}/${reminderId}/processingLeaseUntil`] = null;
            }
        }
    }
    await todoListRef().update(todoListUpdates);
    if (status === "completed") await todoListEnsureNextOccurrence(todoListItem, todoListUserId);
    await todoListAddActivity(todoListItemId, todoListUserId, status, todoListItem.status, status);
    return todoListGetItem(todoListItemId, todoListUserId);
}

async function todoListSetItemArchive(todoListItemId, isArchived, todoListUserId) {
    if (typeof isArchived !== "boolean") throw todoListError("El estado de archivo no es válido.");
    if (isTodoItemAuditEnabled()) {
        todoListValidateAuditId(todoListItemId);
        todoListValidateAuditId(todoListUserId);
        const now = new Date().toISOString();
        const activityId = randomUUID();
        await transactTodoItem({ targetId: todoListItemId, actorId: todoListUserId,
            action: isArchived ? "todo.item.archived" : "todo.item.unarchived",
            change: (data) => {
                const item = todoListAuditedItem(data, todoListItemId, todoListUserId);
                item.isArchived = isArchived;
                item.updatedAt = now;
                if (isArchived) {
                    const allReminders = data.TodoListReminders || {};
                    const reminders = Object.hasOwn(allReminders, todoListItemId) ? allReminders[todoListItemId] : {};
                    for (const reminder of Object.values(reminders || {})) {
                        if (["scheduled", "processing"].includes(reminder.status)) {
                            reminder.status = "cancelled";
                            delete reminder.processingLeaseUntil;
                        }
                    }
                }
                todoListAuditedActivity(data, todoListItemId, activityId, todoListUserId,
                    isArchived ? "archived" : "unarchived", null, null, now);
                return { value: data, result: true };
            } });
        return todoListGetItem(todoListItemId, todoListUserId);
    }
    const { item: todoListItem } = await todoListGetItemAccess(todoListItemId, todoListUserId, true);
    const todoListUpdates = {
        [`TodoListItems/${todoListItemId}/isArchived`]: isArchived,
        [`TodoListItems/${todoListItemId}/updatedAt`]: new Date().toISOString()
    };
    if (isArchived) {
        const todoListReminders = (await todoListRef(`TodoListReminders/${todoListItemId}`).get()).val() || {};
        for (const [reminderId, reminder] of Object.entries(todoListReminders)) {
            if (["scheduled", "processing"].includes(reminder.status)) {
                todoListUpdates[`TodoListReminders/${todoListItemId}/${reminderId}/status`] = "cancelled";
                todoListUpdates[`TodoListReminders/${todoListItemId}/${reminderId}/processingLeaseUntil`] = null;
            }
        }
    }
    await todoListRef().update(todoListUpdates);
    await todoListAddActivity(todoListItemId, todoListUserId, isArchived ? "archived" : "unarchived");
    return todoListGetItem(todoListItemId, todoListUserId);
}

async function todoListSetItemImportant(todoListItemId, isImportant, todoListUserId) {
    if (typeof isImportant !== "boolean") throw todoListError("La importancia debe ser verdadera o falsa.");
    if (isTodoItemAuditEnabled()) {
        return todoListAuditedItemProperty(todoListItemId, todoListUserId,
            "isImportant", isImportant, "todo.item.importance.updated", "importance");
    }
    const { item: todoListItem } = await todoListGetItemAccess(todoListItemId, todoListUserId, true);
    await todoListRef(`TodoListItems/${todoListItemId}`).update({
        isImportant,
        updatedAt: new Date().toISOString()
    });
    await todoListAddActivity(todoListItemId, todoListUserId, "importance", todoListItem.isImportant, isImportant);
    return todoListGetItem(todoListItemId, todoListUserId);
}

async function todoListSetItemPriority(todoListItemId, priority, todoListUserId) {
    const todoListPriority = todoListValidatePriority(priority);
    if (isTodoItemAuditEnabled()) {
        return todoListAuditedItemProperty(todoListItemId, todoListUserId,
            "priority", todoListPriority, "todo.item.priority.updated", "priority");
    }
    const { item: todoListItem } = await todoListGetItemAccess(todoListItemId, todoListUserId, true);
    await todoListRef(`TodoListItems/${todoListItemId}`).update({
        priority: todoListPriority,
        updatedAt: new Date().toISOString()
    });
    await todoListAddActivity(todoListItemId, todoListUserId, "priority", todoListItem.priority, todoListPriority);
    return todoListGetItem(todoListItemId, todoListUserId);
}

async function todoListAuditedItemProperty(itemId, userId, property, value, action, activity) {
    todoListValidateAuditId(itemId);
    todoListValidateAuditId(userId);
    const now = new Date().toISOString();
    const activityId = randomUUID();
    await transactTodoItem({ targetId: itemId, actorId: userId, action,
        change: (data) => {
            const item = todoListAuditedItem(data, itemId, userId);
            const previousValue = item[property] ?? null;
            item[property] = value;
            item.updatedAt = now;
            todoListAuditedActivity(data, itemId, activityId, userId, activity, previousValue, value, now);
            return { value: data, result: true };
        } });
    return todoListGetItem(itemId, userId);
}

async function todoListMoveItem(todoListItemId, todoListId, sectionId, todoListUserId, position) {
    if (isTodoItemAuditEnabled()) {
        todoListValidateAuditId(todoListItemId);
        todoListValidateAuditId(todoListUserId);
        const activityId = randomUUID();
        const now = new Date().toISOString();
        await transactTodoItem({ targetId: todoListItemId, actorId: todoListUserId, action: "todo.item.moved",
            change: (data, root) => {
                const item = todoListAuditedItem(data, todoListItemId, todoListUserId);
                const listId = todoListId || "";
                const targetSection = sectionId || "";
                if (position !== undefined && (!Number.isInteger(position) || position < 0)) {
                    throw todoListError("La posición no es válida.");
                }
                const labels = todoListAuditedRelationIds(data, "TodoListItemLabels", todoListItemId);
                const assignees = todoListAuditedRelationIds(data, "TodoListItemAssignees", todoListItemId);
                todoListAuditedItemDestination(data, root, listId, targetSection, todoListUserId, labels, assignees, true);
                const items = data.TodoListItems;
                const siblings = (projectId, section) => Object.entries(items).filter(([id, other]) =>
                    id !== todoListItemId && other.todoListId === projectId && other.sectionId === section &&
                    other.isArchived !== true).sort((a, b) => a[1].position - b[1].position);
                const target = siblings(listId, targetSection);
                const index = Math.min(position ?? target.length, target.length);
                const oldList = item.todoListId;
                const oldSection = item.sectionId;
                if (oldList !== listId || oldSection !== targetSection) {
                    siblings(oldList, oldSection).forEach(([, value], order) => { value.position = order; });
                }
                target.splice(index, 0, [todoListItemId, item]);
                target.forEach(([, value], order) => { value.position = order; });
                Object.assign(item, { todoListId: listId, sectionId: targetSection, updatedAt: now });
                todoListAuditedActivity(data, todoListItemId, activityId, todoListUserId, "moved",
                    { todoListId: oldList, sectionId: oldSection }, { todoListId: listId, sectionId: targetSection }, now);
                return { value: data, result: true };
            } });
        return todoListGetItem(todoListItemId, todoListUserId);
    }
    const { item: todoListItem } = await todoListGetItemAccess(todoListItemId, todoListUserId, true);
    const todoListTargetListId = todoListId || "";
    const todoListTargetSectionId = sectionId || "";
    if (position !== undefined && (!Number.isInteger(position) || position < 0)) {
        throw todoListError("La posición no es válida.");
    }
    let todoListTargetOwnerId = todoListUserId;
    if (todoListTargetListId) {
        const { project } = await todoListAssertProjectPermission(todoListTargetListId, todoListUserId, true);
        if (project.isArchived) throw todoListError("No se pueden mover tareas a un proyecto archivado.", 409);
        todoListTargetOwnerId = project.ownerUserId;
    }
    if (todoListTargetSectionId) {
        const todoListSection = await todoListGetSectionAccess(todoListTargetSectionId, todoListUserId, true);
        if (todoListSection.todoListId !== todoListTargetListId) {
            throw todoListError("La sección no pertenece al proyecto seleccionado.", 400);
        }
    }
    const [todoListLabelIds, todoListAssigneeIds] = await Promise.all([
        todoListGetRelationshipIds("TodoListItemLabels", todoListItemId),
        todoListGetRelationshipIds("TodoListItemAssignees", todoListItemId)
    ]);
    await todoListAssertLabels(todoListLabelIds, todoListTargetOwnerId);
    await todoListAssertAssignees({
        ...todoListItem,
        todoListId: todoListTargetListId,
        ownerUserId: todoListTargetOwnerId
    }, todoListAssigneeIds, todoListUserId);
    const todoListItems = (await todoListRef("TodoListItems").get()).val() || {};
    const todoListTargetItems = Object.entries(todoListItems)
        .filter(([id, item]) =>
            id !== todoListItemId &&
            item.todoListId === todoListTargetListId &&
            item.sectionId === todoListTargetSectionId &&
            item.isArchived !== true
        )
        .sort((left, right) => left[1].position - right[1].position);
    const todoListTargetPosition = Math.min(position ?? todoListTargetItems.length, todoListTargetItems.length);
    todoListTargetItems.splice(todoListTargetPosition, 0, [todoListItemId, todoListItem]);
    const todoListNow = new Date().toISOString();
    const todoListUpdatedItem = {
        ...todoListItem,
        todoListId: todoListTargetListId,
        sectionId: todoListTargetSectionId,
        position: todoListTargetPosition,
        updatedAt: todoListNow
    };
    const todoListUpdates = { [`TodoListItems/${todoListItemId}`]: todoListUpdatedItem };
    todoListTargetItems.forEach(([id], index) => {
        if (id !== todoListItemId) todoListUpdates[`TodoListItems/${id}/position`] = index;
    });
    if (todoListItem.todoListId !== todoListTargetListId ||
        todoListItem.sectionId !== todoListTargetSectionId) {
        Object.entries(todoListItems)
            .filter(([id, item]) =>
                id !== todoListItemId &&
                item.todoListId === todoListItem.todoListId &&
                item.sectionId === todoListItem.sectionId &&
                item.isArchived !== true
            )
            .sort((left, right) => left[1].position - right[1].position)
            .forEach(([id], index) => {
                todoListUpdates[`TodoListItems/${id}/position`] = index;
            });
    }
    await todoListRef().update(todoListUpdates);
    await todoListAddActivity(todoListItemId, todoListUserId, "moved", {
        todoListId: todoListItem.todoListId,
        sectionId: todoListItem.sectionId
    }, { todoListId: todoListTargetListId, sectionId: todoListTargetSectionId });
    return todoListGetItem(todoListItemId, todoListUserId);
}

async function todoListSetItemPosition(todoListItemId, position, todoListUserId) {
    if (isTodoItemAuditEnabled()) {
        todoListValidateAuditId(todoListItemId);
        todoListValidateAuditId(todoListUserId);
        await transactTodoItem({ targetId: todoListItemId, actorId: todoListUserId, action: "todo.item.reordered",
            change: (data) => {
                const item = todoListAuditedItem(data, todoListItemId, todoListUserId);
                if (!Number.isInteger(position) || position < 0) throw todoListError("La posición no es válida.");
                const siblings = Object.entries(data.TodoListItems).filter(([id, other]) =>
                    id !== todoListItemId && other.todoListId === item.todoListId &&
                    other.sectionId === item.sectionId && other.isArchived !== true)
                    .sort((left, right) => left[1].position - right[1].position);
                siblings.splice(Math.min(position, siblings.length), 0, [todoListItemId, item]);
                siblings.forEach(([, value], index) => { value.position = index; });
                return { value: data, result: true };
            } });
        return todoListGetItem(todoListItemId, todoListUserId);
    }
    const { item: todoListItem } = await todoListGetItemAccess(todoListItemId, todoListUserId, true);
    if (!Number.isInteger(position) || position < 0) throw todoListError("La posición no es válida.");
    const todoListItems = (await todoListRef("TodoListItems").get()).val() || {};
    const todoListSiblings = Object.entries(todoListItems)
        .filter(([id, item]) =>
            id !== todoListItemId &&
            item.todoListId === todoListItem.todoListId &&
            item.sectionId === todoListItem.sectionId &&
            item.isArchived !== true
        )
        .sort((left, right) => left[1].position - right[1].position);
    todoListSiblings.splice(Math.min(position, todoListSiblings.length), 0, [todoListItemId, todoListItem]);
    const todoListUpdates = {};
    todoListSiblings.forEach(([id], index) => { todoListUpdates[`TodoListItems/${id}/position`] = index; });
    await todoListRef().update(todoListUpdates);
    return todoListGetItem(todoListItemId, todoListUserId);
}

async function todoListDuplicateItem(todoListItemId, todoListUserId) {
    const todoListItem = await todoListGetItem(todoListItemId, todoListUserId);
    return todoListCreateItem({
        title: `${todoListItem.title} (copia)`,
        description: todoListItem.description,
        todoListId: todoListItem.todoListId,
        sectionId: todoListItem.sectionId,
        priority: todoListItem.priority,
        isImportant: todoListItem.isImportant,
        dueDate: todoListItem.dueDate,
        dueTime: todoListItem.dueTime,
        timeZone: todoListItem.timeZone,
        labelIds: todoListItem.labelIds,
        assigneeUserIds: todoListItem.assigneeUserIds
    }, todoListUserId);
}

async function todoListListChildren(todoListItemId, todoListUserId) {
    await todoListGetItemAccess(todoListItemId, todoListUserId);
    return todoListValues(await todoListRef("TodoListChildItems").get())
        .filter((child) => child.todoListItemId === todoListItemId)
        .sort((left, right) => left.position - right.position);
}

async function todoListCreateChild(todoListItemId, payload, todoListUserId) {
    if (isTodoItemAuditEnabled()) {
        todoListValidateAuditId(todoListItemId);
        todoListValidateAuditId(todoListUserId);
        const id = randomUUID();
        const activityId = randomUUID();
        const now = new Date().toISOString();
        const title = todoListNormalizeName(payload?.title, "El título de la subtarea", 200);
        return transactTodoItem({ targetId: id, actorId: todoListUserId, action: "todo.child.created",
            change: (data) => {
                todoListAuditedItem(data, todoListItemId, todoListUserId);
                const children = data.TodoListChildItems || {};
                if (Object.hasOwn(children, id)) throw todoListError("La subtarea ya existe.", 409);
                const child = {
                    todoListItemId, title, status: "pending",
                    position: Object.values(children).filter((entry) => entry?.todoListItemId === todoListItemId).length,
                    createdAt: now, completedAt: ""
                };
                data.TodoListChildItems = { ...children, [id]: child };
                todoListAuditedActivity(data, todoListItemId, activityId, todoListUserId, "child-created", null, title, now);
                return { value: data, result: { id, ...child } };
            } });
    }
    const { item: todoListParent } = await todoListGetItemAccess(todoListItemId, todoListUserId, true);
    const todoListChildren = await todoListListChildren(todoListItemId, todoListUserId);
    const todoListChildId = randomUUID();
    const todoListNow = new Date().toISOString();
    const todoListChild = {
        todoListItemId,
        title: todoListNormalizeName(payload?.title, "El título de la subtarea", 200),
        status: "pending",
        position: todoListChildren.length,
        createdAt: todoListNow,
        completedAt: ""
    };
    await todoListRef(`TodoListChildItems/${todoListChildId}`).set(todoListChild);
    await todoListAddActivity(todoListItemId, todoListUserId, "child-created", null, todoListChild.title);
    return { id: todoListChildId, ...todoListChild };
}

async function todoListUpdateChild(todoListChildId, payload, todoListUserId) {
    if (isTodoItemAuditEnabled()) {
        todoListValidateAuditId(todoListChildId);
        todoListValidateAuditId(todoListUserId);
        const now = new Date().toISOString();
        const activityId = randomUUID();
        return transactTodoItem({ targetId: todoListChildId, actorId: todoListUserId, action: "todo.child.updated",
            change: (data) => {
                const children = data.TodoListChildItems || {};
                const child = Object.hasOwn(children, todoListChildId) ? children[todoListChildId] : null;
                if (!child) throw todoListError("La subtarea no existe.", 404);
                todoListValidateAuditId(child.todoListItemId);
                todoListAuditedItem(data, child.todoListItemId, todoListUserId);
                const changes = {};
                if (Object.hasOwn(payload || {}, "title")) {
                    changes.title = todoListNormalizeName(payload.title, "El título de la subtarea", 200);
                }
                if (Object.hasOwn(payload || {}, "status")) {
                    if (!["pending", "completed"].includes(payload.status)) throw todoListError("El estado de la subtarea no es válido.");
                    changes.status = payload.status;
                    changes.completedAt = payload.status === "completed" ? now : "";
                }
                if (Object.hasOwn(payload || {}, "position")) {
                    if (!Number.isInteger(payload.position) || payload.position < 0) throw todoListError("La posición no es válida.");
                    changes.position = payload.position;
                }
                if (!Object.keys(changes).length) throw todoListError("No hay cambios para guardar.");
                Object.assign(child, changes);
                todoListAuditedActivity(data, child.todoListItemId, activityId, todoListUserId, "child-updated", null, changes, now);
                return { value: data, result: { id: todoListChildId, ...child } };
            } });
    }
    const todoListChildSnapshot = await todoListRef(`TodoListChildItems/${todoListChildId}`).get();
    if (!todoListChildSnapshot.exists()) throw todoListError("La subtarea no existe.", 404);
    const todoListChild = { id: todoListChildId, ...todoListChildSnapshot.val() };
    await todoListGetItemAccess(todoListChild.todoListItemId, todoListUserId, true);
    const todoListChanges = {};
    if (Object.hasOwn(payload || {}, "title")) {
        todoListChanges.title = todoListNormalizeName(payload.title, "El título de la subtarea", 200);
    }
    if (Object.hasOwn(payload || {}, "status")) {
        if (!["pending", "completed"].includes(payload.status)) throw todoListError("El estado de la subtarea no es válido.");
        todoListChanges.status = payload.status;
        todoListChanges.completedAt = payload.status === "completed" ? new Date().toISOString() : "";
    }
    if (Object.hasOwn(payload || {}, "position")) {
        if (!Number.isInteger(payload.position) || payload.position < 0) throw todoListError("La posición no es válida.");
        todoListChanges.position = payload.position;
    }
    if (!Object.keys(todoListChanges).length) throw todoListError("No hay cambios para guardar.");
    await todoListRef(`TodoListChildItems/${todoListChildId}`).update(todoListChanges);
    await todoListAddActivity(todoListChild.todoListItemId, todoListUserId, "child-updated", null, todoListChanges);
    return { ...todoListChild, ...todoListChanges };
}

async function todoListDeleteChild(todoListChildId, todoListUserId) {
    if (isTodoItemAuditEnabled()) {
        todoListValidateAuditId(todoListChildId);
        todoListValidateAuditId(todoListUserId);
        const now = new Date().toISOString();
        const activityId = randomUUID();
        await transactTodoItem({ targetId: todoListChildId, actorId: todoListUserId, action: "todo.child.deleted",
            change: (data) => {
                const children = data.TodoListChildItems || {};
                const child = Object.hasOwn(children, todoListChildId) ? children[todoListChildId] : null;
                if (!child) throw todoListError("La subtarea no existe.", 404);
                todoListValidateAuditId(child.todoListItemId);
                todoListAuditedItem(data, child.todoListItemId, todoListUserId);
                delete children[todoListChildId];
                todoListAuditedActivity(data, child.todoListItemId, activityId, todoListUserId, "child-deleted", child.title, null, now);
                return { value: data, result: true };
            } });
        return;
    }
    const todoListChildSnapshot = await todoListRef(`TodoListChildItems/${todoListChildId}`).get();
    if (!todoListChildSnapshot.exists()) throw todoListError("La subtarea no existe.", 404);
    const todoListChild = todoListChildSnapshot.val();
    await todoListGetItemAccess(todoListChild.todoListItemId, todoListUserId, true);
    await todoListRef(`TodoListChildItems/${todoListChildId}`).remove();
    await todoListAddActivity(todoListChild.todoListItemId, todoListUserId, "child-deleted", todoListChild.title);
}

async function todoListAddComment(todoListItemId, payload, todoListUserId) {
    if (isTodoItemAuditEnabled()) {
        todoListValidateAuditId(todoListItemId);
        todoListValidateAuditId(todoListUserId);
        const id = randomUUID();
        const activityId = randomUUID();
        const now = new Date().toISOString();
        return transactTodoItem({ targetId: id, actorId: todoListUserId, action: "todo.comment.created",
            change: (data, root) => {
                todoListAuditedItem(data, todoListItemId, todoListUserId);
                const users = root.authUsers || {};
                const user = Object.hasOwn(users, todoListUserId) ? users[todoListUserId] : null;
                if (!user || user.isActive === false) throw todoListError("El usuario no está disponible.", 404);
                const allComments = data.TodoListItemComments || {};
                const comments = Object.hasOwn(allComments, todoListItemId) ? allComments[todoListItemId] : {};
                if (Object.hasOwn(comments || {}, id)) throw todoListError("El comentario ya existe.", 409);
                const comment = {
                    todoListItemId, userId: todoListUserId,
                    content: todoListNormalizeName(payload?.content, "El comentario", 4000), createdAt: now, updatedAt: now
                };
                data.TodoListItemComments = { ...allComments, [todoListItemId]: { ...comments, [id]: comment } };
                todoListAuditedActivity(data, todoListItemId, activityId, todoListUserId, "comment-added", null, null, now);
                return { value: data, result: { id, ...comment,
                    authorName: `${user.firstName || ""} ${user.lastName || ""}`.trim() } };
            } });
    }
    await todoListGetItemAccess(todoListItemId, todoListUserId, true);
    const todoListUser = await todoListGetUser(todoListUserId);
    const todoListCommentId = randomUUID();
    const todoListNow = new Date().toISOString();
    const todoListComment = {
        todoListItemId,
        userId: todoListUserId,
        content: todoListNormalizeName(payload?.content, "El comentario", 4000),
        createdAt: todoListNow,
        updatedAt: todoListNow
    };
    await todoListRef(`TodoListItemComments/${todoListItemId}/${todoListCommentId}`).set(todoListComment);
    await todoListAddActivity(todoListItemId, todoListUserId, "comment-added");
    return { id: todoListCommentId, ...todoListComment, authorName: `${todoListUser.firstName} ${todoListUser.lastName}`.trim() };
}

async function todoListListComments(todoListItemId, todoListUserId) {
    await todoListGetItemAccess(todoListItemId, todoListUserId);
    const [todoListCommentsSnapshot, todoListUsers] = await Promise.all([
        todoListRef(`TodoListItemComments/${todoListItemId}`).get(),
        todoListGetUsers()
    ]);
    const todoListUserNames = new Map(
        todoListUsers.map((user) => [user.id, `${user.firstName} ${user.lastName}`.trim()])
    );
    return todoListValues(todoListCommentsSnapshot)
        .map((comment) => ({
            ...comment,
            authorName: todoListUserNames.get(comment.userId) || "Usuario"
        }))
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

async function todoListUpdateComment(todoListCommentId, payload, todoListUserId) {
    if (isTodoItemAuditEnabled()) {
        todoListValidateAuditId(todoListCommentId);
        todoListValidateAuditId(todoListUserId);
        const now = new Date().toISOString();
        const activityId = randomUUID();
        return transactTodoItem({ targetId: todoListCommentId, actorId: todoListUserId, action: "todo.comment.updated",
            change: (data) => {
                const { itemId, comment } = todoListAuditedComment(data, todoListCommentId, todoListUserId);
                if (comment.userId !== todoListUserId) throw todoListError("Solo el autor puede editar este comentario.", 403);
                comment.content = todoListNormalizeName(payload?.content, "El comentario", 4000);
                comment.updatedAt = now;
                todoListAuditedActivity(data, itemId, activityId, todoListUserId, "comment-updated", null, null, now);
                return { value: data, result: { id: todoListCommentId, ...comment } };
            } });
    }
    const todoListCommentsSnapshot = await todoListRef("TodoListItemComments").get();
    let todoListCommentEntry;
    for (const [todoListItemId, comments] of Object.entries(todoListCommentsSnapshot.val() || {})) {
        if (comments[todoListCommentId]) {
            todoListCommentEntry = { itemId: todoListItemId, comment: comments[todoListCommentId] };
            break;
        }
    }
    if (!todoListCommentEntry) throw todoListError("El comentario no existe.", 404);
    await todoListGetItemAccess(todoListCommentEntry.itemId, todoListUserId, true);
    if (todoListCommentEntry.comment.userId !== todoListUserId) {
        throw todoListError("Solo el autor puede editar este comentario.", 403);
    }
    const content = todoListNormalizeName(payload?.content, "El comentario", 4000);
    const updatedAt = new Date().toISOString();
    await todoListRef(`TodoListItemComments/${todoListCommentEntry.itemId}/${todoListCommentId}`).update({
        content,
        updatedAt
    });
    await todoListAddActivity(todoListCommentEntry.itemId, todoListUserId, "comment-updated");
    return { id: todoListCommentId, ...todoListCommentEntry.comment, content, updatedAt };
}

async function todoListDeleteComment(todoListCommentId, todoListUserId) {
    if (isTodoItemAuditEnabled()) {
        todoListValidateAuditId(todoListCommentId);
        todoListValidateAuditId(todoListUserId);
        const now = new Date().toISOString();
        const activityId = randomUUID();
        await transactTodoItem({ targetId: todoListCommentId, actorId: todoListUserId, action: "todo.comment.deleted",
            change: (data) => {
                const { itemId, item, comment } = todoListAuditedComment(data, todoListCommentId, todoListUserId);
                const ownerId = item.todoListId ? data.TodoLists[item.todoListId].ownerUserId : item.createdByUserId;
                if (comment.userId !== todoListUserId && ownerId !== todoListUserId) {
                    throw todoListError("No tienes permiso para eliminar este comentario.", 403);
                }
                delete data.TodoListItemComments[itemId][todoListCommentId];
                todoListAuditedActivity(data, itemId, activityId, todoListUserId, "comment-deleted", null, null, now);
                return { value: data, result: true };
            } });
        return;
    }
    const todoListCommentsSnapshot = await todoListRef("TodoListItemComments").get();
    let todoListCommentEntry;
    for (const [todoListItemId, comments] of Object.entries(todoListCommentsSnapshot.val() || {})) {
        if (comments[todoListCommentId]) {
            todoListCommentEntry = { itemId: todoListItemId, comment: comments[todoListCommentId] };
            break;
        }
    }
    if (!todoListCommentEntry) throw todoListError("El comentario no existe.", 404);
    const { projectRole } = await todoListGetItemAccess(todoListCommentEntry.itemId, todoListUserId, true);
    if (todoListCommentEntry.comment.userId !== todoListUserId && projectRole !== "owner") {
        throw todoListError("No tienes permiso para eliminar este comentario.", 403);
    }
    await todoListRef(`TodoListItemComments/${todoListCommentEntry.itemId}/${todoListCommentId}`).remove();
    await todoListAddActivity(todoListCommentEntry.itemId, todoListUserId, "comment-deleted");
}

function todoListAuditedComment(data, commentId, userId) {
    for (const [itemId, comments] of Object.entries(data.TodoListItemComments || {})) {
        if (comments && Object.hasOwn(comments, commentId) && comments[commentId]) {
            todoListValidateAuditId(itemId);
            return { itemId, item: todoListAuditedItem(data, itemId, userId), comment: comments[commentId] };
        }
    }
    throw todoListError("El comentario no existe.", 404);
}

async function todoListAddAttachment(todoListItemId, todoListFile, todoListUserId) {
    await todoListGetItemAccess(todoListItemId, todoListUserId, true);
    const todoListAttachment = await todoListUploadAttachment(todoListItemId, todoListFile, todoListUserId);
    try {
        await todoListRef(`TodoListItemAttachments/${todoListItemId}/${todoListAttachment.id}`).set(todoListAttachment);
    } catch (error) {
        await todoListDeleteAttachment(todoListAttachment.storagePath);
        throw error;
    }
    await todoListAddActivity(todoListItemId, todoListUserId, "attachment-added", null, todoListAttachment.fileName);
    return {
        ...todoListAttachment,
        url: await todoListGetAttachmentUrl(todoListAttachment.storagePath)
    };
}

async function todoListDeleteAttachmentById(todoListAttachmentId, todoListUserId) {
    const todoListAttachmentsSnapshot = await todoListRef("TodoListItemAttachments").get();
    let todoListAttachmentEntry;
    for (const [todoListItemId, attachments] of Object.entries(todoListAttachmentsSnapshot.val() || {})) {
        if (attachments[todoListAttachmentId]) {
            todoListAttachmentEntry = { itemId: todoListItemId, attachment: attachments[todoListAttachmentId] };
            break;
        }
    }
    if (!todoListAttachmentEntry) throw todoListError("El archivo adjunto no existe.", 404);
    await todoListGetItemAccess(todoListAttachmentEntry.itemId, todoListUserId, true);
    await todoListDeleteAttachment(todoListAttachmentEntry.attachment.storagePath);
    await todoListRef(
        `TodoListItemAttachments/${todoListAttachmentEntry.itemId}/${todoListAttachmentId}`
    ).remove();
    await todoListAddActivity(todoListAttachmentEntry.itemId, todoListUserId, "attachment-deleted");
}

function todoListReminderDateTime(dueDate, dueTime, timeZone, reminderType, customDateTime) {
    if (reminderType === "custom") {
        const custom = new Date(customDateTime);
        if (!customDateTime || Number.isNaN(custom.getTime())) throw todoListError("La fecha del recordatorio no es válida.");
        return custom.toISOString();
    }
    if (!dueDate) throw todoListError("Añade una fecha a la tarea para programar un recordatorio.");
    const dueClock = dueTime || "09:00";
    const offsets = { at_due: 0, before_15m: -15, before_1h: -60, before_1d: -1440 };
    if (!Object.hasOwn(offsets, reminderType)) throw todoListError("El tipo de recordatorio no es válido.");
    const [hours, minutes] = dueClock.split(":").map(Number);
    const dueAsUtc = new Date(`${dueDate}T${dueClock}:00.000Z`);
    let instant = dueAsUtc.getTime();
    for (let iteration = 0; iteration < 3; iteration += 1) {
        const parts = new Intl.DateTimeFormat("en-CA", {
            timeZone,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            hourCycle: "h23"
        }).formatToParts(new Date(instant));
        const current = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
        const represented = Date.UTC(
            Number(current.year),
            Number(current.month) - 1,
            Number(current.day),
            Number(current.hour),
            Number(current.minute)
        );
        const expected = Date.UTC(
            Number(dueDate.slice(0, 4)),
            Number(dueDate.slice(5, 7)) - 1,
            Number(dueDate.slice(8, 10)),
            hours,
            minutes
        );
        instant += expected - represented;
    }
    return new Date(instant + offsets[reminderType] * 60000).toISOString();
}

async function todoListListReminders(todoListItemId, todoListUserId) {
    await todoListGetItemAccess(todoListItemId, todoListUserId);
    return todoListValues(await todoListRef(`TodoListReminders/${todoListItemId}`).get());
}

async function todoListCreateReminder(todoListItemId, payload, todoListUserId) {
    const { item } = await todoListGetItemAccess(todoListItemId, todoListUserId, true);
    if (item.status === "completed" || item.isArchived) {
        throw todoListError("No se pueden programar recordatorios para tareas completadas o archivadas.", 409);
    }
    const todoListReminderType = payload?.type || "at_due";
    const todoListReminderId = randomUUID();
    const todoListReminder = {
        todoListItemId,
        userId: todoListUserId,
        reminderDateTime: todoListReminderDateTime(
            item.dueDate,
            item.dueTime,
            item.timeZone,
            todoListReminderType,
            payload?.reminderDateTime
        ),
        type: todoListReminderType,
        status: "scheduled",
        createdAt: new Date().toISOString()
    };
    await todoListRef(`TodoListReminders/${todoListItemId}/${todoListReminderId}`).set(todoListReminder);
    // El procesado en caliente es solo una optimización para la app en marcha; en
    // tests (o si el worker no arrancó) el recordatorio lo recoge el procesador.
    if (todoListReminderWorkerStarted &&
        new Date(todoListReminder.reminderDateTime) <= new Date()) {
        void todoListRunReminderProcessor();
    }
    return { id: todoListReminderId, ...todoListReminder };
}

async function todoListUpdateReminder(todoListReminderId, payload, todoListUserId) {
    const todoListRemindersSnapshot = await todoListRef("TodoListReminders").get();
    let todoListEntry;
    for (const [itemId, reminders] of Object.entries(todoListRemindersSnapshot.val() || {})) {
        if (reminders[todoListReminderId]) {
            todoListEntry = { itemId, reminder: reminders[todoListReminderId] };
            break;
        }
    }
    if (!todoListEntry) throw todoListError("El recordatorio no existe.", 404);
    await todoListGetItemAccess(todoListEntry.itemId, todoListUserId, true);
    if (todoListEntry.reminder.userId !== todoListUserId) {
        throw todoListError("No tienes permiso para modificar este recordatorio.", 403);
    }
    const todoListItem = (await todoListRef(`TodoListItems/${todoListEntry.itemId}`).get()).val();
    if (todoListEntry.reminder.status === "triggered" || todoListEntry.reminder.status === "cancelled") {
        throw todoListError("Este recordatorio ya no se puede modificar.", 409);
    }
    if (todoListItem.status === "completed" || todoListItem.isArchived) {
        throw todoListError("No se pueden modificar recordatorios de tareas completadas o archivadas.", 409);
    }
    const todoListChanges = {};
    if (Object.hasOwn(payload || {}, "reminderDateTime")) {
        todoListChanges.reminderDateTime = todoListReminderDateTime(
            todoListItem.dueDate,
            todoListItem.dueTime,
            todoListItem.timeZone,
            "custom",
            payload.reminderDateTime
        );
        todoListChanges.type = "custom";
        todoListChanges.status = "scheduled";
        todoListChanges.processingLeaseUntil = null;
    }
    if (Object.hasOwn(payload || {}, "status")) {
        if (!["scheduled", "cancelled"].includes(payload.status)) throw todoListError("El estado del recordatorio no es válido.");
        todoListChanges.status = payload.status;
        if (payload.status === "scheduled") {
            if (todoListItem.status === "completed" || todoListItem.isArchived) {
                throw todoListError("No se pueden programar recordatorios para tareas completadas o archivadas.", 409);
            }
            todoListChanges.processingLeaseUntil = null;
        }
    }
    if (!Object.keys(todoListChanges).length) throw todoListError("No hay cambios para guardar.");
    await todoListRef(`TodoListReminders/${todoListEntry.itemId}/${todoListReminderId}`).update(todoListChanges);
    if (todoListChanges.status === "scheduled" && todoListReminderWorkerStarted &&
        new Date(todoListChanges.reminderDateTime ?? todoListEntry.reminder.reminderDateTime) <= new Date()) {
        void todoListRunReminderProcessor();
    }
    return { id: todoListReminderId, ...todoListEntry.reminder, ...todoListChanges };
}

async function todoListDeleteReminder(todoListReminderId, todoListUserId) {
    const todoListRemindersSnapshot = await todoListRef("TodoListReminders").get();
    for (const [todoListItemId, reminders] of Object.entries(todoListRemindersSnapshot.val() || {})) {
        if (reminders[todoListReminderId]) {
            await todoListGetItemAccess(todoListItemId, todoListUserId, true);
            if (reminders[todoListReminderId].userId !== todoListUserId) {
                throw todoListError("No tienes permiso para eliminar este recordatorio.", 403);
            }
            await todoListRef(`TodoListReminders/${todoListItemId}/${todoListReminderId}`).remove();
            return;
        }
    }
    throw todoListError("El recordatorio no existe.", 404);
}

async function todoListProcessDueReminders() {
    const todoListSnapshot = await todoListRef("TodoListReminders").get();
    const todoListNow = new Date();
    const todoListDue = [];
    for (const [todoListItemId, todoListReminders] of Object.entries(todoListSnapshot.val() || {})) {
        for (const [todoListReminderId, todoListReminder] of Object.entries(todoListReminders || {})) {
            const todoListLeaseExpired = todoListReminder.status === "processing" &&
                (!todoListReminder.processingLeaseUntil ||
                    new Date(todoListReminder.processingLeaseUntil) <= todoListNow);
            if ((todoListReminder.status === "scheduled" &&
                    new Date(todoListReminder.reminderDateTime) <= todoListNow) ||
                todoListLeaseExpired) {
                todoListDue.push({ todoListItemId, todoListReminderId, todoListReminder });
            }
        }
    }
    for (const due of todoListDue) {
        const todoListReminderRef = todoListRef(
            `TodoListReminders/${due.todoListItemId}/${due.todoListReminderId}`
        );
        const todoListLeaseUntil = new Date(todoListNow.getTime() + 5 * 60 * 1000).toISOString();
        const todoListClaim = await todoListReminderRef.transaction((current) => {
            if (!current) return;
            const isDue = current.status === "scheduled" &&
                new Date(current.reminderDateTime) <= todoListNow;
            const isExpiredProcessing = current.status === "processing" &&
                (!current.processingLeaseUntil || new Date(current.processingLeaseUntil) <= todoListNow);
            if (!isDue && !isExpiredProcessing) return;
            return {
                ...current,
                status: "processing",
                processingLeaseUntil: todoListLeaseUntil
            };
        });
        if (!todoListClaim.committed) continue;
        const todoListItemSnapshot = await todoListRef(`TodoListItems/${due.todoListItemId}`).get();
        if (!todoListItemSnapshot.exists() ||
            todoListItemSnapshot.val().status === "completed" ||
            todoListItemSnapshot.val().isArchived === true) {
            await todoListReminderRef.transaction((current) => {
                if (!current || current.status !== "processing") return;
                return { ...current, status: "cancelled", processingLeaseUntil: null };
            });
            continue;
        }
        const todoListNotificationId = due.todoListReminderId;
        const todoListNotificationRef = todoListRef(
            `TodoListNotifications/${due.todoListReminder.userId}/${todoListNotificationId}`
        );
        await todoListNotificationRef.set({
            id: todoListNotificationId,
            userId: due.todoListReminder.userId,
            todoListItemId: due.todoListItemId,
            reminderId: due.todoListReminderId,
            type: "task_reminder",
            title: todoListItemSnapshot.val().title,
            message: "Tienes una tarea pendiente.",
            createdAt: todoListNow.toISOString(),
            isRead: false
        });
        const todoListCompletion = await todoListReminderRef.transaction((current) => {
            if (!current || current.status !== "processing") return;
            return {
                ...current,
                status: "triggered",
                triggeredAt: todoListNow.toISOString(),
                processingLeaseUntil: null
            };
        });
        if (!todoListCompletion.committed) {
            const [todoListCurrentReminder, todoListCurrentItem] = await Promise.all([
                todoListReminderRef.get(),
                todoListRef(`TodoListItems/${due.todoListItemId}`).get()
            ]);
            if (todoListCurrentReminder.val()?.status !== "triggered" ||
                !todoListCurrentItem.exists() ||
                todoListCurrentItem.val().status === "completed" ||
                todoListCurrentItem.val().isArchived === true) {
                await todoListNotificationRef.remove();
            }
        }
    }
}

let todoListReminderWorkerStarted = false;
let todoListReminderProcessing;
let todoListReminderTimer;
function todoListStartReminderWorker() {
    if (todoListReminderWorkerStarted) return;
    todoListReminderWorkerStarted = true;
    todoListReminderTimer = setInterval(() => {
        void todoListRunReminderProcessor();
    }, 30 * 1000);
    todoListReminderTimer.unref();
    void todoListRunReminderProcessor();
}

function todoListStopReminderWorker() {
    if (todoListReminderTimer) clearInterval(todoListReminderTimer);
    todoListReminderTimer = null;
    todoListReminderWorkerStarted = false;
}

function todoListRunReminderProcessor() {
    if (todoListReminderProcessing) return todoListReminderProcessing;
    todoListReminderProcessing = todoListProcessDueReminders()
        .catch((error) => {
            console.error("No se pudieron procesar los recordatorios del módulo Tareas.", error);
        })
        .finally(() => {
            todoListReminderProcessing = null;
        });
    return todoListReminderProcessing;
}

async function todoListGetNotifications(todoListUserId) {
    todoListStartReminderWorker();
    return todoListValues(await todoListRef(`TodoListNotifications/${todoListUserId}`).get())
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

async function todoListMarkNotificationRead(todoListNotificationId, todoListUserId) {
    const todoListNotificationRef = todoListRef(`TodoListNotifications/${todoListUserId}/${todoListNotificationId}`);
    const todoListNotificationSnapshot = await todoListNotificationRef.get();
    if (!todoListNotificationSnapshot.exists()) throw todoListError("La notificación no existe.", 404);
    await todoListNotificationRef.update({ isRead: true, readAt: new Date().toISOString() });
}

async function todoListGetOverview(todoListUserId, timeZone = "UTC") {
    await todoListInitialize();
    const todoListTimeZone = todoListValidateTimeZone(timeZone);
    const [todoListProjects, todoListLabels, todoListUsers, todoListNotifications] = await Promise.all([
        todoListListProjects(todoListUserId),
        todoListGetLabels(todoListUserId),
        todoListGetUsers(),
        todoListGetNotifications(todoListUserId)
    ]);
    const todoListVisibleItems = await todoListGetDecoratedItems(todoListUserId);
    const todoListPending = todoListVisibleItems.filter((item) => item.status !== "completed" && !item.isArchived);
    const todoListToday = todoListGetLocalDate(todoListTimeZone);
    return {
        projects: todoListProjects,
        labels: todoListLabels,
        users: todoListUsers,
        counts: {
            inbox: todoListPending.filter((item) => !item.todoListId).length,
            today: todoListPending.filter((item) => item.dueDate === todoListToday).length,
            upcoming: todoListPending.filter((item) => item.dueDate && item.dueDate >= todoListToday).length,
            overdue: todoListPending.filter((item) => item.dueDate && item.dueDate < todoListToday).length,
            important: todoListPending.filter((item) => item.isImportant).length,
            completed: todoListVisibleItems.filter((item) => item.status === "completed").length,
            archived: todoListVisibleItems.filter((item) => item.isArchived).length,
            assignedToMe: todoListVisibleItems.filter((item) =>
                item.assigneeUserIds.includes(todoListUserId) && !item.isArchived
            ).length,
            total: todoListVisibleItems.length,
            unreadNotifications: todoListNotifications.filter((item) => !item.isRead).length
        },
        notifications: todoListNotifications.slice(0, 10)
    };
}

module.exports = {
    todoListAddAttachment,
    todoListAddComment,
    todoListAddMember,
    todoListArchiveProject,
    todoListCreateChild,
    todoListCreateLabel,
    todoListCreateProject,
    todoListCreateReminder,
    todoListCreateSection,
    todoListCreateItem,
    todoListDeleteAttachmentById,
    todoListDeleteChild,
    todoListDeleteComment,
    todoListDeleteItem,
    todoListDeleteLabel,
    todoListDeleteProject,
    todoListDeleteReminder,
    todoListDeleteSection,
    todoListDuplicateItem,
    todoListGetItem,
    todoListGetLocalDate,
    todoListGetMembers,
    todoListGetNotifications,
    todoListGetOverview,
    todoListGetProject,
    todoListGetUsers,
    todoListListChildren,
    todoListListComments,
    todoListListItems,
    todoListListProjects,
    todoListListReminders,
    todoListListSections,
    todoListMarkNotificationRead,
    todoListMoveItem,
    todoListNextOccurrenceDate,
    todoListProcessDueReminders,
    todoListRemoveMember,
    todoListReorderProjects,
    todoListSetItemArchive,
    todoListSetItemImportant,
    todoListSetItemPosition,
    todoListSetItemPriority,
    todoListSetItemStatus,
    todoListSetSectionPosition,
    todoListStartReminderWorker,
    todoListStopReminderWorker,
    todoListUpdateChild,
    todoListUpdateComment,
    todoListUpdateItem,
    todoListUpdateLabel,
    todoListUpdateProject,
    todoListUpdateReminder,
    todoListUpdateSection
};
