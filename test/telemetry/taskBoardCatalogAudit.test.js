const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { loadModuleWithMocks } = require("../helpers/loadModuleWithMocks");
const { transactTaskBoardCatalog } = require("../../src/audit/businessOutbox");
const { AuditOutboxWorker } = require("../../src/audit/outboxWorker");

function harness(initial = {}) {
    let root = structuredClone(initial);
    let retry;
    let failure = false;
    const database = {
        ref(pathname) {
            if (!pathname) return { async transaction(change) {
                if (failure) throw new Error("database unavailable");
                let result = change(structuredClone(root));
                if (retry) {
                    retry(root);
                    retry = undefined;
                    result = change(structuredClone(root));
                }
                if (result === undefined) return { committed: false };
                root = result;
                return { committed: true };
            } };
            if (pathname === "taskBoard") {
                function boardReference(childPath = "") {
                    return {
                        child(child) { return boardReference([childPath, child].filter(Boolean).join("/")); },
                        async get() {
                            const value = childPath.split("/").filter(Boolean).reduce(
                                (node, key) => node?.[key], root.taskBoard
                            );
                            return { exists: () => value != null, val: () => value ?? null };
                        },
                        async transaction(change) {
                            let result = change(structuredClone(root.taskBoard ?? null));
                            if (retry) {
                                retry(root);
                                retry = undefined;
                                result = change(structuredClone(root.taskBoard ?? null));
                            }
                            root.taskBoard = result;
                            return { committed: true };
                        }
                    };
                }
                return boardReference();
            }
            if (pathname === "authUsers") return { async get() { return { val: () => ({}) }; } };
            assert.equal(pathname, "auditOutbox");
            return {
                orderByKey() { return this; },
                limitToFirst() { return this; },
                async get() { return { forEach(callback) {
                    for (const [key, value] of Object.entries(root.auditOutbox || {})) {
                        callback({ key, val: () => structuredClone(value) });
                    }
                } }; },
                child(id) { return { async transaction(change) {
                    const value = change(root.auditOutbox[id]);
                    if (value === null) delete root.auditOutbox[id];
                    return { committed: value !== undefined };
                } }; }
            };
        }
    };
    const board = loadModuleWithMocks(path.resolve(__dirname, "../../src/services/taskBoardService.js"), {
        "../config/firebaseAdmin": { getAdminDatabase: () => database },
        "../audit/businessOutbox": {
            isTaskBoardCatalogAuditEnabled: () => true,
            transactTaskBoardCatalog: (options) => transactTaskBoardCatalog({ ...options, database })
        }
    });
    return {
        board, database, get root() { return root; },
        retry(callback) { retry = callback; },
        fail() { failure = true; }
    };
}

const actor = { id: "actor", firstName: "Private", lastName: "Name" };

test("board catalog mutations commit sanitized events and publish them", async () => {
    const h = harness({ unrelated: { kept: true } });
    const column = await h.board.createColumn({ name: "private column" }, actor);
    assert.equal(column.position, 4);
    assert.equal((await h.board.updateColumn(column.id, { name: "other private value" }, actor)).name, "other private value");
    const ids = Object.keys(h.root.taskBoard.columns).reverse();
    assert.deepEqual((await h.board.reorderColumns(ids, actor)).map((item) => item.id), ids);
    const label = await h.board.createLabel({ name: "private label", color: "#123456" }, actor);
    await h.board.updateLabel(label.id, { color: "#abcdef" }, actor);
    h.root.taskBoard.tasks = { task: { labelIds: [label.id, "keep"] } };
    assert.equal(await h.board.deleteLabel(label.id, actor), true);
    assert.deepEqual(h.root.taskBoard.tasks.task.labelIds, ["keep"]);
    assert.equal(await h.board.deleteColumn(column.id, actor), true);
    const events = Object.values(h.root.auditOutbox);
    assert.deepEqual(events.map((event) => event.action), [
        "task_board.column.created", "task_board.column.updated", "task_board.column.reordered",
        "task_board.label.created", "task_board.label.updated", "task_board.label.deleted",
        "task_board.column.deleted"
    ]);
    assert.ok(events.every((event) => event.actorId === actor.id && event.targetId));
    assert.doesNotMatch(JSON.stringify(events), /private|abcdef|123456/i);
    assert.deepEqual(h.root.unrelated, { kept: true });
    const published = [];
    const worker = new AuditOutboxWorker({
        getRealtimeDatabase: () => h.database,
        getFirestoreDatabase: () => ({ collection: () => ({ doc: () => ({ create: async (event) => published.push(event) }) }) })
    });
    await worker.flush();
    assert.equal(published.length, 7);
    assert.equal(Object.keys(h.root.auditOutbox).length, 0);
});

test("conflicts and missing entities do not produce events", async () => {
    const h = harness({ taskBoard: {
        columns: { one: { name: "one", position: 0 } },
        labels: { label: { name: "Existing", color: "#abcdef" } },
        tasks: { task: { columnId: "one" } }
    } });
    await assert.rejects(h.board.deleteColumn("one", actor), { statusCode: 409 });
    await assert.rejects(h.board.createLabel({ name: "existing", color: "#abcdef" }, actor), { statusCode: 409 });
    await assert.rejects(h.board.reorderColumns(["missing"], actor), { statusCode: 400 });
    assert.equal(await h.board.updateColumn("missing", { name: "name" }, actor), null);
    assert.equal(await h.board.deleteLabel("missing", actor), false);
    assert.equal(h.root.auditOutbox, undefined);
});

test("initialization respects an existing false marker and empty reorder is a no-op", async () => {
    const empty = harness({});
    assert.deepEqual(await empty.board.reorderColumns([], actor), []);
    assert.equal(empty.root.auditOutbox, undefined);
    const h = harness({ taskBoard: { _meta: { initialized: false } } });
    const column = await h.board.createColumn({ name: "One" }, actor);
    assert.equal(column.position, 0);
    assert.equal(h.root.taskBoard._meta.initialized, false);
    assert.equal(Object.keys(h.root.taskBoard.columns).length, 1);
    assert.equal(h.root.taskBoard.labels, undefined);
});

test("board initialization retries without overwriting a concurrently created label", async () => {
    const h = harness({});
    h.retry((root) => {
        root.taskBoard = { labels: { custom: { name: "Custom", color: "#abcdef" } } };
    });
    const result = await h.board.getBoard();
    assert.deepEqual(result.labels.map((label) => label.id), ["custom"]);
    assert.equal(result.columns.length, 4);
    assert.equal(h.root.auditOutbox, undefined);
});

test("transaction retries enforce latest references and uniqueness", async () => {
    const h = harness({ taskBoard: { columns: { one: { position: 0 } }, labels: {} } });
    h.retry((root) => { root.taskBoard.tasks = { task: { columnId: "one" } }; });
    await assert.rejects(h.board.deleteColumn("one", actor), { statusCode: 409 });
    assert.ok(h.root.taskBoard.columns.one);
    h.retry((root) => { root.taskBoard.labels.other = { name: "same" }; });
    await assert.rejects(h.board.createLabel({ name: "Same", color: "#abcdef" }, actor), { statusCode: 409 });
    assert.equal(h.root.auditOutbox, undefined);
});

test("transaction errors and missing actors fail closed", async () => {
    const h = harness({ taskBoard: { columns: { one: { name: "original", position: 0 } } } });
    await assert.rejects(h.board.updateColumn("one", { name: "new" }), /Datos de auditoría no válidos/);
    h.fail();
    await assert.rejects(h.board.updateColumn("one", { name: "new" }, actor), /database unavailable/);
    assert.equal(h.root.taskBoard.columns.one.name, "original");
    assert.equal(h.root.auditOutbox, undefined);
});

test("controllers pass authenticated actor to every audited catalog operation", async () => {
    const calls = [];
    const service = Object.fromEntries([
        "createColumn", "updateColumn", "deleteColumn", "reorderColumns",
        "createLabel", "updateLabel", "deleteLabel"
    ].map((name) => [name, async (...args) => { calls.push([name, ...args]); return {}; }]));
    const { taskBoardController } = loadModuleWithMocks(
        path.resolve(__dirname, "../../src/controllers/taskBoardController.js"),
        { "../services/taskBoardService": service }
    );
    const req = { body: { ids: [] }, params: { id: "id" }, authUser: actor };
    const res = { status() { return this; }, json() { return this; }, send() { return this; } };
    for (const name of Object.keys(service)) await taskBoardController[name](req, res, (error) => { throw error; });
    assert.equal(calls.length, 7);
    assert.ok(calls.every((call) => call.at(-1) === actor));
});
