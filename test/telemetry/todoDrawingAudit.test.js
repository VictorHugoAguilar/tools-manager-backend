const test = require("node:test");
const assert = require("node:assert/strict");
const { loadModuleWithMocks } = require("../helpers/loadModuleWithMocks");
const {
    transactTodoProject, transactTodoSection, transactDrawingDocument, transactDrawingPage, isTodoSectionAuditEnabled
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
            assert.equal(path, "auditOutbox");
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
        isDrawingDocumentAuditEnabled: () => true,
        isDrawingPageAuditEnabled: () => true,
        transactTodoProject: (options) => transactTodoProject({ ...options, database }),
        transactTodoSection: (options) => transactTodoSection({ ...options, database }),
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
