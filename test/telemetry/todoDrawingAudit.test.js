const test = require("node:test");
const assert = require("node:assert/strict");
const { loadModuleWithMocks } = require("../helpers/loadModuleWithMocks");
const {
    transactTodoProject, transactTodoSection, transactTodoItem, transactTodoLabel, transactDrawingDocument, transactDrawingPage,
    isTodoSectionAuditEnabled, isTodoItemAuditEnabled, isTodoLabelAuditEnabled
} = require("../../src/audit/businessOutbox");
const { AuditOutboxWorker } = require("../../src/audit/outboxWorker");

function harness(initial = {}) {
    let root = structuredClone(initial);
    let retry;
    let fail = false;
    const database = {
        ref(path) {
            if (!path) return { async transaction(callback) {
                if (fail) throw new Error("database unavailable");
                let result = callback(structuredClone(root));
                if (retry) {
                    retry(root);
                    retry = undefined;
                    result = callback(structuredClone(root));
                }
                if (result === undefined) return { committed: false };
                root = result;
                return { committed: true };
            } };
            if (path !== "auditOutbox") {
                function ref(currentPath) {
                    return {
                        child(child) { return ref(`${currentPath}/${child}`); },
                        async get() {
                            const value = currentPath.split("/").filter(Boolean).reduce((parent, key) =>
                                parent && Object.hasOwn(parent, key) ? parent[key] : undefined, root);
                            return { exists: () => value != null, val: () => value == null ? null : structuredClone(value) };
                        }
                    };
                }
                return ref(path);
            }
            return {
                orderByKey() { return this; },
                limitToFirst() { return this; },
                async get() { return { forEach(callback) {
                    for (const [key, event] of Object.entries(root.auditOutbox || {})) {
                        callback({ key, val: () => structuredClone(event) });
                    }
                } }; },
                child(id) { return { async transaction(callback) {
                    const value = callback(root.auditOutbox[id]);
                    if (value === null) delete root.auditOutbox[id];
                    return { committed: value !== undefined };
                } }; }
            };
        }
    };
    const audit = {
        isTodoProjectAuditEnabled: () => true,
        isTodoSectionAuditEnabled: () => true,
        isTodoItemAuditEnabled: () => true,
        isTodoLabelAuditEnabled: () => true,
        isDrawingDocumentAuditEnabled: () => true,
        isDrawingPageAuditEnabled: () => true,
        transactTodoProject: (options) => transactTodoProject({ ...options, database }),
        transactTodoSection: (options) => transactTodoSection({ ...options, database }),
        transactTodoItem: (options) => transactTodoItem({ ...options, database }),
        transactTodoLabel: (options) => transactTodoLabel({ ...options, database }),
        transactDrawingDocument: (options) => transactDrawingDocument({ ...options, database }),
        transactDrawingPage: (options) => transactDrawingPage({ ...options, database })
    };
    const mocks = {
        "../config/firebaseAdmin": { getAdminDatabase: () => database, getAdminApp: () => ({}) },
        "../audit/businessOutbox": audit
    };
    const todo = loadModuleWithMocks("../../src/services/todoListService", mocks);
    const drawing = loadModuleWithMocks("../../src/services/drawingService", mocks);
    return {
        todo, drawing, database, get root() { return root; },
        retry(callback) { retry = callback; },
        fail() { fail = true; }
    };
}

test("section audit requires project audit and is disabled by default", () => {
    const section = process.env.AUDIT_TODO_SECTIONS_ENABLED;
    const project = process.env.AUDIT_TODO_PROJECTS_ENABLED;
    try {
        delete process.env.AUDIT_TODO_SECTIONS_ENABLED;
        delete process.env.AUDIT_TODO_PROJECTS_ENABLED;
        assert.equal(isTodoSectionAuditEnabled(), false);
        process.env.AUDIT_TODO_SECTIONS_ENABLED = "true";
        assert.throws(() => isTodoSectionAuditEnabled(), /requiere AUDIT_TODO_PROJECTS_ENABLED/);
        process.env.AUDIT_TODO_PROJECTS_ENABLED = "true";
        assert.equal(isTodoSectionAuditEnabled(), true);
    } finally {
        if (section === undefined) delete process.env.AUDIT_TODO_SECTIONS_ENABLED;
        else process.env.AUDIT_TODO_SECTIONS_ENABLED = section;
        if (project === undefined) delete process.env.AUDIT_TODO_PROJECTS_ENABLED;
        else process.env.AUDIT_TODO_PROJECTS_ENABLED = project;
    }
});

test("item audit requires section and project audit", () => {
    const keys = ["AUDIT_TODO_ITEMS_ENABLED", "AUDIT_TODO_SECTIONS_ENABLED", "AUDIT_TODO_PROJECTS_ENABLED"];
    const previous = keys.map((key) => process.env[key]);
    try {
        keys.forEach((key) => { delete process.env[key]; });
        assert.equal(isTodoItemAuditEnabled(), false);
        process.env.AUDIT_TODO_ITEMS_ENABLED = "true";
        assert.throws(() => isTodoItemAuditEnabled(), /requiere AUDIT_TODO_SECTIONS_ENABLED/);
        process.env.AUDIT_TODO_SECTIONS_ENABLED = "true";
        assert.throws(() => isTodoItemAuditEnabled(), /requiere AUDIT_TODO_PROJECTS_ENABLED/);
        process.env.AUDIT_TODO_PROJECTS_ENABLED = "true";
        assert.equal(isTodoItemAuditEnabled(), true);
    } finally {
        keys.forEach((key, index) => {
            if (previous[index] === undefined) delete process.env[key];
            else process.env[key] = previous[index];
        });
    }
});

test("label audit is disabled by default and enabled explicitly", () => {
    const previous = process.env.AUDIT_TODO_LABELS_ENABLED;
    try {
        delete process.env.AUDIT_TODO_LABELS_ENABLED;
        assert.equal(isTodoLabelAuditEnabled(), false);
        process.env.AUDIT_TODO_LABELS_ENABLED = "true";
        assert.equal(isTodoLabelAuditEnabled(), true);
    } finally {
        if (previous === undefined) delete process.env.AUDIT_TODO_LABELS_ENABLED;
        else process.env.AUDIT_TODO_LABELS_ENABLED = previous;
    }
});

test("item creation and moves atomically preserve relations, recurrence, activity and positions", async () => {
    const h = harness({
        authUsers: { owner: { firstName: "Ada" }, editor: { firstName: "Editor" } },
        todoList: {
            TodoLists: { project: { ownerUserId: "owner", isArchived: false } },
            TodoListMembers: { project: { editor: { role: "editor" } } },
            TodoListSections: { first: { todoListId: "project" }, second: { todoListId: "project" } },
            TodoListLabels: { label: { ownerUserId: "owner", name: "secret" } }
        }
    });
    const first = await h.todo.todoListCreateItem({
        title: "private task", todoListId: "project", sectionId: "first", labelIds: ["label"],
        assigneeUserIds: ["editor"], dueDate: "2026-09-01", recurrence: { frequency: "daily" }
    }, "editor");
    const second = await h.todo.todoListCreateItem({ title: "other", todoListId: "project", sectionId: "first" }, "owner");
    const target = await h.todo.todoListCreateItem({ title: "target", todoListId: "project", sectionId: "second" }, "owner");
    assert.deepEqual(first.labelIds, ["label"]);
    assert.deepEqual(first.assigneeUserIds, ["editor"]);
    assert.equal(first.recurrence.frequency, "daily");
    assert.equal(first.activities[0].action, "created");
    const moved = await h.todo.todoListMoveItem(first.id, "project", "second", "editor", 0);
    assert.equal(moved.position, 0);
    assert.equal(moved.sectionId, "second");
    assert.equal(h.root.todoList.TodoListItems[target.id].position, 1);
    assert.equal(h.root.todoList.TodoListItems[second.id].position, 0);
    assert.deepEqual(moved.activities.map((a) => a.action).sort(), ["created", "moved"]);
    const events = Object.values(h.root.auditOutbox);
    assert.deepEqual(events.map((e) => e.action), ["todo.item.created", "todo.item.created", "todo.item.created", "todo.item.moved"]);
    assert.equal(events.at(-1).targetId, first.id);
    assert.equal(events.at(-1).actorId, "editor");
    assert.doesNotMatch(JSON.stringify(events), /private|secret/);
    const published = [];
    const worker = new AuditOutboxWorker({ getRealtimeDatabase: () => h.database,
        getFirestoreDatabase: () => ({ collection: () => ({ doc: () => ({ create: async (e) => published.push(e) }) }) }) });
    await worker.flush();
    assert.equal(published.length, 4);
});

test("item edits atomically preserve relations, recurrence, activity and reminder rescheduling", async () => {
    const h = harness({
        authUsers: { owner: { firstName: "Ada" }, editor: { firstName: "Editor" } },
        todoList: {
            TodoLists: { project: { ownerUserId: "owner", isArchived: false } },
            TodoListMembers: { project: { editor: { role: "editor" } } },
            TodoListSections: { first: { todoListId: "project" }, second: { todoListId: "project" } },
            TodoListLabels: { label: { ownerUserId: "owner", name: "private label" } }
        }
    });
    const item = await h.todo.todoListCreateItem({
        title: "private title", todoListId: "project", sectionId: "first", dueDate: "2099-06-01",
        dueTime: "10:00", timeZone: "UTC"
    }, "owner");
    const other = await h.todo.todoListCreateItem({ title: "other", todoListId: "project", sectionId: "second" }, "owner");
    h.root.todoList.TodoListReminders = { [item.id]: {
        relative: { status: "processing", processingLeaseUntil: "2099-01-01", type: "before_1h",
            reminderDateTime: "2099-06-01T09:00:00.000Z" },
        custom: { status: "scheduled", type: "custom", reminderDateTime: "2099-06-01T10:00:00.000Z" }
    } };
    const updated = await h.todo.todoListUpdateItem(item.id, {
        title: "secret title", sectionId: "second", labelIds: ["label"], assigneeUserIds: ["editor"],
        dueDate: "2099-06-02", recurrence: { frequency: "daily" }
    }, "owner");
    assert.equal(updated.position, 1);
    assert.equal(h.root.todoList.TodoListItems[other.id].position, 0);
    assert.deepEqual(updated.labelIds, ["label"]);
    assert.deepEqual(updated.assigneeUserIds, ["editor"]);
    assert.equal(updated.recurrence.frequency, "daily");
    assert.equal(updated.recurrence.nextDueDate, "2099-06-02");
    assert.equal(updated.activities.find((entry) => entry.action === "updated").newValue.title, "secret title");
    const reminders = h.root.todoList.TodoListReminders[item.id];
    assert.equal(reminders.relative.reminderDateTime, "2099-06-02T09:00:00.000Z");
    assert.equal(reminders.relative.status, "scheduled");
    assert.equal(reminders.relative.processingLeaseUntil, undefined);
    assert.equal(reminders.custom.reminderDateTime, "2099-06-01T10:00:00.000Z");
    const recurrenceId = updated.recurrenceId;
    await h.todo.todoListUpdateItem(item.id, { dueDate: "", recurrence: null, labelIds: [], assigneeUserIds: [] }, "owner");
    assert.equal(h.root.todoList.TodoListRecurrences[recurrenceId].isActive, false);
    assert.equal(h.root.todoList.TodoListItems[item.id].recurrenceId, "");
    assert.deepEqual(h.root.todoList.TodoListItemLabels[item.id], {});
    assert.deepEqual(h.root.todoList.TodoListItemAssignees[item.id], {});
    assert.equal(h.root.todoList.TodoListReminders[item.id].relative.status, "cancelled");
    const events = Object.values(h.root.auditOutbox);
    assert.equal(events.filter((event) => event.action === "todo.item.updated").length, 2);
    assert.doesNotMatch(JSON.stringify(events), /private title|secret title|private label|2099/);
    const published = [];
    const worker = new AuditOutboxWorker({ getRealtimeDatabase: () => h.database,
        getFirestoreDatabase: () => ({ collection: () => ({ doc: () => ({ create: async (event) => published.push(event) }) }) }) });
    await worker.flush();
    assert.equal(published.length, 4);
});

test("item edits recheck permissions and references on retry without committing failures", async () => {
    const h = harness({
        authUsers: { owner: {}, editor: {} },
        todoList: {
            TodoLists: { project: { ownerUserId: "owner" } },
            TodoListMembers: { project: { editor: { role: "editor" } } },
            TodoListSections: { first: { todoListId: "project" } },
            TodoListLabels: { label: { ownerUserId: "owner" } },
            TodoListItems: { item: { title: "old", todoListId: "project", sectionId: "first", dueDate: "" } }
        }
    });
    h.retry((root) => { root.todoList.TodoListMembers.project.editor.role = "viewer"; });
    await assert.rejects(h.todo.todoListUpdateItem("item", { title: "new" }, "editor"), { statusCode: 403 });
    h.retry((root) => { delete root.todoList.TodoListLabels.label; });
    await assert.rejects(h.todo.todoListUpdateItem("item", { labelIds: ["label"] }, "owner"), { statusCode: 400 });
    h.retry((root) => { delete root.todoList.TodoListSections.first; });
    await assert.rejects(h.todo.todoListUpdateItem("item", { title: "new" }, "owner"), { statusCode: 404 });
    assert.equal(h.root.todoList.TodoListItems.item.title, "old");
    assert.equal(h.root.auditOutbox, undefined);
    h.fail();
    await assert.rejects(h.todo.todoListUpdateItem("item", { title: "new" }, "owner"), /database unavailable/);
    assert.equal(h.root.todoList.TodoListItems.item.title, "old");
});

test("item edits retain archived-project behavior and reject empty or invalid edits", async () => {
    const h = harness({
        authUsers: { owner: {} },
        todoList: {
            TodoLists: { project: { ownerUserId: "owner", isArchived: true } },
            TodoListItems: { item: { title: "old", todoListId: "project", sectionId: "", dueDate: "" } }
        }
    });
    await assert.rejects(h.todo.todoListUpdateItem("item", {}, "owner"), { statusCode: 400 });
    await assert.rejects(h.todo.todoListUpdateItem("item", { isImportant: "yes" }, "owner"), { statusCode: 400 });
    await assert.rejects(h.todo.todoListUpdateItem("item", { todoListId: "project" }, "owner"), { statusCode: 409 });
    assert.equal(h.root.auditOutbox, undefined);
    const updated = await h.todo.todoListUpdateItem("item", { title: "new" }, "owner");
    assert.equal(updated.title, "new");
    assert.equal(Object.keys(h.root.auditOutbox).length, 1);
});

test("item priority, importance, archive and ordering are audited with reminder cancellation", async () => {
    const h = harness({
        authUsers: { owner: { firstName: "Ada" } },
        todoList: {
            TodoListItems: {
                one: { title: "private title", createdByUserId: "owner", todoListId: "", sectionId: "",
                    priority: 4, isImportant: false, position: 0 },
                two: { title: "other", createdByUserId: "owner", todoListId: "", sectionId: "", position: 1 }
            },
            TodoListReminders: { one: {
                scheduled: { status: "scheduled" },
                processing: { status: "processing", processingLeaseUntil: "2099" },
                delivered: { status: "triggered" }
            } }
        }
    });
    assert.equal((await h.todo.todoListSetItemImportant("one", true, "owner")).isImportant, true);
    assert.equal((await h.todo.todoListSetItemPriority("one", 1, "owner")).priority, 1);
    assert.equal((await h.todo.todoListSetItemPosition("one", 1, "owner")).position, 1);
    assert.equal(h.root.todoList.TodoListItems.two.position, 0);
    assert.equal((await h.todo.todoListSetItemArchive("one", true, "owner")).isArchived, true);
    const reminders = h.root.todoList.TodoListReminders.one;
    assert.equal(reminders.scheduled.status, "cancelled");
    assert.equal(reminders.processing.status, "cancelled");
    assert.equal(reminders.processing.processingLeaseUntil, undefined);
    assert.equal(reminders.delivered.status, "triggered");
    assert.equal((await h.todo.todoListSetItemArchive("one", false, "owner")).isArchived, false);
    const events = Object.values(h.root.auditOutbox);
    assert.deepEqual(events.map((event) => event.action), [
        "todo.item.importance.updated", "todo.item.priority.updated", "todo.item.reordered",
        "todo.item.archived", "todo.item.unarchived"
    ]);
    assert.doesNotMatch(JSON.stringify(events), /private title/);
    assert.equal(Object.keys(h.root.todoList.TodoListActivities.one).length, 4);
    const published = [];
    const worker = new AuditOutboxWorker({ getRealtimeDatabase: () => h.database,
        getFirestoreDatabase: () => ({ collection: () => ({ doc: () => ({ create: async (event) => published.push(event) }) }) }) });
    await worker.flush();
    assert.equal(published.length, 5);
});

test("item property updates recheck permissions and fail closed on database failure", async () => {
    const h = harness({
        authUsers: { owner: {}, editor: {} },
        todoList: {
            TodoLists: { project: { ownerUserId: "owner" } },
            TodoListMembers: { project: { editor: { role: "editor" } } },
            TodoListItems: { item: { title: "task", todoListId: "project", priority: 4 } }
        }
    });
    h.retry((root) => { root.todoList.TodoListMembers.project.editor.role = "viewer"; });
    await assert.rejects(h.todo.todoListSetItemPriority("item", 1, "editor"), { statusCode: 403 });
    assert.equal(h.root.todoList.TodoListItems.item.priority, 4);
    assert.equal(h.root.auditOutbox, undefined);
    h.fail();
    await assert.rejects(h.todo.todoListSetItemArchive("item", true, "owner"), /database unavailable/);
    assert.equal(h.root.todoList.TodoListItems.item.isArchived, undefined);
    assert.equal(h.root.auditOutbox, undefined);
});

test("labels are audited atomically with relation cleanup and sanitized events", async () => {
    const h = harness({ todoList: { TodoListLabels: { other: { name: "same", ownerUserId: "other" } } } });
    const label = await h.todo.todoListCreateLabel({ name: "private", color: "#123456" }, "owner");
    const updated = await h.todo.todoListUpdateLabel(label.id, { name: "secret" }, "owner");
    assert.equal(updated.name, "secret");
    h.root.todoList.TodoListItemLabels = { first: { [label.id]: true, other: true }, second: { [label.id]: true } };
    await h.todo.todoListDeleteLabel(label.id, "owner");
    assert.equal(h.root.todoList.TodoListLabels[label.id], undefined);
    assert.deepEqual(h.root.todoList.TodoListItemLabels.first, { other: true });
    assert.deepEqual(h.root.todoList.TodoListItemLabels.second, {});
    assert.equal(h.root.todoList.TodoListLabels.other.name, "same");
    const events = Object.values(h.root.auditOutbox);
    assert.deepEqual(events.map((event) => event.action), ["todo.label.created", "todo.label.updated", "todo.label.deleted"]);
    assert.doesNotMatch(JSON.stringify(events), /private|secret|123456/);
    const published = [];
    const worker = new AuditOutboxWorker({ getRealtimeDatabase: () => h.database,
        getFirestoreDatabase: () => ({ collection: () => ({ doc: () => ({ create: async (event) => published.push(event) }) }) }) });
    await worker.flush();
    assert.equal(published.length, 3);
});

test("label uniqueness and ownership are rechecked on transaction retry", async () => {
    const h = harness({ todoList: { TodoListLabels: { original: { name: "original", ownerUserId: "owner" } } } });
    h.retry((root) => { root.todoList.TodoListLabels.concurrent = { name: "Private", ownerUserId: "owner" }; });
    await assert.rejects(h.todo.todoListCreateLabel({ name: "private" }, "owner"), { statusCode: 409 });
    h.retry((root) => { root.todoList.TodoListLabels.original.ownerUserId = "other"; });
    await assert.rejects(h.todo.todoListDeleteLabel("original", "owner"), { statusCode: 404 });
    assert.equal(h.root.todoList.TodoListLabels.original.name, "original");
    assert.equal(h.root.auditOutbox, undefined);
    h.fail();
    await assert.rejects(h.todo.todoListCreateLabel({ name: "new" }, "owner"), /database unavailable/);
    assert.equal(h.root.auditOutbox, undefined);
});

test("label audit rejects invalid updates and oversized databases without changes", async () => {
    const h = harness({ todoList: { TodoListLabels: { label: { name: "original", ownerUserId: "owner" } } } });
    await assert.rejects(h.todo.todoListUpdateLabel("label", {}, "owner"), { statusCode: 400 });
    await assert.rejects(h.todo.todoListUpdateLabel("label", { color: "invalid" }, "owner"), { statusCode: 400 });
    await assert.rejects(h.todo.todoListDeleteLabel("label", "other"), { statusCode: 404 });
    h.root.large = "x".repeat(8 * 1024 * 1024);
    await assert.rejects(h.todo.todoListDeleteLabel("label", "owner"), { statusCode: 503 });
    assert.equal(h.root.todoList.TodoListLabels.label.name, "original");
    assert.equal(h.root.auditOutbox, undefined);
});

test("child mutations atomically preserve activity and publish sanitized audit events", async () => {
    const h = harness({ todoList: {
        TodoLists: { project: { ownerUserId: "owner" } },
        TodoListMembers: { project: { editor: { role: "editor" }, viewer: { role: "viewer" } } },
        TodoListItems: { item: { todoListId: "project" } },
        TodoListChildItems: { existing: { todoListItemId: "item", position: 0 } }
    } });
    const child = await h.todo.todoListCreateChild("item", { title: "private child" }, "editor");
    assert.equal(child.position, 1);
    const updated = await h.todo.todoListUpdateChild(child.id, { title: "secret", status: "completed", position: 3 }, "editor");
    assert.equal(updated.status, "completed");
    assert.ok(updated.completedAt);
    await assert.rejects(h.todo.todoListDeleteChild(child.id, "viewer"), { statusCode: 403 });
    await h.todo.todoListDeleteChild(child.id, "owner");
    assert.equal(h.root.todoList.TodoListChildItems[child.id], undefined);
    assert.deepEqual(Object.values(h.root.todoList.TodoListActivities.item).map((activity) => activity.action),
        ["child-created", "child-updated", "child-deleted"]);
    const events = Object.values(h.root.auditOutbox);
    assert.deepEqual(events.map((event) => event.action), ["todo.child.created", "todo.child.updated", "todo.child.deleted"]);
    assert.ok(events.every((event) => event.targetId === child.id));
    assert.doesNotMatch(JSON.stringify(events), /private|secret/);
    const published = [];
    const worker = new AuditOutboxWorker({ getRealtimeDatabase: () => h.database,
        getFirestoreDatabase: () => ({ collection: () => ({ doc: () => ({ create: async (event) => published.push(event) }) }) }) });
    await worker.flush();
    assert.equal(published.length, 3);
});

test("child mutations recheck access and current data on retries and database failure", async () => {
    const h = harness({ todoList: {
        TodoLists: { project: { ownerUserId: "owner" } },
        TodoListMembers: { project: { editor: { role: "editor" } } },
        TodoListItems: { item: { todoListId: "project" } },
        TodoListChildItems: { child: { todoListItemId: "item", title: "old", position: 0 } }
    } });
    h.retry((root) => { root.todoList.TodoListMembers.project.editor.role = "viewer"; });
    await assert.rejects(h.todo.todoListUpdateChild("child", { title: "new" }, "editor"), { statusCode: 403 });
    assert.equal(h.root.todoList.TodoListChildItems.child.title, "old");
    assert.equal(h.root.auditOutbox, undefined);
    h.retry((root) => { delete root.todoList.TodoListChildItems.child; });
    await assert.rejects(h.todo.todoListDeleteChild("child", "owner"), { statusCode: 404 });
    assert.equal(h.root.auditOutbox, undefined);
    h.fail();
    await assert.rejects(h.todo.todoListCreateChild("item", { title: "new" }, "owner"), /database unavailable/);
    assert.equal(h.root.auditOutbox, undefined);
});

test("comment changes enforce author and owner permissions and publish sanitized audit events", async () => {
    const h = harness({
        authUsers: { editor: { firstName: "Ada", lastName: "Lovelace" } },
        todoList: {
            TodoLists: { project: { ownerUserId: "owner" } },
            TodoListMembers: { project: { editor: { role: "editor" }, other: { role: "editor" } } },
            TodoListItems: { item: { todoListId: "project" } }
        }
    });
    const comment = await h.todo.todoListAddComment("item", { content: "private text" }, "editor");
    assert.equal(comment.authorName, "Ada Lovelace");
    await assert.rejects(h.todo.todoListUpdateComment(comment.id, { content: "other" }, "owner"), { statusCode: 403 });
    await assert.rejects(h.todo.todoListDeleteComment(comment.id, "other"), { statusCode: 403 });
    const updated = await h.todo.todoListUpdateComment(comment.id, { content: "secret" }, "editor");
    assert.equal(updated.content, "secret");
    await h.todo.todoListDeleteComment(comment.id, "owner");
    assert.equal(h.root.todoList.TodoListItemComments.item[comment.id], undefined);
    assert.deepEqual(Object.values(h.root.todoList.TodoListActivities.item).map((activity) => activity.action),
        ["comment-added", "comment-updated", "comment-deleted"]);
    const events = Object.values(h.root.auditOutbox);
    assert.deepEqual(events.map((event) => event.action), ["todo.comment.created", "todo.comment.updated", "todo.comment.deleted"]);
    assert.ok(events.every((event) => event.targetId === comment.id));
    assert.doesNotMatch(JSON.stringify(events), /private|secret|Ada|Lovelace/);
    const published = [];
    const worker = new AuditOutboxWorker({ getRealtimeDatabase: () => h.database,
        getFirestoreDatabase: () => ({ collection: () => ({ doc: () => ({ create: async (event) => published.push(event) }) }) }) });
    await worker.flush();
    assert.equal(published.length, 3);
});

test("comment changes recheck author, access and user status on transaction retry", async () => {
    const h = harness({
        authUsers: { editor: { firstName: "Ada" } },
        todoList: {
            TodoLists: { project: { ownerUserId: "owner" } },
            TodoListMembers: { project: { editor: { role: "editor" } } },
            TodoListItems: { item: { todoListId: "project" } },
            TodoListItemComments: { item: { comment: { todoListItemId: "item", userId: "editor", content: "old" } } }
        }
    });
    h.retry((root) => { root.todoList.TodoListItemComments.item.comment.userId = "owner"; });
    await assert.rejects(h.todo.todoListUpdateComment("comment", { content: "new" }, "editor"), { statusCode: 403 });
    h.retry((root) => { root.todoList.TodoListMembers.project.editor.role = "viewer"; });
    await assert.rejects(h.todo.todoListDeleteComment("comment", "editor"), { statusCode: 403 });
    h.root.todoList.TodoListMembers.project.editor.role = "editor";
    h.retry((root) => { root.authUsers.editor.isActive = false; });
    await assert.rejects(h.todo.todoListAddComment("item", { content: "new" }, "editor"), { statusCode: 404 });
    assert.equal(h.root.auditOutbox, undefined);
    h.fail();
    await assert.rejects(h.todo.todoListDeleteComment("comment", "owner"), /database unavailable/);
    assert.equal(h.root.todoList.TodoListItemComments.item.comment.content, "old");
});

test("reminder changes are atomic, enforce ownership and publish sanitized audit events", async () => {
    const h = harness({ todoList: {
        TodoLists: { project: { ownerUserId: "owner" } },
        TodoListMembers: { project: { editor: { role: "editor" }, viewer: { role: "viewer" } } },
        TodoListItems: { item: {
            todoListId: "project", title: "private title", status: "pending",
            dueDate: "2099-06-01", dueTime: "10:00", timeZone: "UTC"
        } }
    } });
    const reminder = await h.todo.todoListCreateReminder("item", { type: "before_1h" }, "editor");
    assert.equal(reminder.reminderDateTime, "2099-06-01T09:00:00.000Z");
    await assert.rejects(h.todo.todoListUpdateReminder(reminder.id, { status: "cancelled" }, "owner"), { statusCode: 403 });
    await assert.rejects(h.todo.todoListDeleteReminder(reminder.id, "viewer"), { statusCode: 403 });
    const updated = await h.todo.todoListUpdateReminder(reminder.id,
        { reminderDateTime: "2099-05-01T10:00:00Z" }, "editor");
    assert.equal(updated.type, "custom");
    assert.equal(updated.reminderDateTime, "2099-05-01T10:00:00.000Z");
    assert.equal(updated.status, "scheduled");
    assert.equal(updated.processingLeaseUntil, null);
    await h.todo.todoListDeleteReminder(reminder.id, "editor");
    assert.equal(h.root.todoList.TodoListReminders.item[reminder.id], undefined);
    const events = Object.values(h.root.auditOutbox);
    assert.deepEqual(events.map((event) => event.action), [
        "todo.reminder.created", "todo.reminder.updated", "todo.reminder.deleted"
    ]);
    assert.ok(events.every((event) => event.targetId === reminder.id));
    assert.doesNotMatch(JSON.stringify(events), /private title|2099|before_1h/);
    const published = [];
    const worker = new AuditOutboxWorker({ getRealtimeDatabase: () => h.database,
        getFirestoreDatabase: () => ({ collection: () => ({ doc: () => ({ create: async (event) => published.push(event) }) }) }) });
    await worker.flush();
    assert.equal(published.length, 3);
});

test("reminder changes recheck task, access and delivery status on retries and failure", async () => {
    const h = harness({ todoList: {
        TodoLists: { project: { ownerUserId: "owner" } },
        TodoListMembers: { project: { editor: { role: "editor" } } },
        TodoListItems: { item: {
            todoListId: "project", status: "pending", dueDate: "2099-06-01", dueTime: "10:00", timeZone: "UTC"
        } },
        TodoListReminders: { item: { reminder: {
            todoListItemId: "item", userId: "editor", status: "scheduled", type: "at_due",
            reminderDateTime: "2099-06-01T10:00:00.000Z"
        } } }
    } });
    h.retry((root) => { root.todoList.TodoListItems.item.status = "completed"; });
    await assert.rejects(h.todo.todoListCreateReminder("item", {}, "editor"), { statusCode: 409 });
    assert.equal(h.root.auditOutbox, undefined);
    h.root.todoList.TodoListItems.item.status = "pending";
    h.retry((root) => { root.todoList.TodoListReminders.item.reminder.status = "triggered"; });
    await assert.rejects(h.todo.todoListUpdateReminder("reminder", { status: "cancelled" }, "editor"), { statusCode: 409 });
    h.retry((root) => { root.todoList.TodoListMembers.project.editor.role = "viewer"; });
    await assert.rejects(h.todo.todoListDeleteReminder("reminder", "editor"), { statusCode: 403 });
    h.root.todoList.TodoListMembers.project.editor.role = "editor";
    h.root.todoList.TodoListReminders.item.reminder.userId = "owner";
    await assert.rejects(h.todo.todoListDeleteReminder("reminder", "editor"), { statusCode: 403 });
    await assert.rejects(h.todo.todoListDeleteReminder("missing", "editor"), { statusCode: 404 });
    h.fail();
    await assert.rejects(h.todo.todoListDeleteReminder("reminder", "owner"), /database unavailable/);
    assert.ok(h.root.todoList.TodoListReminders.item.reminder);
    assert.equal(h.root.auditOutbox, undefined);
});

test("reminder creation rechecks due date and rejects invalid or terminal changes", async () => {
    const h = harness({ todoList: {
        TodoListItems: { item: { createdByUserId: "owner", status: "pending", dueDate: "2099-06-01", timeZone: "UTC" } }
    } });
    h.retry((root) => { root.todoList.TodoListItems.item.dueDate = "2099-06-02"; });
    const reminder = await h.todo.todoListCreateReminder("item", { type: "at_due" }, "owner");
    assert.equal(reminder.reminderDateTime, "2099-06-02T09:00:00.000Z");
    await assert.rejects(h.todo.todoListUpdateReminder(reminder.id, {}, "owner"), { statusCode: 400 });
    await assert.rejects(h.todo.todoListUpdateReminder(reminder.id, { status: "invalid" }, "owner"), { statusCode: 400 });
    await h.todo.todoListUpdateReminder(reminder.id, { status: "cancelled" }, "owner");
    await assert.rejects(h.todo.todoListUpdateReminder(reminder.id, { status: "scheduled" }, "owner"), { statusCode: 409 });
    assert.equal(Object.keys(h.root.auditOutbox).length, 2);
});

test("item transactions revalidate sections, permissions and assignees on retry", async () => {
    const h = harness({
        authUsers: { owner: {}, editor: {} },
        todoList: { TodoLists: { project: { ownerUserId: "owner" } },
            TodoListMembers: { project: { editor: { role: "editor" } } },
            TodoListSections: { section: { todoListId: "project" } } }
    });
    h.retry((root) => { delete root.todoList.TodoListSections.section; });
    await assert.rejects(h.todo.todoListCreateItem({ title: "new", todoListId: "project", sectionId: "section" }, "editor"),
        { statusCode: 404 });
    assert.equal(h.root.auditOutbox, undefined);
    h.root.todoList.TodoListSections.section = { todoListId: "project" };
    const item = await h.todo.todoListCreateItem({ title: "new", todoListId: "project", sectionId: "section",
        assigneeUserIds: ["editor"] }, "editor");
    const count = Object.keys(h.root.auditOutbox).length;
    h.retry((root) => { delete root.todoList.TodoListMembers.project.editor; });
    await assert.rejects(h.todo.todoListMoveItem(item.id, "project", "section", "editor", 0), { statusCode: 404 });
    assert.equal(Object.keys(h.root.auditOutbox).length, count);
    h.fail();
    await assert.rejects(h.todo.todoListMoveItem(item.id, "project", "section", "owner", 0), /database unavailable/);
    assert.equal(Object.keys(h.root.auditOutbox).length, count);
});

test("item creation rechecks project, label and assignee references", async () => {
    const make = () => harness({
        authUsers: { owner: {}, editor: {} },
        todoList: {
            TodoLists: { project: { ownerUserId: "owner" } },
            TodoListMembers: { project: { editor: { role: "editor" } } },
            TodoListSections: { section: { todoListId: "project" } },
            TodoListLabels: { label: { ownerUserId: "owner" } }
        }
    });
    const payload = { title: "title", todoListId: "project", sectionId: "section",
        labelIds: ["label"], assigneeUserIds: ["editor"] };
    const cases = [
        [(root) => { root.todoList.TodoLists.project.isArchived = true; }, 409],
        [(root) => { delete root.todoList.TodoListLabels.label; }, 400],
        [(root) => { root.authUsers.editor.isActive = false; }, 404],
        [(root) => { delete root.todoList.TodoListMembers.project.editor; }, 400]
    ];
    for (const [change, statusCode] of cases) {
        const h = make();
        h.retry(change);
        await assert.rejects(h.todo.todoListCreateItem(payload, "owner"), { statusCode });
        assert.equal(h.root.todoList.TodoListItems, undefined);
        assert.equal(h.root.todoList.TodoListActivities, undefined);
        assert.equal(h.root.auditOutbox, undefined);
    }
});

test("personal task creation preserves existing response shape", async () => {
    const h = harness({ authUsers: { owner: { firstName: "Ada" } } });
    const item = await h.todo.todoListCreateItem({ title: "private task" }, "owner");
    assert.equal(item.todoListId, "");
    assert.deepEqual(item.assigneeUserIds, []);
    assert.deepEqual(item.labelIds, []);
    assert.deepEqual(item.children, []);
    assert.equal(item.recurrence, null);
    assert.equal(item.activities[0].userName, "Ada");
});

test("section changes and reorder are atomic, sanitized and publishable", async () => {
    const h = harness({ todoList: {
        TodoLists: { project: { ownerUserId: "owner" } },
        TodoListMembers: { project: { editor: { role: "editor" }, viewer: { role: "viewer" } } }
    } });
    const first = await h.todo.todoListCreateSection("project", { name: "private section" }, "editor");
    const second = await h.todo.todoListCreateSection("project", { name: "secret section" }, "owner");
    assert.equal(first.position, 0);
    assert.equal(second.position, 1);
    assert.equal((await h.todo.todoListUpdateSection(first.id, { name: "changed private" }, "editor")).name, "changed private");
    const ordered = await h.todo.todoListSetSectionPosition(second.id, 0, "editor");
    assert.deepEqual(ordered.map((entry) => [entry.id, entry.position]), [[second.id, 0], [first.id, 1]]);
    await assert.rejects(h.todo.todoListUpdateSection(first.id, { name: "no" }, "viewer"), { statusCode: 403 });
    assert.equal((await h.todo.todoListDeleteSection(first.id, "owner")).id, first.id);
    const events = Object.values(h.root.auditOutbox);
    assert.deepEqual(events.map((event) => event.action), [
        "todo.section.created", "todo.section.created", "todo.section.updated",
        "todo.section.reordered", "todo.section.deleted"
    ]);
    assert.equal(events[2].actorId, "editor");
    assert.equal(events[2].targetId, first.id);
    assert.doesNotMatch(JSON.stringify(events), /private|secret/);
    const published = [];
    const worker = new AuditOutboxWorker({
        getRealtimeDatabase: () => h.database,
        getFirestoreDatabase: () => ({ collection: () => ({ doc: () => ({ create: async (event) => published.push(event) }) }) })
    });
    await worker.flush();
    assert.equal(published.length, 5);
    assert.equal(Object.keys(h.root.auditOutbox).length, 0);
});

test("section retries recheck permission, task references and ordering", async () => {
    const h = harness({ todoList: {
        TodoLists: { project: { ownerUserId: "owner" } },
        TodoListMembers: { project: { editor: { role: "editor" } } },
        TodoListSections: {
            first: { todoListId: "project", name: "first", position: 0 },
            second: { todoListId: "project", name: "second", position: 1 }
        }
    } });
    h.retry((root) => { root.todoList.TodoListMembers.project.editor.role = "viewer"; });
    await assert.rejects(h.todo.todoListUpdateSection("first", { name: "new" }, "editor"), { statusCode: 403 });
    h.retry((root) => { root.todoList.TodoListItems = { item: { sectionId: "first" } }; });
    await assert.rejects(h.todo.todoListDeleteSection("first", "owner"), { statusCode: 409 });
    h.retry((root) => { delete root.todoList.TodoListSections.second; });
    await assert.rejects(h.todo.todoListSetSectionPosition("first", 1, "owner"), { statusCode: 400 });
    assert.equal(h.root.todoList.TodoListSections.first.name, "first");
    assert.equal(h.root.auditOutbox, undefined);
    h.fail();
    await assert.rejects(h.todo.todoListDeleteSection("first", "owner"), /database unavailable/);
    assert.ok(h.root.todoList.TodoListSections.first);
});

test("section creation uses current project sections after retry and preserves other projects", async () => {
    const h = harness({ todoList: {
        TodoLists: { project: { ownerUserId: "owner" }, other: { ownerUserId: "owner" } },
        TodoListSections: { unrelated: { todoListId: "other", name: "unrelated", position: 0 } }
    } });
    h.retry((root) => {
        root.todoList.TodoListSections.concurrent = { todoListId: "project", name: "existing", position: 0 };
    });
    const section = await h.todo.todoListCreateSection("project", { name: "new" }, "owner");
    assert.equal(section.position, 1);
    assert.equal(h.root.todoList.TodoListSections.unrelated.name, "unrelated");
    assert.equal(Object.keys(h.root.auditOutbox).length, 1);
    await assert.rejects(h.todo.todoListCreateSection("constructor", { name: "new" }, "owner"), { statusCode: 404 });
    await assert.rejects(h.todo.todoListDeleteSection("../invalid", "owner"), { statusCode: 400 });
    assert.equal(Object.keys(h.root.auditOutbox).length, 1);
});

test("project and drawing document changes emit only identifiers and can be published", async () => {
    const h = harness({ authUsers: { owner: { isActive: true } }, unrelated: { kept: true } });
    const project = await h.todo.todoListCreateProject({ name: "secret project" }, "owner");
    const updated = await h.todo.todoListUpdateProject(project.id, { description: "private description" }, "owner");
    assert.deepEqual(updated.sections, []);
    assert.equal(updated.description, "private description");
    assert.equal((await h.todo.todoListArchiveProject(project.id, true, "owner")).isArchived, true);
    assert.equal((await h.todo.todoListArchiveProject(project.id, false, "owner")).isArchived, false);
    await h.todo.todoListDeleteProject(project.id, "owner");
    assert.equal(h.root.todoList.TodoLists[project.id], undefined);

    const document = await h.drawing.createDocument({ name: "secret drawing" }, "owner");
    assert.equal(document.pages.length, 1);
    assert.ok(h.root.drawing.snapshots[document.pages[0].snapshotId]);
    assert.ok(h.root.drawing.documentsByOwner.owner[document.id]);
    assert.equal((await h.drawing.updateDocument(document.id, { name: "private drawing" }, "owner")).version, 2);
    assert.equal((await h.drawing.setDocumentArchived(document.id, true, "owner")).isArchived, true);
    assert.equal((await h.drawing.setDocumentArchived(document.id, false, "owner")).isArchived, false);
    assert.equal(await h.drawing.deleteDocument(document.id, "owner"), true);
    assert.equal(h.root.drawing.documentsByOwner.owner[document.id], undefined);
    assert.ok(h.root.drawing.documents[document.id].deletedAt);
    assert.deepEqual(h.root.unrelated, { kept: true });

    const events = Object.values(h.root.auditOutbox);
    assert.deepEqual(events.map((event) => event.action), [
        "todo.project.created", "todo.project.updated", "todo.project.archived", "todo.project.restored",
        "todo.project.deleted", "drawing.document.created", "drawing.document.updated",
        "drawing.document.archived", "drawing.document.restored", "drawing.document.deleted"
    ]);
    assert.ok(events.every((event) => event.actorId === "owner" && event.targetId));
    assert.doesNotMatch(JSON.stringify(events), /secret|private|description/i);
    const published = [];
    const worker = new AuditOutboxWorker({
        getRealtimeDatabase: () => h.database,
        getFirestoreDatabase: () => ({ collection: () => ({ doc: () => ({ create: async (event) => published.push(event) }) }) })
    });
    await worker.flush();
    assert.equal(published.length, 10);
    assert.equal(Object.keys(h.root.auditOutbox).length, 0);
});

test("page mutations are atomic and publish sanitized audit events", async () => {
    const h = harness({ authUsers: { owner: {} } });
    const document = await h.drawing.createDocument({ name: "private document" }, "owner");
    const first = document.pages[0];
    const page = await h.drawing.createPage(document.id, { name: "secret page" }, "owner");
    assert.equal(page.position, 1);
    assert.equal(h.root.drawing.documents[document.id].pageCount, 2);
    assert.equal((await h.drawing.updatePage(page.id, { name: "private update" }, "owner")).name, "private update");
    assert.deepEqual((await h.drawing.reorderPages(document.id, [page.id, first.id], "owner")).map((item) => item.id),
        [page.id, first.id]);
    assert.equal(await h.drawing.deletePage(page.id, "owner"), true);
    assert.equal(h.root.drawing.documents[document.id].pageCount, 1);
    assert.equal(h.root.drawing.pagesByDocument[document.id][page.id], undefined);
    assert.ok(h.root.drawing.pages[page.id].deletedAt);
    await assert.rejects(h.drawing.deletePage(first.id, "owner"), { statusCode: 409 });
    const events = Object.values(h.root.auditOutbox);
    assert.deepEqual(events.map((event) => event.action), [
        "drawing.document.created", "drawing.page.created", "drawing.page.updated",
        "drawing.page.reordered", "drawing.page.deleted"
    ]);
    assert.doesNotMatch(JSON.stringify(events), /secret|private/);
    const published = [];
    const worker = new AuditOutboxWorker({
        getRealtimeDatabase: () => h.database,
        getFirestoreDatabase: () => ({ collection: () => ({ doc: () => ({ create: async (event) => published.push(event) }) }) })
    });
    await worker.flush();
    assert.equal(published.length, 5);
});

test("page transactions recheck editor permission, page count, and order after retry", async () => {
    const h = harness({ drawing: {
        documents: { doc: { ownerUserId: "owner", version: 1, pageCount: 2, nextPagePosition: 2 } },
        pages: { one: { documentId: "doc", position: 0 }, two: { documentId: "doc", position: 1 } },
        pagesByDocument: { doc: { one: true, two: true } },
        access: { doc: { permissions: { editor: { status: "Active", role: "Editor" } } } }
    } });
    h.retry((root) => { root.drawing.access.doc.permissions.editor.role = "Viewer"; });
    await assert.rejects(h.drawing.updatePage("one", { name: "new" }, "editor"), { statusCode: 403 });
    h.retry((root) => { root.drawing.documents.doc.pageCount = 1; });
    await assert.rejects(h.drawing.deletePage("two", "owner"), { statusCode: 409 });
    h.retry((root) => { delete root.drawing.pagesByDocument.doc.two; });
    await assert.rejects(h.drawing.reorderPages("doc", ["one", "two"], "owner"), { statusCode: 400 });
    assert.equal(h.root.auditOutbox, undefined);
});

test("active editors can create and edit pages while viewers are rejected", async () => {
    const h = harness({ drawing: {
        documents: { doc: { ownerUserId: "owner", version: 1, pageCount: 1, nextPagePosition: 1 } },
        access: { doc: { permissions: {
            editor: { status: "Active", role: "Editor" },
            viewer: { status: "Active", role: "Viewer" }
        } } }
    } });
    const page = await h.drawing.createPage("doc", { name: "page" }, "editor");
    const changed = await h.drawing.updatePage(page.id, { name: "edited" }, "editor");
    assert.equal(changed.document.accessRole, "Editor");
    assert.equal(changed.name, "edited");
    await assert.rejects(h.drawing.updatePage(page.id, { name: "not allowed" }, "viewer"), { statusCode: 403 });
    assert.equal(Object.keys(h.root.auditOutbox).length, 2);
});

test("page mutations reject storage failure and over-limit documents", async () => {
    const h = harness({ drawing: { documents: {
        doc: { ownerUserId: "owner", pageCount: 100 }
    } } });
    await assert.rejects(h.drawing.createPage("doc", { name: "page" }, "owner"), { statusCode: 409 });
    h.fail();
    await assert.rejects(h.drawing.createPage("doc", { name: "page" }, "owner"), /database unavailable/);
    assert.equal(h.root.auditOutbox, undefined);
    assert.equal(h.root.drawing.documents.doc.pageCount, 100);
});

test("project deletion rechecks tasks and permissions on transaction retry", async () => {
    const h = harness({ todoList: { TodoLists: { project: { ownerUserId: "owner", name: "p" } } } });
    h.retry((root) => { root.todoList.TodoListItems = { item: { todoListId: "project" } }; });
    await assert.rejects(h.todo.todoListDeleteProject("project", "owner"), { statusCode: 409 });
    assert.ok(h.root.todoList.TodoLists.project);
    delete h.root.todoList.TodoListItems;
    h.retry((root) => { root.todoList.TodoLists.project.ownerUserId = "other"; });
    await assert.rejects(h.todo.todoListUpdateProject("project", { name: "new" }, "owner"), { statusCode: 404 });
    assert.equal(h.root.auditOutbox, undefined);
});

test("project reorder and member changes are atomic, publishable and identify project and member", async () => {
    const h = harness({
        authUsers: { owner: {}, member: { firstName: "secret", isActive: true } },
        todoList: {
            TodoLists: { first: { ownerUserId: "owner", position: 0 }, second: { ownerUserId: "owner", position: 1 } },
            TodoListItems: { item: { todoListId: "first" } },
            TodoListItemAssignees: { item: { member: true } }
        }
    });
    const reordered = await h.todo.todoListReorderProjects(["second", "first"], "owner");
    assert.deepEqual(reordered.map((project) => project.id), ["second", "first"]);
    assert.equal((await h.todo.todoListAddMember("first", "member", "editor", "owner")).role, "editor");
    await h.todo.todoListRemoveMember("first", "member", "owner");
    assert.equal(h.root.todoList.TodoListMembers.first.member, undefined);
    assert.equal(h.root.todoList.TodoListItemAssignees.item.member, undefined);
    await h.todo.todoListRemoveMember("first", "member", "owner");
    const events = Object.values(h.root.auditOutbox);
    assert.equal(events.length, 3);
    assert.deepEqual(events.slice(1).map((event) => [event.action, event.targetId, event.projectId]), [
        ["todo.member.added", "member", "first"], ["todo.member.removed", "member", "first"]
    ]);
    assert.doesNotMatch(JSON.stringify(events), /secret/);
    const published = [];
    const worker = new AuditOutboxWorker({
        getRealtimeDatabase: () => h.database,
        getFirestoreDatabase: () => ({ collection: () => ({ doc: () => ({ create: async (event) => published.push(event) }) }) })
    });
    await worker.flush();
    assert.equal(published.length, 3);
});

test("drawing changes recheck ownership and deletion on transaction retry", async () => {
    const h = harness({ drawing: { documents: { doc: { ownerUserId: "owner", name: "original", version: 1 } } } });
    h.retry((root) => { root.drawing.documents.doc.ownerUserId = "other"; });
    await assert.rejects(h.drawing.updateDocument("doc", { name: "new" }, "owner"), { statusCode: 403 });
    assert.equal(h.root.drawing.documents.doc.name, "original");
    h.retry((root) => { root.drawing.documents.doc.deletedAt = "deleted"; });
    assert.equal(await h.drawing.deleteDocument("doc", "other"), false);
    assert.equal(h.root.auditOutbox, undefined);
});

test("membership changes reject revoked ownership and preserve member data", async () => {
    const h = harness({
        authUsers: { member: {} },
        todoList: {
            TodoLists: { project: { ownerUserId: "owner" } },
            TodoListMembers: { project: { member: { role: "editor" } } }
        }
    });
    h.retry((root) => { root.todoList.TodoLists.project.ownerUserId = "other"; });
    await assert.rejects(h.todo.todoListRemoveMember("project", "member", "owner"), { statusCode: 404 });
    assert.equal(h.root.todoList.TodoListMembers.project.member.role, "editor");
    assert.equal(h.root.auditOutbox, undefined);
});

test("failed validation and missing documents do not create audit records", async () => {
    const h = harness({
        authUsers: { owner: {} },
        todoList: { TodoLists: { project: { ownerUserId: "owner" } } },
        drawing: { documents: { doc: { ownerUserId: "owner", version: 1 } } }
    });
    await assert.rejects(h.todo.todoListArchiveProject("project", "yes", "owner"), { statusCode: 400 });
    await assert.rejects(h.todo.todoListUpdateProject("bad/id", {}, "owner"), { statusCode: 400 });
    await assert.rejects(h.drawing.setDocumentArchived("doc", "yes", "owner"), { statusCode: 400 });
    assert.equal(await h.drawing.updateDocument("missing", { name: "test" }, "owner"), null);
    assert.equal(h.root.auditOutbox, undefined);
});

test("failed transactions and invalid actors never commit changes or events", async () => {
    const h = harness({ authUsers: { owner: { isActive: false } }, drawing: { documents: {
        doc: { ownerUserId: "owner", version: 1, name: "old" }
    } } });
    await assert.rejects(h.todo.todoListCreateProject({ name: "project" }, "owner"), { statusCode: 404 });
    await assert.rejects(h.drawing.createDocument({ name: "doc" }, "../bad"), { statusCode: 400 });
    h.fail();
    await assert.rejects(h.drawing.updateDocument("doc", { name: "new" }, "owner"), /database unavailable/);
    assert.equal(h.root.drawing.documents.doc.name, "old");
    assert.equal(h.root.auditOutbox, undefined);
});
