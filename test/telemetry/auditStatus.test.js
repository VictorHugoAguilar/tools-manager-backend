const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const sessions = require("../../src/services/authSessionService");
const originalResolveSession = sessions.resolveSession;
sessions.resolveSession = async (token) => token === "allowed"
    ? { profile: { id: "actor", permissions: ["monitoring:app"] } }
    : token === "denied" ? { profile: { id: "denied", permissions: [] } } : null;
const { AuditOutboxWorker, STATUS_LIMIT } = require("../../src/audit/outboxWorker");
const { createMonitoringRouter } = require("../../src/routes/monitoringRoutes");
test.after(() => { sessions.resolveSession = originalResolveSession; });

test("pending summary is bounded and distinguishes an exact count from a lower bound", async () => {
    let count = 0;
    let limit;
    const worker = new AuditOutboxWorker({ getRealtimeDatabase: () => ({ ref(path) {
        assert.equal(path, "auditOutbox");
        return {
            orderByKey() { return this; },
            limitToFirst(value) { limit = value; return this; },
            async get() { return { numChildren: () => count }; }
        };
    } }) });
    assert.deepEqual(await worker.getPendingSummary(), { count: 0, truncated: false });
    count = STATUS_LIMIT;
    assert.deepEqual(await worker.getPendingSummary(), { count: STATUS_LIMIT, truncated: false });
    count = STATUS_LIMIT + 1;
    assert.deepEqual(await worker.getPendingSummary(), { count: STATUS_LIMIT, truncated: true });
    assert.equal(limit, STATUS_LIMIT + 1);
});

test("publisher health reflects failures and recovery without exposing error details", async () => {
    let fail = true;
    const worker = new AuditOutboxWorker({ getRealtimeDatabase: () => ({ ref: () => ({
        orderByKey() { return this; }, limitToFirst() { return this; },
        async get() {
            if (fail) throw new Error("sensitive error");
            return { forEach: () => {} };
        }
    }) }) });
    assert.deepEqual(worker.getHealth(), {
        running: false, inFlight: false, consecutiveFailures: 0, lastAttemptAt: null,
        lastSuccessfulCheckAt: null, lastFailureAt: null
    });
    await assert.rejects(worker.flush(), /sensitive error/);
    await assert.rejects(worker.flush(), /sensitive error/);
    assert.equal(worker.getHealth().consecutiveFailures, 2);
    assert.ok(worker.getHealth().lastFailureAt);
    assert.ok(worker.getHealth().lastAttemptAt);
    assert.doesNotMatch(JSON.stringify(worker.getHealth()), /sensitive error/);
    fail = false;
    await worker.flush();
    assert.equal(worker.getHealth().consecutiveFailures, 0);
    assert.ok(worker.getHealth().lastSuccessfulCheckAt);
    assert.ok(worker.getHealth().lastFailureAt);
});

test("concurrent flushes share one attempt and publisher health is local to each instance", async () => {
    let finish;
    let calls = 0;
    const worker = new AuditOutboxWorker();
    const other = new AuditOutboxWorker();
    worker.publishBatch = () => {
        calls++;
        return new Promise((resolve) => { finish = resolve; });
    };
    const first = worker.flush();
    const second = worker.flush();
    assert.equal(first, second);
    assert.equal(calls, 1);
    assert.equal(worker.getHealth().inFlight, true);
    assert.equal(other.getHealth().lastAttemptAt, null);
    finish();
    await first;
    assert.equal(worker.getHealth().inFlight, false);
    assert.ok(worker.getHealth().lastSuccessfulCheckAt);
    assert.equal(other.getHealth().lastSuccessfulCheckAt, null);
});

test("audit status is authorized, audited before reading and fails closed", async () => {
    const calls = [];
    let failAudit = false;
    let failRead = false;
    const worker = {
        async getPendingSummary() {
            calls.push("read");
            if (failRead) throw new Error("RTDB offline");
            return { count: STATUS_LIMIT, truncated: true };
        },
        getHealth() { return { running: false, inFlight: false, consecutiveFailures: 0, lastAttemptAt: null,
            lastSuccessfulCheckAt: null, lastFailureAt: null }; }
    };
    const db = { collection(name) {
        assert.equal(name, "auditEvents");
        return { doc: () => ({ async create(value) {
            calls.push(value);
            if (failAudit) throw new Error("audit offline");
        } }) };
    } };
    const manager = { enabled: true };
    const app = express();
    app.use("/api/monitoring", createMonitoringRouter({ manager, getDatabase: () => db, auditWorker: worker }));
    app.use((_error, _req, res, _next) => res.status(500).json({ message: "Internal server error" }));
    const server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    const url = `http://127.0.0.1:${server.address().port}/api/monitoring/audit-status`;
    const allowed = { headers: { cookie: "tm_session=allowed" } };
    try {
        assert.equal((await fetch(url)).status, 401);
        assert.equal((await fetch(url, { headers: { cookie: "tm_session=denied" } })).status, 403);
        assert.equal((await fetch(`${url}?unknown=1`, allowed)).status, 400);
        assert.equal(calls.length, 0);
        const response = await fetch(url, allowed);
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("cache-control"), "no-store");
        const data = await response.json();
        assert.deepEqual(data.pending, { count: STATUS_LIMIT, truncated: true });
        assert.equal(data.publisher.running, false);
        assert.ok(Number.isFinite(Date.parse(data.checkedAt)));
        assert.equal(calls[0].action, "monitoring.audit-status.accessed");
        assert.equal(calls[0].actorId, "actor");
        assert.equal(calls[1], "read");
        assert.doesNotMatch(JSON.stringify(data), /actor|targetId|password/);
        calls.length = 0;
        failAudit = true;
        assert.equal((await fetch(url, allowed)).status, 500);
        assert.equal(calls.length, 1);
        failAudit = false;
        failRead = true;
        calls.length = 0;
        assert.equal((await fetch(url, allowed)).status, 500);
        assert.equal(calls[1], "read");
        manager.enabled = false;
        calls.length = 0;
        assert.equal((await fetch(url, allowed)).status, 503);
        assert.equal(calls.length, 0);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});
