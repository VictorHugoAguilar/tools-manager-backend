const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
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

function reference(path = "") {
    return {
        key: path.split("/").filter(Boolean).at(-1) ?? null,
        child(childPath) {
            return reference([path, childPath].filter(Boolean).join("/"));
        },
        async get() {
            const value = readPath(path);
            return {
                exists: () => value !== null && value !== undefined,
                val: () => value === undefined ? null : structuredClone(value)
            };
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
        push() {
            return reference([path, randomUUID()].filter(Boolean).join("/"));
        }
    };
}

const fakeDatabase = { ref: reference };
firebaseAdmin.getAdminDatabase = () => fakeDatabase;
const board = require("../../src/services/taskBoardService");

const actor = { id: "member-1", firstName: "Ada", lastName: "Lovelace" };

test.beforeEach(() => {
    database = { authUsers: { [actor.id]: { firstName: actor.firstName, lastName: actor.lastName } } };
});

test("board catalogs remain empty after all columns are deliberately removed", async () => {
    const initial = await board.getBoard();
    for (const column of initial.columns) await board.deleteColumn(column.id);

    assert.deepEqual((await board.getBoard()).columns, []);
});

test("column creation rejects unsupported colors", async () => {
    await assert.rejects(
        board.createColumn({ name: "Backlog", color: "#ffffff" }),
        { statusCode: 400, message: "El color de la lista no es válido." }
    );
});

test("editing a task into another column reorders both columns", async () => {
    const initial = await board.getBoard();
    const [todo, inProgress] = initial.columns;
    const first = await board.createTask({
        title: "Primera",
        description: "",
        columnId: todo.id,
        priority: "medium",
        labelIds: [],
        dueDate: "",
        assigneeId: ""
    }, actor);
    const second = await board.createTask({
        title: "Segunda",
        description: "",
        columnId: todo.id,
        priority: "low",
        labelIds: [],
        dueDate: "",
        assigneeId: ""
    }, actor);
    const targetTask = await board.createTask({
        title: "Destino",
        description: "",
        columnId: inProgress.id,
        priority: "high",
        labelIds: [],
        dueDate: "",
        assigneeId: ""
    }, actor);

    await board.updateTask(first.id, { columnId: inProgress.id }, actor);
    const tasks = await board.getBoard();
    const updatedFirst = tasks.tasks.find((task) => task.id === first.id);
    const updatedSecond = tasks.tasks.find((task) => task.id === second.id);
    const unchangedTarget = tasks.tasks.find((task) => task.id === targetTask.id);

    assert.equal(updatedFirst.columnId, inProgress.id);
    assert.equal(updatedFirst.position, 1);
    assert.equal(unchangedTarget.position, 0);
    assert.equal(updatedSecond.columnId, todo.id);
    assert.equal(updatedSecond.position, 0);
});
