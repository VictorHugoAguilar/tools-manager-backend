const express = require("express");
const { requireAuthenticated, requireCsrf, requirePermission } = require("../middleware/authMiddleware");
const { telemetry } = require("../telemetry/telemetry");
const { getFirestore } = require("firebase-admin/firestore");
const { getAdminApp } = require("../config/firebaseAdmin");
const { recordInteraction } = require("../telemetry/activeUsers");

const WINDOW_MS = 60_000;

function createRateLimit() {
    const requests = new Map();
    return (req, res, next) => {
        const now = Date.now();
        for (const [userId, value] of requests) {
            if (value.resetAt <= now) requests.delete(userId);
        }
        let value = requests.get(req.authUser.id);
        if (!value) {
            if (requests.size >= 10000) {
                return res.status(429).json({ message: "Demasiadas solicitudes de telemetría." });
            }
            value = { count: 0, resetAt: now + WINDOW_MS };
            requests.set(req.authUser.id, value);
        }
        value.count += 1;
        if (value.count > 30) return res.status(429).json({ message: "Demasiadas solicitudes de telemetría." });
        return next();
    };
}

function createTelemetryRouter({ manager = telemetry, getDatabase = () => getFirestore(getAdminApp()) } = {}) {
    const telemetryRouter = express.Router();
    telemetryRouter.post(
        "/events", requireAuthenticated, requirePermission("app:access"), requireCsrf, createRateLimit(),
        express.json({ limit: "64kb" }),
        (req, res) => {
            if (!manager.enabled) {
                return res.status(503).json({ message: "La telemetría no está habilitada." });
            }
            if (!req.body || req.body.schemaVersion !== 1 || !Array.isArray(req.body.events) ||
                req.body.events.length < 1 || req.body.events.length > 50 ||
                Object.keys(req.body).some((key) => key !== "schemaVersion" && key !== "events")) {
                return res.status(400).json({ message: "El lote de telemetría no es válido." });
            }
            let accepted = 0;
            for (const event of req.body.events) {
                if (manager.enqueueFrontend(event, req.authUser.id)) accepted += 1;
            }
            return res.status(202).json({ accepted, rejected: req.body.events.length - accepted });
        }
    );

    telemetryRouter.post(
        "/interaction", requireAuthenticated, requirePermission("app:access"), requireCsrf, createRateLimit(),
        async (req, res, next) => {
            if (!manager.enabled) return res.status(503).json({ message: "La telemetría no está habilitada." });
            try {
                await recordInteraction(getDatabase(), manager.environment, req.authUser.id);
                res.set("Cache-Control", "no-store");
                return res.status(204).end();
            } catch (error) {
                return next(error);
            }
        }
    );

    return telemetryRouter;
}

const telemetryRouter = createTelemetryRouter();
module.exports = { telemetryRouter, createTelemetryRouter };
