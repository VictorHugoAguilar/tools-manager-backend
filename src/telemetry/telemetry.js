const { createHash, randomUUID } = require("node:crypto");
const { getFirestore, Timestamp } = require("firebase-admin/firestore");
const { getAdminApp } = require("../config/firebaseAdmin");
const { HttpMetrics } = require("./httpMetrics");
const { WebSocketMetrics } = require("./webSocketMetrics");
const { DatabaseMetrics } = require("./databaseMetrics");
const { setDatabaseRecorder } = require("./databaseInstrumentation");
const { Heartbeat } = require("./heartbeat");
const { isTaskOperation } = require("./taskOperations");

const FRONTEND_EVENTS = {
    "frontend.runtime.error": { level: "ERROR", category: "runtime" },
    "frontend.api.request.failed": { level: "ERROR", category: "http" },
    "frontend.route.changed": { level: "INFO", category: "navigation" },
    "frontend.tools.search.completed": { level: "INFO", category: "tools" },
    "frontend.performance.measurement": { level: "INFO", category: "performance" },
    "frontend.performance.page.loaded": { level: "INFO", category: "performance" },
    "frontend.performance.first_contentful_paint": { level: "INFO", category: "performance" },
    "frontend.performance.largest_contentful_paint": { level: "INFO", category: "performance" },
    "frontend.performance.long_task": { level: "INFO", category: "performance" },
    "frontend.performance.route_transition": { level: "INFO", category: "performance" },
    "frontend.collaboration.sync.completed": { level: "INFO", category: "collaboration" },
    "frontend.collaboration.reconnected": { level: "INFO", category: "collaboration" },
    "frontend.collaboration.persist.completed": { level: "INFO", category: "collaboration" },
    "frontend.telemetry.flush.failed": { level: "WARN", category: "system" }
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LEVEL_PRIORITY = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
const MAX_EVENT_BYTES = 4096;
const MAX_ACCESS_DENIED_PER_MINUTE = 60;
const ACTION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function positiveInteger(value, fallback, max) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 && parsed <= max ? parsed : fallback;
}

function sampleRate(value) {
    if (value === undefined || value === "") return 1;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : 1;
}

// Un traceId se conserva o descarta entero para no dejar trazas incompletas.
function sampleKept(event, rate) {
    if (rate >= 1) return true;
    if (rate <= 0) return false;
    if (typeof event.traceId === "string" && event.traceId) {
        return createHash("sha256").update(event.traceId).digest().readUInt32BE(0) / 0x100000000 < rate;
    }
    return Math.random() < rate;
}

function normalizeFrontendEvent(input, { environment, actorId, instanceId }) {
    if (!input || typeof input !== "object" || Array.isArray(input)) return null;
    const allowed = new Set(["schemaVersion", "eventId", "occurredAt", "eventName", "traceId", "durationMs"]);
    if (Object.keys(input).some((key) => !allowed.has(key))) return null;
    if (typeof input.eventName !== "string" || !Object.hasOwn(FRONTEND_EVENTS, input.eventName)) return null;
    const definition = FRONTEND_EVENTS[input.eventName];
    if (input.schemaVersion !== 1 || typeof input.eventId !== "string" ||
        !UUID.test(input.eventId) || typeof input.occurredAt !== "string" ||
        !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(input.occurredAt) ||
        !Number.isFinite(Date.parse(input.occurredAt)) ||
        new Date(input.occurredAt).toISOString() !== input.occurredAt) return null;
    if (input.traceId !== undefined && (typeof input.traceId !== "string" || !UUID.test(input.traceId))) return null;
    if (input.durationMs !== undefined &&
        (typeof input.durationMs !== "number" || !Number.isFinite(input.durationMs) ||
            input.durationMs < 0 || input.durationMs > 86_400_000)) return null;
    return {
        schemaVersion: 1,
        eventId: input.eventId.toLowerCase(),
        occurredAt: input.occurredAt,
        receivedAt: new Date().toISOString(),
        service: "frontend",
        environment,
        ...definition,
        eventName: input.eventName,
        ...(input.traceId ? { traceId: input.traceId.toLowerCase() } : {}),
        ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
        actorId,
        instanceId
    };
}

class TelemetryQueue {
    constructor(capacity, sampleRates = {}) {
        this.capacity = capacity;
        this.items = [];
        this.dropped = { DEBUG: 0, INFO: 0, WARN: 0, ERROR: 0 };
        this.sampledOut = { DEBUG: 0, INFO: 0 };
        this.sampleRates = { DEBUG: sampleRate(sampleRates.DEBUG), INFO: sampleRate(sampleRates.INFO) };
    }

    enqueue(event) {
        if (!Object.hasOwn(LEVEL_PRIORITY, event.level) ||
            Buffer.byteLength(JSON.stringify(event)) > MAX_EVENT_BYTES) {
            throw new Error("Evento de telemetría no válido.");
        }
        // WARN y ERROR nunca se muestrean.
        if (Object.hasOwn(this.sampleRates, event.level) && !sampleKept(event, this.sampleRates[event.level])) {
            this.sampledOut[event.level] += 1;
            return false;
        }
        if (this.items.length >= this.capacity) {
            let lowestIndex = 0;
            for (let i = 1; i < this.items.length; i += 1) {
                if (LEVEL_PRIORITY[this.items[i].level] < LEVEL_PRIORITY[this.items[lowestIndex].level]) {
                    lowestIndex = i;
                }
            }
            if (LEVEL_PRIORITY[this.items[lowestIndex].level] >= LEVEL_PRIORITY[event.level]) {
                this.dropped[event.level] += 1;
                return false;
            }
            const [discarded] = this.items.splice(lowestIndex, 1);
            this.dropped[discarded.level] += 1;
        }
        this.items.push(event);
        return true;
    }

    drain(maxItems) {
        this.items.sort((a, b) => LEVEL_PRIORITY[b.level] - LEVEL_PRIORITY[a.level]);
        return this.items.splice(0, maxItems);
    }
}

class FirestoreTelemetrySink {
    constructor(getDatabase = () => getFirestore(getAdminApp())) {
        this.getDatabase = getDatabase;
    }

    async writeEvents(events) {
        const writer = this.getDatabase().bulkWriter();
        writer.onWriteError(() => false);
        const writes = events.map((event) => {
            const retentionDays = event.level === "ERROR" || event.level === "WARN" ? 30 : 14;
            const receivedAt = Timestamp.fromDate(new Date(event.receivedAt));
            const expiresAt = Timestamp.fromMillis(receivedAt.toMillis() + retentionDays * 86400000);
            const ref = this.getDatabase().collection("monitoringEvents").doc(event.eventId);
            return writer.create(ref, { ...event, receivedAt, expiresAt }).catch((error) => {
                if (error.code !== 6 && error.code !== "already-exists") throw error;
            });
        });
        const results = Promise.allSettled(writes);
        await writer.close();
        const failed = (await results).find((result) => result.status === "rejected");
        if (failed) throw failed.reason;
    }
}

class TelemetryManager {
    constructor(options = {}) {
        this.enabled = options.enabled ?? process.env.TELEMETRY_ENABLED === "true";
        this.environment = options.environment || (["production", "test"].includes(process.env.NODE_ENV)
            ? process.env.NODE_ENV : "development");
        this.instanceId = options.instanceId || randomUUID();
        this.service = options.service || "backend";
        this.queue = new TelemetryQueue(options.capacity ||
            positiveInteger(process.env.TELEMETRY_QUEUE_MAX_ITEMS, 5000, 100000), options.sampleRates || {
                DEBUG: process.env.TELEMETRY_SAMPLE_DEBUG,
                INFO: process.env.TELEMETRY_SAMPLE_INFO
            });
        this.batchSize = options.batchSize || positiveInteger(process.env.TELEMETRY_BATCH_MAX_ITEMS, 200, 500);
        this.intervalMs = options.intervalMs || positiveInteger(process.env.TELEMETRY_FLUSH_INTERVAL_MS, 1000, 60000);
        this.sink = options.sink || new FirestoreTelemetrySink();
        this.httpMetrics = options.httpMetrics || new HttpMetrics({
            instanceId: this.instanceId,
            environment: this.environment,
            getDatabase: () => getFirestore(getAdminApp())
        });
        this.webSocketMetrics = options.webSocketMetrics || (this.service === "websocket" ? new WebSocketMetrics({
            instanceId: this.instanceId,
            environment: this.environment,
            getDatabase: () => getFirestore(getAdminApp())
        }) : null);
        this.databaseMetrics = options.databaseMetrics || (this.service === "backend" ? new DatabaseMetrics({
            instanceId: this.instanceId,
            environment: this.environment,
            getDatabase: () => getFirestore(getAdminApp())
        }) : null);
        this.heartbeat = options.heartbeat || new Heartbeat({
            instanceId: this.instanceId,
            service: this.service,
            environment: this.environment,
            getDatabase: () => getFirestore(getAdminApp())
        });
        this.maxAttempts = options.maxAttempts || positiveInteger(process.env.TELEMETRY_RETRY_MAX_ATTEMPTS, 3, 10);
        this.retryBaseDelayMs = options.retryBaseDelayMs ||
            positiveInteger(process.env.TELEMETRY_RETRY_BASE_DELAY_MS, 500, 60000);
        this.nextRetryAt = 0;
        this.attempts = new WeakMap();
        this.failedEvents = 0;
        this.inFlight = null;
        this.consecutiveWriteFailures = 0;
        this.lastSuccessfulFlushAt = null;
        this.lastFlushDurationMs = null;
        this.timer = null;
        this.accessDeniedWindow = { minute: 0, count: 0 };
        this.accessDeniedSuppressed = 0;
    }

    start() {
        if (!this.enabled || this.timer) return;
        this.heartbeat.start();
        if (this.databaseMetrics) {
            setDatabaseRecorder((durationMs, failed) => this.databaseMetrics.recordOperation(durationMs, failed));
        }
        this.timer = setInterval(() => {
            void this.flush();
            void this.httpMetrics.flush();
            if (this.webSocketMetrics) void this.webSocketMetrics.flush();
            if (this.databaseMetrics) void this.databaseMetrics.flush();
        }, this.intervalMs);
        this.timer.unref();
    }

    stop() {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        setDatabaseRecorder(null);
        this.heartbeat.stop();
    }

    enqueueFrontend(input, actorId) {
        const event = normalizeFrontendEvent(input, {
            environment: this.environment,
            instanceId: this.instanceId,
            actorId
        });
        if (!event) return false;
        return this.queue.enqueue(event);
    }

    recordHttpFailure({ traceId, requestId, durationMs, method, route, statusCode }) {
        if (!this.enabled) return;
        const now = new Date().toISOString();
        this.queue.enqueue({
            schemaVersion: 1,
            eventId: randomUUID(),
            occurredAt: now,
            receivedAt: now,
            service: "backend",
            environment: this.environment,
            instanceId: this.instanceId,
            level: "ERROR",
            category: "http",
            eventName: "http.request.failed",
            traceId,
            requestId,
            durationMs,
            http: { method, route, statusCode }
        });
    }

    recordHttpMetric(durationMs, statusCode) {
        if (this.enabled) this.httpMetrics.record(durationMs, statusCode);
    }

    recordStorageRead({ eventName, actorId, traceId, requestId, durationMs, statusCode }) {
        if (!this.enabled) return;
        const routes = {
            "storage.workshop.viewed": "/api/workshop-storage",
            "storage.workshop.searched": "/api/workshop-storage/search",
            "storage.workshop.categories.viewed": "/api/workshop-storage/categories",
            "storage.boxes.viewed": "/api/storage-boxes",
            "storage.box.viewed": "/api/storage-boxes/:id",
            "storage.boxes.searched": "/api/storage-boxes/search",
            "storage.shelf_config.viewed": "/api/shelf-config"
        };
        if (!Object.hasOwn(routes, eventName) || typeof actorId !== "string" || !actorId ||
            typeof traceId !== "string" || !UUID.test(traceId) ||
            typeof requestId !== "string" || !UUID.test(requestId) ||
            typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0 ||
            !Number.isInteger(statusCode) || statusCode < 100 || statusCode > 599) {
            throw new Error("Evento de lectura de almacenamiento no válido.");
        }
        const now = new Date().toISOString();
        this.queue.enqueue({
            schemaVersion: 1,
            eventId: randomUUID(),
            occurredAt: now,
            receivedAt: now,
            service: "backend",
            environment: this.environment,
            instanceId: this.instanceId,
            level: statusCode >= 500 ? "ERROR" : statusCode >= 400 ? "WARN" : "INFO",
            category: "storage",
            eventName,
            actorId,
            traceId,
            requestId,
            durationMs,
            http: { method: "GET", route: routes[eventName], statusCode }
        });
    }

    recordToolOperation({ eventName, actorId, traceId, requestId, durationMs, statusCode }) {
        if (!this.enabled) return;
        const routes = {
            "tools.create.completed": ["POST", "/api/tools"],
            "tools.update.completed": ["PUT", "/api/tools/:id"],
            "tools.state.completed": ["PATCH", "/api/tools/:id/state"],
            "tools.image.upload.completed": ["POST", "/api/tools/:id/image"],
            "tools.image.delete.completed": ["DELETE", "/api/tools/:id/image"],
            "tools.delete.completed": ["DELETE", "/api/tools/:id"],
            "tools.repair.create.completed": ["POST", "/api/tools/:toolId/repairs"],
            "tools.repair.update.completed": ["PUT", "/api/tools/:toolId/repairs/:repairId"],
            "tools.repair.delete.completed": ["DELETE", "/api/tools/:toolId/repairs/:repairId"]
        };
        if (!Object.hasOwn(routes, eventName) || typeof actorId !== "string" || !actorId ||
            typeof traceId !== "string" || !UUID.test(traceId) ||
            typeof requestId !== "string" || !UUID.test(requestId) ||
            typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0 ||
            !Number.isInteger(statusCode) || statusCode < 100 || statusCode > 599) {
            throw new Error("Evento de operación de herramienta no válido.");
        }
        const now = new Date().toISOString();
        const [method, route] = routes[eventName];
        this.queue.enqueue({
            schemaVersion: 1, eventId: randomUUID(), occurredAt: now, receivedAt: now,
            service: "backend", environment: this.environment, instanceId: this.instanceId,
            level: statusCode >= 500 ? "ERROR" : statusCode >= 400 ? "WARN" : "INFO",
            category: "tools", eventName, actorId, traceId, requestId, durationMs,
            http: { method, route, statusCode }
        });
    }

    recordTaskOperation({ module, route, method, actorId, traceId, requestId, durationMs, statusCode }) {
        if (!this.enabled) return;
        if (!isTaskOperation(module, route, method) || typeof actorId !== "string" || !actorId ||
            typeof traceId !== "string" || !UUID.test(traceId) ||
            typeof requestId !== "string" || !UUID.test(requestId) ||
            typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0 ||
            !Number.isInteger(statusCode) || statusCode < 100 || statusCode > 599) {
            throw new Error("Evento de operación de tareas no válido.");
        }
        const now = new Date().toISOString();
        const prefix = module === "board" ? "/api/task-board" : "/api/todo-list";
        this.queue.enqueue({
            schemaVersion: 1, eventId: randomUUID(), occurredAt: now, receivedAt: now,
            service: "backend", environment: this.environment, instanceId: this.instanceId,
            level: statusCode >= 500 ? "ERROR" : statusCode >= 400 ? "WARN" : "INFO",
            category: module === "board" ? "task_board" : "todo",
            eventName: module === "board" ? "task_board.operation.completed" : "todo.operation.completed",
            actorId, traceId, requestId, durationMs,
            http: { method, route: route === "/" ? prefix : prefix + route, statusCode }
        });
    }

    recordAuthOperation({ operation, actorId, traceId, requestId, durationMs, statusCode }) {
        if (!this.enabled) return;
        const routes = { login: "/api/auth/login", logout: "/api/auth/logout" };
        this.assertOperation({ traceId, requestId, durationMs, statusCode });
        if (!Object.hasOwn(routes, operation) || (actorId !== undefined && (typeof actorId !== "string" || !actorId))) {
            throw new Error("Evento de autenticación no válido.");
        }
        const failed = statusCode >= 400;
        this.enqueueOperation({
            eventName: operation === "login" ? (failed ? "auth.login.failed" : "auth.login.succeeded")
                : (failed ? "auth.logout.failed" : "auth.logout.completed"),
            category: "auth", actorId, traceId, requestId, durationMs, method: "POST", route: routes[operation], statusCode
        });
    }

    recordAccessDenied({ actorId, traceId, requestId, durationMs, method, route, statusCode }) {
        if (!this.enabled) return false;
        this.assertOperation({ traceId, requestId, durationMs, statusCode });
        if (statusCode !== 401 && statusCode !== 403) throw new Error("Evento de acceso denegado no válido.");
        const minute = Math.floor(Date.now() / 60000);
        if (this.accessDeniedWindow.minute !== minute) this.accessDeniedWindow = { minute, count: 0 };
        if (this.accessDeniedWindow.count >= MAX_ACCESS_DENIED_PER_MINUTE) {
            this.accessDeniedSuppressed += 1;
            return false;
        }
        this.accessDeniedWindow.count += 1;
        this.enqueueOperation({
            eventName: "auth.access.denied", category: "auth", actorId, traceId, requestId, durationMs, method, route, statusCode
        });
        return true;
    }

    recordApiAction({ actorId, traceId, requestId, durationMs, method, route, statusCode }) {
        if (!this.enabled) return;
        this.assertOperation({ traceId, requestId, durationMs, statusCode });
        if (!ACTION_METHODS.has(method) || typeof route !== "string" || !route.startsWith("/api/") ||
            (actorId !== undefined && (typeof actorId !== "string" || !actorId))) {
            throw new Error("Evento de acción no válido.");
        }
        this.enqueueOperation({
            eventName: "api.action.completed", category: "action", actorId, traceId, requestId, durationMs,
            method, route, statusCode
        });
    }

    recordProcessFailure(kind, error) {
        if (!this.enabled) return false;
        if (kind !== "uncaughtException" && kind !== "unhandledRejection") {
            throw new Error("Fallo de proceso no válido.");
        }
        const name = typeof error?.name === "string" && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.name)
            ? error.name : "UnknownError";
        const now = new Date().toISOString();
        return this.queue.enqueue({
            schemaVersion: 1, eventId: randomUUID(), occurredAt: now, receivedAt: now,
            service: this.service, environment: this.environment, instanceId: this.instanceId,
            level: "ERROR", category: "system",
            eventName: kind === "uncaughtException" ? "process.uncaught_exception" : "process.unhandled_rejection",
            errorName: name
        });
    }

    assertOperation({ traceId, requestId, durationMs, statusCode }) {
        if (typeof traceId !== "string" || !UUID.test(traceId) ||
            typeof requestId !== "string" || !UUID.test(requestId) ||
            typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0 ||
            !Number.isInteger(statusCode) || statusCode < 100 || statusCode > 599) {
            throw new Error("Evento de operación no válido.");
        }
    }

    enqueueOperation({ eventName, category, actorId, traceId, requestId, durationMs, method, route, statusCode }) {
        const now = new Date().toISOString();
        return this.queue.enqueue({
            schemaVersion: 1, eventId: randomUUID(), occurredAt: now, receivedAt: now,
            service: "backend", environment: this.environment, instanceId: this.instanceId,
            level: statusCode >= 500 ? "ERROR" : statusCode >= 400 ? "WARN" : "INFO",
            category, eventName, ...(actorId ? { actorId } : {}), traceId, requestId, durationMs,
            http: { method, route, statusCode }
        });
    }

    recordWebSocketEvent(eventName, connectionId) {
        if (!this.enabled) return;
        const catalog = {
            "websocket.connection.opened": "INFO",
            "websocket.connection.closed": "INFO",
            "websocket.authentication.failed": "WARN",
            "websocket.document.load.failed": "ERROR",
            "websocket.document.store.failed": "ERROR"
        };
        if (!Object.hasOwn(catalog, eventName)) {
            throw new Error("Evento WebSocket no válido.");
        }
        const now = new Date().toISOString();
        this.queue.enqueue({
            schemaVersion: 1,
            eventId: randomUUID(),
            occurredAt: now,
            receivedAt: now,
            service: "websocket",
            environment: this.environment,
            instanceId: this.instanceId,
            level: catalog[eventName],
            category: "websocket",
            eventName,
            ...(connectionId ? { connectionId } : {})
        });
    }

    flush() {
        if (this.inFlight) return this.inFlight;
        if (Date.now() < this.nextRetryAt) return Promise.resolve();
        const events = this.queue.drain(this.batchSize);
        if (!events.length) return Promise.resolve();
        const startedAt = Date.now();
        this.inFlight = (async () => {
            try {
                await Promise.resolve().then(() => this.sink.writeEvents(events));
                this.lastSuccessfulFlushAt = new Date().toISOString();
                this.consecutiveWriteFailures = 0;
                this.nextRetryAt = 0;
            } catch (error) {
                this.consecutiveWriteFailures += 1;
                const delay = Math.min(this.retryBaseDelayMs * 2 ** Math.min(this.consecutiveWriteFailures - 1, 10), 60000);
                this.nextRetryAt = Date.now() + delay;
                for (const event of events) {
                    const attempts = (this.attempts.get(event) || 0) + 1;
                    if (attempts < this.maxAttempts) {
                        this.attempts.set(event, attempts);
                        this.queue.enqueue(event);
                    } else {
                        this.failedEvents += 1;
                    }
                }
                if (this.consecutiveWriteFailures === 1 || this.consecutiveWriteFailures % 60 === 0) {
                    console.error("No se pudo guardar la telemetría en Firestore.", error);
                }
            } finally {
                this.lastFlushDurationMs = Date.now() - startedAt;
                this.inFlight = null;
            }
        })();
        return this.inFlight;
    }

    async flushForShutdown(timeoutMs = 2000) {
        let timer;
        const timeout = new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); });
        try {
            await Promise.race([this.flush().catch(() => {}), timeout]);
        } finally {
            clearTimeout(timer);
        }
    }

    getHealth() {
        return {
            enabled: this.enabled,
            queuePending: this.queue.items.length,
            queueCapacity: this.queue.capacity,
            droppedByLevel: { ...this.queue.dropped },
            sampledOutByLevel: { ...this.queue.sampledOut },
            sampleRates: { ...this.queue.sampleRates },
            failedEvents: this.failedEvents,
            accessDeniedSuppressed: this.accessDeniedSuppressed,
            lastSuccessfulFlushAt: this.lastSuccessfulFlushAt,
            lastFlushDurationMs: this.lastFlushDurationMs,
            consecutiveWriteFailures: this.consecutiveWriteFailures,
            heartbeat: {
                consecutiveFailures: this.heartbeat.failures,
                lastSuccess: this.heartbeat.lastSuccess
            },
            httpMetrics: this.httpMetrics.getHealth(),
            ...(this.databaseMetrics ? { databaseMetrics: this.databaseMetrics.getHealth() } : {})
        };
    }
}

const telemetry = new TelemetryManager();
module.exports = { FirestoreTelemetrySink, FRONTEND_EVENTS, TelemetryManager, TelemetryQueue, normalizeFrontendEvent, telemetry };
