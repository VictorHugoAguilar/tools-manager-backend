const test = require("node:test");
const assert = require("node:assert/strict");
const firebaseAdmin = require("../../src/config/firebaseAdmin");

let database = {};

function readPath(path) {
    return path.split("/").filter(Boolean).reduce((value, part) => value?.[part], database);
}

function writePath(path, value) {
    const segments = path.split("/").filter(Boolean);
    if (!segments.length) {
        database = value === null ? {} : structuredClone(value);
        return;
    }

    let node = database;
    for (const segment of segments.slice(0, -1)) {
        if (!node[segment] || typeof node[segment] !== "object") node[segment] = {};
        node = node[segment];
    }
    if (value === null) delete node[segments.at(-1)];
    else node[segments.at(-1)] = structuredClone(value);
}

function snapshot(value) {
    return {
        exists: () => value !== null && value !== undefined,
        val: () => value === undefined ? null : structuredClone(value)
    };
}

function reference(path = "") {
    return {
        child(childPath) {
            return reference([path, childPath].filter(Boolean).join("/"));
        },
        async get() {
            return snapshot(readPath(path));
        },
        async set(value) {
            writePath(path, value);
        },
        async update(changes) {
            for (const [key, value] of Object.entries(changes)) {
                writePath([path, key].filter(Boolean).join("/"), value);
            }
        },
        async remove() {
            writePath(path, null);
        },
        async transaction(update) {
            const current = readPath(path);
            const next = update(current === undefined ? null : structuredClone(current));
            if (next === undefined) return { committed: false, snapshot: snapshot(current) };
            writePath(path, next);
            return { committed: true, snapshot: snapshot(next) };
        }
    };
}

firebaseAdmin.getAdminDatabase = () => ({ ref: reference });
const todoList = require("../../src/services/todoListService");

const todoListOwner = { id: "owner-1", firstName: "Ada", lastName: "Lovelace" };
const todoListEditor = { id: "editor-1", firstName: "Grace", lastName: "Hopper" };
const todoListViewer = { id: "viewer-1", firstName: "Katherine", lastName: "Johnson" };

test.beforeEach(() => {
    database = {
        authUsers: {
            [todoListOwner.id]: todoListOwner,
            [todoListEditor.id]: todoListEditor,
            [todoListViewer.id]: todoListViewer
        }
    };
});

test("todoList projects isolate access and enforce viewer write restrictions", async () => {
    const project = await todoList.todoListCreateProject({ name: "Proyecto" }, todoListOwner.id);
    await assert.rejects(
        todoList.todoListGetProject(project.id, todoListViewer.id),
        { statusCode: 404 }
    );

    await todoList.todoListAddMember(project.id, todoListViewer.id, "viewer", todoListOwner.id);
    assert.equal((await todoList.todoListGetProject(project.id, todoListViewer.id)).id, project.id);
    await assert.rejects(
        todoList.todoListCreateItem({ title: "No permitido", todoListId: project.id }, todoListViewer.id),
        { statusCode: 403 }
    );
});

test("todoList assignments use active users, project membership, and the shared assignee relation", async () => {
    const project = await todoList.todoListCreateProject({ name: "Proyecto compartido" }, todoListOwner.id);
    await todoList.todoListAddMember(project.id, todoListEditor.id, "editor", todoListOwner.id);
    await todoList.todoListAddMember(project.id, todoListViewer.id, "viewer", todoListOwner.id);
    const item = await todoList.todoListCreateItem({
        title: "Tarea asignada",
        todoListId: project.id,
        assigneeUserIds: [todoListEditor.id, todoListOwner.id]
    }, todoListOwner.id);

    assert.deepEqual(
        Object.keys(database.todoList.TodoListItemAssignees[item.id]).sort(),
        [todoListEditor.id, todoListOwner.id].sort()
    );
    const availableUsers = await todoList.todoListGetUsers();
    assert.deepEqual(availableUsers.map((user) => user.id).sort(), [todoListEditor.id, todoListOwner.id, todoListViewer.id].sort());

    const assignedItems = await todoList.todoListListItems({
        view: "all",
        assigneeUserId: todoListEditor.id,
        limit: 100
    }, todoListEditor.id);
    assert.equal(assignedItems.items.length, 1);
    assert.equal(assignedItems.items[0].id, item.id);
    assert.equal((await todoList.todoListGetOverview(todoListEditor.id)).counts.assignedToMe, 1);

    await todoList.todoListUpdateItem(item.id, {
        assigneeUserIds: [todoListOwner.id]
    }, todoListOwner.id);
    assert.deepEqual(Object.keys(database.todoList.TodoListItemAssignees[item.id]), [todoListOwner.id]);

    const viewerItem = await todoList.todoListCreateItem({
        title: "Tarea para persona lectora",
        todoListId: project.id,
        assigneeUserIds: [todoListViewer.id]
    }, todoListOwner.id);
    await assert.rejects(
        todoList.todoListUpdateItem(viewerItem.id, { title: "Edición no permitida" }, todoListViewer.id),
        { statusCode: 403 }
    );
});

test("todoList item listing includes comment counts without exposing comment bodies", async () => {
    const item = await todoList.todoListCreateItem({ title: "Comentarios" }, todoListOwner.id);
    await todoList.todoListAddComment(item.id, { content: "Primero" }, todoListOwner.id);
    await todoList.todoListAddComment(item.id, { content: "Segundo" }, todoListOwner.id);

    const result = await todoList.todoListListItems({
        view: "all",
        limit: 100
    }, todoListOwner.id);
    const listedItem = result.items.find((entry) => entry.id === item.id);

    assert.equal(listedItem.commentCount, 2);
    assert.equal(Object.hasOwn(listedItem, "comments"), false);
});

test("todoList labels accept custom hex colors and reject invalid colors", async () => {
    const label = await todoList.todoListCreateLabel({ name: "Personalizada", color: "#12aBcF" }, todoListOwner.id);
    assert.equal(label.color, "#12aBcF");

    const updatedLabel = await todoList.todoListUpdateLabel(label.id, { color: "#abcdef" }, todoListOwner.id);
    assert.equal(updatedLabel.color, "#abcdef");

    await assert.rejects(
        todoList.todoListCreateLabel({ name: "Color inválido", color: "javascript:alert(1)" }, todoListOwner.id),
        { statusCode: 400, message: "El color seleccionado no es válido." }
    );
    await assert.rejects(
        todoList.todoListCreateProject({ name: "Color no permitido", color: "#12aBcF" }, todoListOwner.id),
        { statusCode: 400, message: "El color seleccionado no es válido." }
    );
});

test("todoList assignments reject users outside the project membership", async () => {
    const project = await todoList.todoListCreateProject({ name: "Proyecto privado" }, todoListOwner.id);
    await assert.rejects(
        todoList.todoListCreateItem({
            title: "Asignación no permitida",
            todoListId: project.id,
            assigneeUserIds: [todoListEditor.id]
        }, todoListOwner.id),
        { statusCode: 400, message: "Solo se pueden asignar tareas a usuarios del proyecto." }
    );
});

test("todoList moving an item persists its section and target position together", async () => {
    const project = await todoList.todoListCreateProject({ name: "Proyecto Kanban" }, todoListOwner.id);
    const todoListBacklog = await todoList.todoListCreateSection(project.id, { name: "Pendiente" }, todoListOwner.id);
    const todoListDoing = await todoList.todoListCreateSection(project.id, { name: "En curso" }, todoListOwner.id);
    const firstItem = await todoList.todoListCreateItem({
        title: "Primera tarjeta",
        todoListId: project.id,
        sectionId: todoListDoing.id
    }, todoListOwner.id);
    const secondItem = await todoList.todoListCreateItem({
        title: "Segunda tarjeta",
        todoListId: project.id,
        sectionId: todoListDoing.id
    }, todoListOwner.id);
    const movedItem = await todoList.todoListCreateItem({
        title: "Tarjeta a mover",
        todoListId: project.id,
        sectionId: todoListBacklog.id
    }, todoListOwner.id);
    const remainingBacklogItem = await todoList.todoListCreateItem({
        title: "Tarjeta restante",
        todoListId: project.id,
        sectionId: todoListBacklog.id
    }, todoListOwner.id);

    await todoList.todoListMoveItem(movedItem.id, project.id, todoListDoing.id, todoListOwner.id, 1);

    const storedItems = database.todoList.TodoListItems;
    assert.equal(storedItems[movedItem.id].sectionId, todoListDoing.id);
    assert.deepEqual(
        [firstItem.id, movedItem.id, secondItem.id]
            .sort((left, right) => storedItems[left].position - storedItems[right].position),
        [firstItem.id, movedItem.id, secondItem.id]
    );
    assert.equal(storedItems[firstItem.id].position, 0);
    assert.equal(storedItems[movedItem.id].position, 1);
    assert.equal(storedItems[secondItem.id].position, 2);
    assert.equal(storedItems[remainingBacklogItem.id].position, 0);
});

test("todoList recurring item completion creates exactly one next occurrence", async () => {
    const project = await todoList.todoListCreateProject({ name: "Proyecto" }, todoListOwner.id);
    const item = await todoList.todoListCreateItem({
        title: "Revisar equipo",
        todoListId: project.id,
        dueDate: "2026-06-01",
        recurrence: { frequency: "daily" }
    }, todoListOwner.id);

    await todoList.todoListSetItemStatus(item.id, "completed", todoListOwner.id);
    await todoList.todoListSetItemStatus(item.id, "completed", todoListOwner.id);

    const result = await todoList.todoListListItems({
        view: "project",
        todoListId: project.id,
        status: "pending",
        limit: 100
    }, todoListOwner.id);
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].dueDate, "2026-06-02");
    const storedOccurrence = database.todoList.TodoListItems[result.items[0].id];
    assert.equal(Object.hasOwn(storedOccurrence, "id"), false);
});

test("todoList completes non-recurring items without looking up an empty recurrence id", async () => {
    const item = await todoList.todoListCreateItem({ title: "Tarea normal" }, todoListOwner.id);

    const completedItem = await todoList.todoListSetItemStatus(item.id, "completed", todoListOwner.id);

    assert.equal(completedItem.status, "completed");
    assert.ok(completedItem.completedAt);
});

test("todoList changing a reminder date marks it as custom", async () => {
    const item = await todoList.todoListCreateItem({
        title: "Aviso",
        dueDate: "2026-06-01",
        timeZone: "UTC"
    }, todoListOwner.id);
    const reminder = await todoList.todoListCreateReminder(item.id, { type: "before_1h" }, todoListOwner.id);

    const updated = await todoList.todoListUpdateReminder(reminder.id, {
        reminderDateTime: "2026-05-30T10:00:00.000Z"
    }, todoListOwner.id);

    assert.equal(updated.type, "custom");
    assert.equal(updated.reminderDateTime, "2026-05-30T10:00:00.000Z");
});

test("todoList due reminders create one persistent notification", async () => {
    const item = await todoList.todoListCreateItem({ title: "Aviso ejecutable" }, todoListOwner.id);
    const reminder = await todoList.todoListCreateReminder(item.id, {
        type: "custom",
        reminderDateTime: "2000-01-01T10:00:00.000Z"
    }, todoListOwner.id);

    await todoList.todoListProcessDueReminders();

    assert.equal(database.todoList.TodoListReminders[item.id][reminder.id].status, "triggered");
    assert.equal(database.todoList.TodoListNotifications[todoListOwner.id][reminder.id].todoListItemId, item.id);
    assert.equal(database.todoList.TodoListNotifications[todoListOwner.id][reminder.id].type, "task_reminder");
    await todoList.todoListProcessDueReminders();
    assert.equal(Object.keys(database.todoList.TodoListNotifications[todoListOwner.id]).length, 1);
});

test("todoList completing or archiving a task cancels pending reminders", async () => {
    const completedItem = await todoList.todoListCreateItem({ title: "Tarea completada" }, todoListOwner.id);
    const completedReminder = await todoList.todoListCreateReminder(completedItem.id, {
        type: "custom",
        reminderDateTime: "2099-01-01T10:00:00.000Z"
    }, todoListOwner.id);
    database.todoList.TodoListReminders[completedItem.id][completedReminder.id].reminderDateTime =
        "2000-01-01T10:00:00.000Z";
    await todoList.todoListSetItemStatus(completedItem.id, "completed", todoListOwner.id);

    const archivedItem = await todoList.todoListCreateItem({ title: "Tarea archivada" }, todoListOwner.id);
    const archivedReminder = await todoList.todoListCreateReminder(archivedItem.id, {
        type: "custom",
        reminderDateTime: "2099-01-01T10:00:00.000Z"
    }, todoListOwner.id);
    database.todoList.TodoListReminders[archivedItem.id][archivedReminder.id].reminderDateTime =
        "2000-01-01T10:00:00.000Z";
    await todoList.todoListSetItemArchive(archivedItem.id, true, todoListOwner.id);

    await todoList.todoListProcessDueReminders();

    assert.equal(database.todoList.TodoListReminders[completedItem.id][completedReminder.id].status, "cancelled");
    assert.equal(database.todoList.TodoListReminders[archivedItem.id][archivedReminder.id].status, "cancelled");
    assert.equal(database.todoList.TodoListNotifications?.[todoListOwner.id]?.[completedReminder.id], undefined);
    assert.equal(database.todoList.TodoListNotifications?.[todoListOwner.id]?.[archivedReminder.id], undefined);
});

test("todoList date changes reschedule relative reminders and clear them without a due date", async () => {
    const item = await todoList.todoListCreateItem({
        title: "Reprogramar aviso",
        dueDate: "2099-01-01",
        dueTime: "12:00",
        timeZone: "UTC"
    }, todoListOwner.id);
    const reminder = await todoList.todoListCreateReminder(item.id, { type: "before_1h" }, todoListOwner.id);

    await todoList.todoListUpdateItem(item.id, { dueDate: "2100-01-01" }, todoListOwner.id);
    assert.equal(
        database.todoList.TodoListReminders[item.id][reminder.id].reminderDateTime,
        "2100-01-01T11:00:00.000Z"
    );
    await todoList.todoListUpdateItem(item.id, { dueDate: "" }, todoListOwner.id);
    assert.equal(database.todoList.TodoListReminders[item.id][reminder.id].status, "cancelled");
});

test("todoList rejects malformed identifiers and empty item updates", async () => {
    await assert.rejects(
        todoList.todoListGetProject("../authUsers", todoListOwner.id),
        { statusCode: 400 }
    );
    const item = await todoList.todoListCreateItem({ title: "Tarea" }, todoListOwner.id);
    await assert.rejects(
        todoList.todoListUpdateItem(item.id, {}, todoListOwner.id),
        { statusCode: 400, message: "No hay cambios para guardar." }
    );
});
