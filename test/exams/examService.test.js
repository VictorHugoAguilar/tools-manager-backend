const test = require("node:test");
const assert = require("node:assert/strict");
const { createExamService, validateBank } = require("../../src/exams/examService");
const bank = require("../../data/exams/banco_practica_harec.json");

function fakeDatabase() {
    const root = {};
    const activeListeners = new Set();
    const stats = { listeners: 0 };
    function reference(path) {
        const parts = path.split("/");
        const read = () => parts.reduce((value, part) => value?.[part], root);
        const write = (value) => {
            let node = root;
            for (const part of parts.slice(0, -1)) node = node[part] ||= {};
            node[parts.at(-1)] = structuredClone(value);
        };
        return {
            child: (part) => reference(`${path}/${part}`),
            get: async () => ({ val: () => structuredClone(read() ?? null) }),
            set: async (value) => write(value),
            on(event, listener) {
                assert.equal(event, "value");
                activeListeners.add(path);
                stats.listeners += 1;
                queueMicrotask(() => listener({ val: () => structuredClone(read() ?? null) }));
            },
            off(event) {
                assert.equal(event, "value");
                activeListeners.delete(path);
                stats.listeners -= 1;
            },
            transaction: async (fn) => {
                const cached = path.includes("/exams/") && !activeListeners.has(path) ? null : read();
                const next = fn(structuredClone(cached ?? null));
                if (next === undefined) return { committed: false };
                write(next);
                return { committed: true, snapshot: { val: () => structuredClone(next) } };
            },
            orderByChild() { return this; },
            limitToLast() { return this; }
        };
    }
    return { ref: reference, stats };
}

test("validates the supplied bank, duplicate IDs and invalid answers before import", () => {
    assert.equal(validateBank(bank).length, 60);
    assert.throws(() => validateBank({ questions: [bank.questions[0], bank.questions[0]] }), /duplicado/);
    assert.throws(() => validateBank({ questions: [{ ...bank.questions[0], correctOptionId: "z" }] }), /respuesta correcta/);
    assert.throws(() => validateBank({ questions: [{ ...bank.questions[0], id: "../invalid" }] }), /Identificador/);
    assert.throws(() => validateBank({ questions: [{ ...bank.questions[0], id: "__proto__" }] }), /Identificador/);
});

test("imports by ID without deleting other questions and makes updates visible", async () => {
    const database = fakeDatabase();
    const service = createExamService(database);
    await service.importBank(bank);
    await service.importBank({ questions: [{ ...bank.questions[0], question: "Pregunta actualizada" }] });
    const sections = await service.catalog();
    assert.deepEqual(sections.map((s) => s.count), [30, 30]);
    const stored = (await database.ref("examPractice/bank/questions").get()).val();
    assert.equal(stored[bank.questions[0].id].question, "Pregunta actualizada");
    assert.equal(Object.keys(stored).length, 60);
});

test("mixed exams have five questions per section, hide solutions, and isolate users", async () => {
    const service = createExamService(fakeDatabase());
    await service.importBank(bank);
    const exam = await service.start("alice", "mixed", 10);
    assert.equal(exam.questions.length, 10);
    assert.equal(exam.questions.filter((q) => q.section === "electricidad_radioelectricidad").length, 5);
    assert.equal(exam.questions.filter((q) => q.section === "reglamentacion_manejo").length, 5);
    assert.ok(exam.questions.every((q) => !("correctOptionId" in q) && !("explanation" in q)));
    await assert.rejects(service.change("bob", exam.id, { type: "read" }), { statusCode: 404 });
    await assert.rejects(service.change("alice", exam.id, {
        type: "answer", questionId: exam.questions[0].id, optionId: "invalid"
    }), { statusCode: 400 });
    const updated = await service.change("alice", exam.id, {
        type: "answer", questionId: exam.questions[0].id, optionId: exam.questions[0].options[0].id
    });
    assert.equal(updated.answers[exam.questions[0].id], exam.questions[0].options[0].id);
    const result = await service.change("alice", exam.id, { type: "finish" });
    assert.equal(result.status, "finished");
    assert.equal(result.correct + result.incorrect + result.unanswered, 10);
    assert.equal(result.unanswered, 9);
    assert.equal((await service.history("alice")).length, 1);
    assert.equal((await service.history("bob")).length, 0);
    await assert.rejects(service.change("alice", exam.id, { type: "answer" }), { statusCode: 409 });
});

test("expired exams are corrected using previously saved answers and cannot accept a late answer", async () => {
    let time = 100000;
    const service = createExamService(fakeDatabase(), () => time);
    await service.importBank(bank);
    const exam = await service.start("user", "mixed", 5);
    time += 300001;
    const result = await service.change("user", exam.id, {
        type: "answer", questionId: exam.questions[0].id, optionId: exam.questions[0].options[0].id
    });
    assert.equal(result.status, "finished");
    assert.equal(result.unanswered, 10);
    assert.equal(result.durationSeconds, 300);
});

test("history completes expired attempts when the browser was closed", async () => {
    let time = 100000;
    const service = createExamService(fakeDatabase(), () => time);
    await service.importBank(bank);
    await service.start("user", "mixed", 5);
    time += 300000;
    const history = await service.history("user");
    assert.equal(history.length, 1);
    assert.equal(history[0].unanswered, 10);
});

test("cold Firebase cache loads the exam before a transaction and removes listeners", async () => {
    const database = fakeDatabase();
    const service = createExamService(database);
    await service.importBank(bank);
    const exam = await service.start("user", "mixed", 10);
    const question = exam.questions[0];
    const answered = await service.change("user", exam.id, {
        type: "answer", questionId: question.id, optionId: question.options[0].id
    });
    assert.equal(answered.answers[question.id], question.options[0].id);
    assert.equal(database.stats.listeners, 0);
    const finished = await service.change("user", exam.id, { type: "finish" });
    assert.equal(finished.status, "finished");
    assert.equal(finished.unanswered, 9);
    assert.equal(database.stats.listeners, 0);
    await assert.rejects(service.change("other-user", exam.id, { type: "finish" }), { statusCode: 404 });
    assert.equal(database.stats.listeners, 0);
});

test("listener errors propagate and the listener is detached", async () => {
    const failure = new Error("Firebase unavailable");
    let detached = false;
    const database = { ref() {
        return {
            child() { return this; },
            on(_event, _listener, cancel) { queueMicrotask(() => cancel(failure)); },
            off() { detached = true; }
        };
    } };
    const service = createExamService(database);
    await assert.rejects(service.change("user", "exam", { type: "finish" }), (error) => error === failure);
    assert.equal(detached, true);
});

test("history reports the missing Firebase index explicitly without hiding other database errors", async () => {
    let failure = new Error('Index not defined, add ".indexOn": "startedAt"');
    const database = { ref() {
        return { orderByChild() { return this; }, limitToLast() { return this; }, async get() { throw failure; } };
    } };
    const service = createExamService(database);
    await assert.rejects(service.history("user"), (error) =>
        error.statusCode === 503 && /índice startedAt/.test(error.message) && error.cause === failure);
    failure = new Error("Database unavailable");
    await assert.rejects(service.history("user"), (error) => error === failure);
});

test("exams preserve the questions and solutions from the moment they start", async () => {
    const service = createExamService(fakeDatabase());
    await service.importBank(bank);
    const exam = await service.start("user", "mixed", 10);
    const original = bank.questions.find((q) => q.id === exam.questions[0].id);
    await service.importBank({ questions: [{ ...original, question: "Editada", correctOptionId: original.options.find((o) => o.id !== original.correctOptionId).id }] });
    const result = await service.change("user", exam.id, { type: "finish" });
    assert.equal(result.questions[0].question, original.question);
    assert.equal(result.questions[0].correctOptionId, original.correctOptionId);
});
