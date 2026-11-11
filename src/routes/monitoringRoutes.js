const express = require("express");
const { randomUUID } = require("node:crypto");
const { getFirestore, Timestamp } = require("firebase-admin/firestore");
const { getAdminApp } = require("../config/firebaseAdmin");
const { requireAuthenticated, requirePermission } = require("../middleware/authMiddleware");
const { telemetry } = require("../telemetry/telemetry");
const { loadHttpMetrics, loadWebSocketMetrics } = require("../telemetry/metricsQuery");
const { loadHeartbeatSummary } = require("../telemetry/heartbeat");
const { findEvents, parseEventFilters, serializeEvent } = require("../telemetry/eventsQuery");
const { auditWorker } = require("../audit/outboxWorker");
const { activeUserWindowMinutes, countActiveUsers } = require("../telemetry/activeUsers");

function parseMetricsFilters(query) {
    const invalid = () => Object.assign(new Error("Los filtros de métricas no son válidos."), { statusCode: 400 });
    const allowed = ["from", "to", "service", "metric", "interval"];
    if (Object.keys(query).some((key) => !allowed.includes(key)) ||
        Object.values(query).some((value) => typeof value !== "string")) throw invalid();
    let range;
    try {
        range = parseEventFilters({ from: query.from, to: query.to });
    } catch (error) {
        if (error.statusCode !== 400) throw error;
        throw invalid();
    }
    if (range.to - range.from < 60000 ||
        !((query.service === "backend" && query.metric === "http_requests") ||
          (query.service === "websocket" && query.metric === "websocket_activity")) ||
        !["1m", "1h"].includes(query.interval)) throw invalid();
    return {
        now: range.to,
        durationMs: range.to - range.from,
        resolutionMs: query.interval === "1m" ? 60000 : 3600000,
        service: query.service,
        metric: query.metric
    };
}

function createMonitoringRouter(options = {}) {
    const router = express.Router();
    const manager = options.manager || telemetry;
    const getDatabase = options.getDatabase || (() => getFirestore(getAdminApp()));
    const auditPublisher = options.auditWorker || auditWorker;

    router.use(requireAuthenticated, requirePermission("monitoring:app"));
    router.get("/overview", async (req, res, next) => {
        const periods = { "1h": 3600000, "24h": 86400000, "7d": 604800000 };
        const period = req.query.period === undefined ? "1h" : req.query.period;
        if (typeof period !== "string" || !Object.hasOwn(periods, period) ||
            Object.keys(req.query).some((key) => key !== "period")) {
            return res.status(400).json({ message: "El intervalo de monitorización no es válido." });
        }
        if (!manager.enabled) {
            return res.status(503).json({ message: "La telemetría no está habilitada." });
        }
        try {
            const db = getDatabase();
            const now = new Date();
            await db.collection("auditEvents").doc(randomUUID()).create({
                schemaVersion: 1,
                action: "monitoring.dashboard.accessed",
                actorId: req.authUser.id,
                occurredAt: Timestamp.fromDate(now)
            });
            const snapshot = await db.collection("monitoringEvents")
                .where("environment", "==", manager.environment)
                .where("receivedAt", ">=", Timestamp.fromMillis(now.getTime() - periods[period]))
                .where("receivedAt", "<=", Timestamp.fromDate(now))
                .orderBy("receivedAt", "desc")
                .limit(25)
                .get();
            const events = snapshot.docs.map(serializeEvent);
            const httpMetrics = await loadHttpMetrics(db, {
                now: now.getTime(),
                durationMs: periods[period],
                environment: manager.environment
            });
            const webSocketMetrics = await loadWebSocketMetrics(db, {
                now: now.getTime(),
                durationMs: periods[period],
                environment: manager.environment
            });
            const heartbeats = await loadHeartbeatSummary(db, {
                now: now.getTime(),
                environment: manager.environment
            });
            let activeUsers = null;
            try {
                activeUsers = await countActiveUsers(db, manager.environment, now.getTime(), activeUserWindowMinutes());
            } catch (error) {
                console.error("No se pudo consultar el recuento de usuarios activos.", error);
            }
            res.set("Cache-Control", "no-store");
            return res.json({
                period,
                generatedAt: now.toISOString(),
                events,
                httpMetrics,
                webSocketMetrics,
                heartbeats,
                activeUsers,
                collector: manager.getHealth()
            });
        } catch (error) {
            return next(error);
        }
    });

    async function eventSearch(req, res, next, traceId) {
        try {
            if (traceId !== undefined && Object.hasOwn(req.query, "traceId")) {
                return res.status(400).json({ message: "Los filtros de eventos no son válidos." });
            }
            const filters = parseEventFilters(traceId === undefined ? req.query : { ...req.query, traceId });
            if (!manager.enabled) return res.status(503).json({ message: "La telemetría no está habilitada." });
            const db = getDatabase();
            await db.collection("auditEvents").doc(randomUUID()).create({
                schemaVersion: 1, action: traceId === undefined ? "monitoring.events.accessed" : "monitoring.trace.accessed",
                actorId: req.authUser.id, occurredAt: Timestamp.now()
            });
            const result = await findEvents(db, filters, manager.environment);
            res.set("Cache-Control", "no-store");
            return res.json(result);
        } catch (error) {
            return next(error);
        }
    }

    router.get("/events", (req, res, next) => eventSearch(req, res, next));
    router.get("/traces/:traceId", (req, res, next) => eventSearch(req, res, next, req.params.traceId));

    router.get("/metrics", async (req, res, next) => {
        try {
            const filters = parseMetricsFilters(req.query);
            if (!manager.enabled) return res.status(503).json({ message: "La telemetría no está habilitada." });
            const db = getDatabase();
            await db.collection("auditEvents").doc(randomUUID()).create({
                schemaVersion: 1, action: "monitoring.metrics.accessed",
                actorId: req.authUser.id, occurredAt: Timestamp.now()
            });
            const load = filters.service === "backend" ? loadHttpMetrics : loadWebSocketMetrics;
            const result = await load(db, { ...filters, environment: manager.environment });
            res.set("Cache-Control", "no-store");
            return res.json({ service: filters.service, metric: filters.metric, ...result });
        } catch (error) {
            return next(error);
        }
    });

    router.get("/services", async (req, res, next) => {
        if (Object.keys(req.query).length) {
            return res.status(400).json({ message: "Los filtros de servicios no son válidos." });
        }
        if (!manager.enabled) return res.status(503).json({ message: "La telemetría no está habilitada." });
        try {
            const db = getDatabase();
            const now = new Date();
            await db.collection("auditEvents").doc(randomUUID()).create({
                schemaVersion: 1, action: "monitoring.services.accessed",
                actorId: req.authUser.id, occurredAt: Timestamp.fromDate(now)
            });
            const heartbeats = await loadHeartbeatSummary(db, { now: now.getTime(), environment: manager.environment });
            res.set("Cache-Control", "no-store");
            return res.json({
                generatedAt: now.toISOString(),
                freshnessSeconds: heartbeats.freshnessSeconds,
                services: { ...heartbeats.services, frontend: null, storage: null },
                resources: heartbeats.resources
            });
        } catch (error) {
            return next(error);
        }
    });

    router.get("/audit-status", async (req, res, next) => {
        if (Object.keys(req.query).length) {
            return res.status(400).json({ message: "Los filtros de auditoría no son válidos." });
        }
        if (!manager.enabled) return res.status(503).json({ message: "La telemetría no está habilitada." });
        try {
            await getDatabase().collection("auditEvents").doc(randomUUID()).create({
                schemaVersion: 1, action: "monitoring.audit-status.accessed",
                actorId: req.authUser.id, occurredAt: Timestamp.now()
            });

            const pending = await auditPublisher.getPendingSummary();
            res.set("Cache-Control", "no-store");
            return res.json({
                checkedAt: new Date().toISOString(),
                pending,
                publisher: auditPublisher.getHealth()
            });
        } catch (error) {
            return next(error);
        }
    });

    router.get("/storage-history/:scope", async (req, res, next) => {
        const scope = req.params.scope;
        if (!["workshop", "boxes"].includes(scope) || Object.keys(req.query).length) {
            return res.status(400).json({ message: "La consulta de historial no es válida." });
        }
        try {
            const db = getDatabase();
            await db.collection("auditEvents").doc(randomUUID()).create({
                schemaVersion: 1, action: "monitoring.storage-history.accessed",
                actorId: req.authUser.id, occurredAt: Timestamp.now()
            });
            const snapshot = await db.collection("auditEvents")
                .where("auditScope", "==", scope).orderBy("occurredAt", "desc").limit(25).get();
            const events = snapshot.docs.map((doc) => {
                const event = doc.data();
                return { eventId: doc.id, action: event.action, actorId: event.actorId,
                    targetId: event.targetId, occurredAt: event.occurredAt,
                    ...(event.boxId ? { boxId: event.boxId } : {}),
                    ...(event.categoryId ? { categoryId: event.categoryId } : {}) };
            });
            res.set("Cache-Control", "no-store");
            return res.json({ events, limit: 25 });
        } catch (error) {
            return next(error);
        }
    });

    router.use((error, _req, res, next) => {
        const detail = typeof error.details === "string" ? error.details : "";
        const message = typeof error.message === "string" ? error.message : "";
        if ((error.code === 9 || error.code === "FAILED_PRECONDITION") &&
            /(?:requires an index|index.*(?:is not ready|is currently building))/i.test(`${detail} ${message}`)) {
            console.error("La consulta de monitorización necesita un índice de Firestore:", error);
            res.set("Cache-Control", "no-store");
            return res.status(503).json({
                code: "MONITORING_INDEX_UNAVAILABLE",
                message: "Faltan índices de Firestore o aún se están creando. Contacta con el administrador y vuelve a intentarlo cuando estén listos."
            });
        }
        return next(error);
    });

    return router;
}

const monitoringRouter = createMonitoringRouter();
module.exports = { createMonitoringRouter, monitoringRouter };
