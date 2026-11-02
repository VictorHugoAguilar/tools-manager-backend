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

test("columns accept custom hex colors and reject invalid color values", async () => {
    const column = await board.createColumn({ name: "Backlog", color: "#aabbcc" });
    assert.equal(column.color, "#aabbcc");
    const updated = await board.updateColumn(column.id, { name: "Preparado", color: "#123456" });
    assert.equal(updated.name, "Preparado");
    assert.equal(updated.color, "#123456");

    await assert.rejects(
        board.createColumn({ name: "Inválida", color: "not-a-color" }),
        { statusCode: 400, message: "El color debe ser un valor hexadecimal válido." }
    );
    await assert.rejects(
        board.updateColumn(column.id, { color: "rgb(0, 0, 0)" }),
        { statusCode: 400, message: "El color debe ser un valor hexadecimal válido." }
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

test("comment authors can edit comments and unauthorized members cannot", async () => {
    const column = (await board.getBoard()).columns[0];
    const task = await board.createTask({
        title: "Comentarios",
        description: "",
        columnId: column.id,
        priority: "medium",
        labelIds: [],
        dueDate: "",
        assigneeId: ""
    }, actor);
    const comment = await board.addComment(task.id, "Comentario inicial", actor);
    const updated = await board.updateComment(task.id, comment.id, "Comentario revisado", actor);

    assert.equal(updated.text, "Comentario revisado");
    assert.equal(updated.authorId, actor.id);
    assert.ok(updated.updatedAt);
    await assert.rejects(
        board.updateComment(task.id, comment.id, "Edición no autorizada", { id: "member-2" }),
        { statusCode: 403, message: "Solo el autor puede editar este comentario." }
    );
});

test("comment authors and users with management permission can delete comments", async () => {
    const column = (await board.getBoard()).columns[0];
    const task = await board.createTask({
        title: "Comentarios",
        description: "",
        columnId: column.id,
        priority: "medium",
        labelIds: [],
        dueDate: "",
        assigneeId: ""
    }, actor);
    const ownComment = await board.addComment(task.id, "Comentario propio", actor);
    const otherComment = await board.addComment(task.id, "Comentario ajeno", {
        id: "member-2",
        firstName: "Grace",
        lastName: "Hopper"
    });

    await assert.rejects(
        board.removeComment(task.id, otherComment.id, actor),
        { statusCode: 403, message: "No tienes permiso para eliminar este comentario." }
    );
    assert.equal(await board.removeComment(task.id, ownComment.id, actor), true);
    assert.equal(await board.removeComment(task.id, otherComment.id, {
        id: "admin",
        firstName: "Admin",
        lastName: "User",
        permissions: ["users:manage"]
    }), true);
    const savedTask = (await board.getBoard()).tasks.find((item) => item.id === task.id);
    assert.deepEqual(savedTask.comments, []);
});
