const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { EventEmitter } = require("node:events");
const { TelemetryManager } = require("../../src/telemetry/telemetry");
const { createTelemetryMiddleware } = require("../../src/middleware/telemetryMiddleware");
const { authOperationTelemetry } = require("../../src/middleware/authOperationTelemetry");
const { installProcessFailureHandlers } = require("../../src/telemetry/processFailures");

const manager = () => new TelemetryManager({ enabled: true, environment: "test", instanceId: "instance" });
const base = () => ({ traceId: randomUUID(), requestId: randomUUID(), durationMs: 5 });

test("auth operations record outcome and level without credentials", () => {
    const m = manager();
    m.recordAuthOperation({ ...base(), operation: "login", actorId: "actor", statusCode: 200 });
    m.recordAuthOperation({ ...base(), operation: "login", statusCode: 401 });
    m.recordAuthOperation({ ...base(), operation: "logout", actorId: "actor", statusCode: 204 });
    const events = m.queue.items;
    assert.deepEqual(events.map((e) => [e.eventName, e.level]), [
        ["auth.login.succeeded", "INFO"], ["auth.login.failed", "WARN"], ["auth.logout.completed", "INFO"]
    ]);
    assert.equal(Object.hasOwn(events[1], "actorId"), false);
    assert.equal(events[0].http.route, "/api/auth/login");
    assert.throws(() => m.recordAuthOperation({ ...base(), operation: "register", statusCode: 200 }));
});

test("access denied events are limited per minute and only accept 401 or 403", () => {
    const m = manager();
    const event = { ...base(), method: "GET", route: "/api/tools", statusCode: 403 };
    for (let i = 0; i < 60; i += 1) assert.equal(m.recordAccessDenied(event), true);
    assert.equal(m.recordAccessDenied(event), false);
    assert.equal(m.getHealth().accessDeniedSuppressed, 1);
    assert.throws(() => m.recordAccessDenied({ ...event, statusCode: 404 }));
});

test("api actions contain only method, normalized route and status", () => {
    const m = manager();
    m.recordApiAction({ ...base(), actorId: "actor", method: "DELETE", route: "/api/tags/:id", statusCode: 204 });
    const [event] = m.queue.items;
    assert.equal(event.eventName, "api.action.completed");
    assert.deepEqual(event.http, { method: "DELETE", route: "/api/tags/:id", statusCode: 204 });
    assert.throws(() => m.recordApiAction({ ...base(), method: "GET", route: "/api/tags", statusCode: 200 }));
});

test("http middleware records actions, denials and skips covered modules and server errors", () => {
    const calls = [];
    const fake = {
        enabled: true, recordHttpMetric() {}, recordHttpFailure() {},
        recordAccessDenied: (e) => calls.push(["denied", e]), recordApiAction: (e) => calls.push(["action", e])
    };
    const run = (url, method, status, path) => {
        const res = new EventEmitter();
        res.statusCode = status; res.setHeader = () => {}; res.getHeader = () => undefined;
        createTelemetryMiddleware(fake)({ originalUrl: url, method, get: () => undefined, route: { path }, authUser: { id: "a" } }, res, () => {});
        res.emit("finish");
    };
    run("/api/tags/private-id", "PUT", 200, "/:id");
    run("/api/tools/x", "DELETE", 204, "/:id");
    run("/api/locations", "POST", 500, "/");
    run("/api/technicians", "GET", 403, "/");
    run("/api/auth/me", "GET", 401, "/me");
    assert.deepEqual(calls.map(([kind, e]) => [kind, e.route]), [["action", "/api/tags/:id"], ["denied", "/api/technicians"]]);
});

test("auth middleware reports the actor that login stored", () => {
    let captured;
    const res = new EventEmitter();
    res.statusCode = 200; res.locals = { telemetryActorId: "actor" };
    res.getHeader = () => randomUUID();
    authOperationTelemetry("login", { enabled: true, recordAuthOperation: (e) => { captured = e; } })({}, res, () => {});
    res.emit("finish");
    assert.equal(captured.actorId, "actor");
});

test("process failures are recorded with the error name only, flushed, and the process still exits", async () => {
    const m = manager();
    let flushed = 0;
    m.flushForShutdown = async () => { flushed += 1; };
    const proc = new EventEmitter();
    const exits = [];
    proc.exit = (code) => exits.push(code);
    const logs = [];
    installProcessFailureHandlers({ manager: m, processRef: proc, logger: { error: (...a) => logs.push(a) } });
    const error = Object.assign(new TypeError("token=secret"), { stack: "secret" });
    proc.emit("unhandledRejection", error);
    proc.emit("uncaughtException", error);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(flushed, 1);
    assert.deepEqual(exits, [1]);
    const [event] = m.queue.items;
    assert.equal(event.eventName, "process.unhandled_rejection");
    assert.equal(event.errorName, "TypeError");
    assert.ok(!JSON.stringify(event).includes("secret"));
});
