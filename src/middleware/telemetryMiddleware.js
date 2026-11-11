const { randomUUID } = require("node:crypto");
const { telemetry } = require("../telemetry/telemetry");

const TRACE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const API_ROOTS = new Set([
    "auth", "users", "admin", "tools", "technicians", "locations", "tool-types",
    "tags", "storage-boxes", "shelf-config", "workshop-storage", "task-board",
    "todo-list", "drawing"
]);
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

function normalizedRoute(req) {
    const root = /^\/api\/([^/?]+)/.exec(req.originalUrl)?.[1];
    if (!API_ROOTS.has(root)) return "<unmatched>";
    const path = req.route?.path;
    if (typeof path !== "string" || !/^\/(?:[a-zA-Z0-9_:-]+\/?)*$/.test(path)) {
        return `/api/${root}/<unmatched>`;
    }
    return `/api/${root}${path === "/" ? "" : path}`;
}

function createTelemetryMiddleware(manager = telemetry) {
    return (req, res, next) => {
        if (!manager.enabled || /^\/api\/(?:telemetry|monitoring)(?:\/|\?|$)/.test(req.originalUrl)) {
            return next();
        }
        const requestedTrace = req.get("x-trace-id");
        const traceId = typeof requestedTrace === "string" && TRACE_ID.test(requestedTrace)
            ? requestedTrace.toLowerCase() : randomUUID();
        const requestId = randomUUID();
        const startedAt = process.hrtime.bigint();
        res.setHeader("x-trace-id", traceId);
        res.setHeader("x-request-id", requestId);
        res.once("finish", () => {
            try {
                const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
                manager.recordHttpMetric(durationMs, res.statusCode);
                if (res.statusCode >= 500) {
                    manager.recordHttpFailure({
                        traceId,
                        requestId,
                        durationMs,
                        method: METHODS.has(req.method) ? req.method : "OTHER",
                        route: normalizedRoute(req),
                        statusCode: res.statusCode
                    });
                }
            } catch (error) {
                console.error("No se pudo registrar la telemetría HTTP.", error);
            }
        });
        return next();
    };
}

module.exports = { createTelemetryMiddleware, normalizedRoute };
