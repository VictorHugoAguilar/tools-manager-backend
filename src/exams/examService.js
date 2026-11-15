const { randomUUID, randomInt } = require("node:crypto");
const { getAdminDatabase } = require("../config/firebaseAdmin");

const KEY = /^[A-Za-z0-9_-]{1,100}$/;
const SECTIONS = ["electricidad_radioelectricidad", "reglamentacion_manejo"];
const MAX_QUESTIONS = 2000;

function fail(message, statusCode = 400) {
    throw Object.assign(new Error(message), { statusCode });
}

function text(value, field, max = 2000) {
    if (typeof value !== "string" || !value.trim() || value.length > max) fail(`Campo inválido: ${field}.`);
    return value.trim();
}

function key(value, field) {
    if (typeof value !== "string" || !KEY.test(value) ||
        ["__proto__", "prototype", "constructor"].includes(value)) fail(`Identificador inválido: ${field}.`);
    return value;
}

function validateBank(data) {
    if (!data || typeof data !== "object" || !Array.isArray(data.questions) ||
        !data.questions.length || data.questions.length > MAX_QUESTIONS) {
        fail(`El archivo debe contener entre 1 y ${MAX_QUESTIONS} preguntas.`);
    }
    const ids = new Set();
    const questions = data.questions.map((q) => {
        if (!q || typeof q !== "object") fail("Pregunta inválida.");
        const id = key(q.id, "id de pregunta");
        if (ids.has(id)) fail(`El identificador ${id} está duplicado.`);
        ids.add(id);
        const section = key(q.section, "section");
        if (!SECTIONS.includes(section)) fail(`Sección no admitida: ${section}.`);
        if (q.type !== "single_choice" || !Array.isArray(q.options) || q.options.length !== 4) {
            fail(`La pregunta ${id} debe tener cuatro opciones de selección única.`);
        }
        const options = q.options.map((o) => ({ id: key(o?.id, "opción"), text: text(o?.text, "opción") }));
        if (new Set(options.map((o) => o.id)).size !== 4 || !options.some((o) => o.id === q.correctOptionId)) {
            fail(`Las opciones o la respuesta correcta de ${id} no son válidas.`);
        }
        const list = (value, field) => {
            if (!Array.isArray(value) || value.length > 50) fail(`Campo inválido: ${field}.`);
            return value.map((v) => text(v, field, 200));
        };
        if (!["basico", "intermedio", "avanzado"].includes(q.difficulty)) fail(`Dificultad inválida en ${id}.`);
        return {
            id, section, category: text(q.category, "category", 200), topic: text(q.topic, "topic", 200),
            difficulty: q.difficulty, question: text(q.question, "question", 4000), options,
            correctOptionId: q.correctOptionId, explanation: text(q.explanation, "explanation", 4000),
            tags: list(q.tags, "tags"), sourceRefs: list(q.sourceRefs, "sourceRefs"), type: "single_choice"
        };
    });
    return questions;
}

function shuffle(items) {
    const result = [...items];
    for (let i = result.length - 1; i > 0; i--) {
        const j = randomInt(i + 1);
        [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
}

function publicExam(exam) {
    const { questions, ...rest } = exam;
    return {
        ...rest,
        questions: questions.map(({ correctOptionId, explanation, ...question }) =>
            exam.status === "finished" ? { ...question, correctOptionId, explanation } : question)
    };
}

function finish(exam, now) {
    const answers = exam.answers || {};
    const correct = exam.questions.filter((q) => answers[q.id] === q.correctOptionId).length;
    const answered = exam.questions.filter((q) => answers[q.id]).length;
    return {
        ...exam, status: "finished", finishedAt: Math.min(now, exam.deadlineAt),
        correct, incorrect: answered - correct, unanswered: exam.questions.length - answered,
        durationSeconds: Math.max(0, Math.floor((Math.min(now, exam.deadlineAt) - exam.startedAt) / 1000))
    };
}

function createExamService(database = getAdminDatabase(), now = () => Date.now()) {
    const bank = database.ref("examPractice/bank/questions");
    const userRef = (userId) => database.ref(`examPractice/users/${key(userId, "usuario")}/exams`);
    const examRef = (userId, id) => userRef(userId).child(key(id, "examen"));

    async function importBank(data) {
        const questions = validateBank(data);
        const result = await bank.transaction((current) => {
            const merged = { ...(current || {}) };
            for (const question of questions) merged[question.id] = question;
            return merged;
        });
        if (!result.committed) fail("No se pudo completar la importación.", 409);
        return { imported: questions.length };
    }

    async function catalog() {
        const snapshot = await bank.get();
        const questions = Object.values(snapshot.val() || {});
        return SECTIONS.map((id) => ({
            id,
            name: id === SECTIONS[0] ? "Electricidad y radioelectricidad" : "Reglamentación y manejo",
            count: questions.filter((q) => q.section === id).length
        }));
    }

    async function start(userId, section, minutes) {
        if (section !== "mixed" && !SECTIONS.includes(section)) fail("Materia no válida.");
        if (![5, 10, 15, 20, 30].includes(minutes)) fail("Tiempo no válido.");
        const snapshot = await bank.get();
        const all = Object.values(snapshot.val() || {});
        const selected = section === "mixed"
            ? SECTIONS.flatMap((id) => shuffle(all.filter((q) => q.section === id)).slice(0, 5))
            : shuffle(all.filter((q) => q.section === section)).slice(0, 10);
        if (selected.length !== 10) fail("No hay suficientes preguntas para este examen.", 409);
        const startedAt = now();
        const exam = {
            id: randomUUID(), section, minutes, status: "active", startedAt,
            deadlineAt: startedAt + minutes * 60000,
            questions: shuffle(selected).map((q) => ({ ...q, options: shuffle(q.options) })),
            answers: {}
        };
        await examRef(userId, exam.id).set(exam);
        return publicExam(exam);
    }

    async function change(userId, id, action) {
        let error;
        const ref = examRef(userId, id);
        let listener;
        try {
            // Mantener la escucha activa carga la caché de RTDB antes de evaluar la transacción.
            await new Promise((resolve, reject) => {
                listener = () => resolve();
                ref.on("value", listener, reject);
            });
            const result = await ref.transaction((exam) => {
                error = null;
                if (!exam) { error = [404, "Examen no encontrado."]; return; }
                if (exam.status === "finished") {
                    if (action.type === "finish" || action.type === "read") return exam;
                    error = [409, "El examen ya ha finalizado."];
                    return;
                }
                const currentTime = now();
                if (currentTime >= exam.deadlineAt || action.type === "finish") return finish(exam, currentTime);
                if (action.type === "answer") {
                    const question = exam.questions.find((q) => q.id === action.questionId);
                    if (!question || !question.options.some((option) => option.id === action.optionId)) {
                        error = [400, "Respuesta no válida."];
                        return;
                    }
                    return { ...exam, answers: { ...(exam.answers || {}), [question.id]: action.optionId } };
                }
                return exam;
            });
            if (!result.committed) fail(error?.[1] || "No se pudo actualizar el examen.", error?.[0] || 409);
            return publicExam(result.snapshot.val());
        } finally {
            if (listener) ref.off("value", listener);
        }
    }

    async function history(userId) {
        let snapshot;
        try {
            snapshot = await userRef(userId).orderByChild("startedAt").limitToLast(200).get();
        } catch (error) {
            if (error instanceof Error && /Index not defined/i.test(error.message) &&
                error.message.includes("startedAt")) {
                throw Object.assign(new Error(
                    "Falta el índice startedAt del historial de exámenes en las reglas de Realtime Database.",
                    { cause: error }
                ), { statusCode: 503 });
            }
            throw error;
        }
        const records = await Promise.all(Object.values(snapshot.val() || {}).map((exam) =>
            exam.status === "active" && exam.deadlineAt <= now()
                ? change(userId, exam.id, { type: "read" }) : exam));
        return records.filter((e) => e.status === "finished")
            .sort((a, b) => b.startedAt - a.startedAt)
            .map(({ id, section, startedAt, finishedAt, correct, incorrect, unanswered, durationSeconds }) =>
                ({ id, section, startedAt, finishedAt, correct, incorrect, unanswered, durationSeconds }));
    }
    return { importBank, catalog, start, change, history };
}

module.exports = { createExamService, validateBank, publicExam, finish };
