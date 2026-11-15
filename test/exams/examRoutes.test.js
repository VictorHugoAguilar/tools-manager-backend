const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { requireCsrf } = require("../../src/middleware/authMiddleware");
const { createExamRouter } = require("../../src/exams/examRoutes");

test("exam routes enforce admin import permissions and CSRF, validate JSON and use the authenticated user", async () => {
    const calls = [];
    const service = {
        catalog: async () => [],
        history: async (id) => { calls.push(id); return []; },
        change: async (user, id, action) => {
            calls.push({ user, id, action });
            return { id, status: "finished" };
        },
        importBank: async (body) => { calls.push(body); return { imported: 1 }; }
    };
    const app = express();
    app.use(express.json());
    app.use("/api/exams", (req, res, next) => {
        if (!req.get("x-user")) return res.sendStatus(401);
        req.authUser = { id: req.get("x-user"), permissions: req.get("x-admin") ? ["users:manage"] : ["app:access"] };
        if (["POST", "PUT", "DELETE", "PATCH"].includes(req.method)) return requireCsrf(req, res, next);
        return next();
    }, createExamRouter(() => service));
    app.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({ message: err.message }));
    const server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    const url = `http://127.0.0.1:${server.address().port}/api/exams`;
    const headers = { "x-user": "alice", cookie: "tm_csrf=abc", "x-csrf-token": "abc" };
    const file = (text) => {
        const form = new FormData();
        form.append("file", new Blob([text], { type: "application/json" }), "bank.json");
        return form;
    };
    try {
        assert.equal((await fetch(`${url}/history`)).status, 401);
        assert.equal((await fetch(`${url}/history`, { headers })).status, 200);
        assert.equal(calls[0], "alice");
        assert.equal((await fetch(`${url}/import`, { method: "POST", headers, body: file("{}") })).status, 403);
        assert.equal((await fetch(`${url}/import`, { method: "POST", headers: { "x-user": "alice", "x-admin": "1" }, body: file("{}") })).status, 403);
        const admin = { ...headers, "x-admin": "1" };
        assert.equal((await fetch(`${url}/import`, { method: "POST", headers: admin, body: file("broken") })).status, 400);
        const response = await fetch(`${url}/import`, { method: "POST", headers: admin, body: file('{"questions":[]}') });
        assert.equal(response.status, 200);
        assert.deepEqual(calls[1], { questions: [] });
        const finish = await fetch(`${url}/exams/exam-1/finish`, { method: "POST", headers });
        assert.equal(finish.status, 200);
        assert.equal((await finish.json()).status, "finished");
        assert.deepEqual(calls[2], { user: "alice", id: "exam-1", action: { type: "finish" } });

        const maxBytes = 2 * 1024 * 1024;
        const exactLimit = `{}${" ".repeat(maxBytes - 2)}`;
        const atLimit = await fetch(`${url}/import`, { method: "POST", headers: admin, body: file(exactLimit) });
        assert.equal(atLimit.status, 200);
        assert.deepEqual(calls[3], {});
        const aboveLimit = await fetch(`${url}/import`, { method: "POST", headers: admin, body: file(`${exactLimit} `) });
        assert.equal(aboveLimit.status, 400);
        assert.equal((await aboveLimit.json()).message, "El archivo supera el límite de 2 MB.");
        assert.equal(calls.length, 4);
    } finally {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
});
