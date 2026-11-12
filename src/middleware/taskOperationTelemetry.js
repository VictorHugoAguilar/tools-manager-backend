const { telemetry } = require("../telemetry/telemetry");
const { isTaskOperation } = require("../telemetry/taskOperations");

function taskOperationTelemetry(module, manager = telemetry) {
    return (req, res, next) => {
        if (!manager.enabled) return next();
        const start = process.hrtime.bigint();
        res.once("finish", () => {
            const route = req.route?.path;
            if (typeof route !== "string" || !isTaskOperation(module, route, req.method)) return;
            try {
                manager.recordTaskOperation({
                    module, route, method: req.method, actorId: req.authUser?.id,
                    traceId: res.getHeader("x-trace-id"), requestId: res.getHeader("x-request-id"),
                    durationMs: Number(process.hrtime.bigint() - start) / 1e6,
                    statusCode: res.statusCode
                });
            } catch (error) {
                console.error("No se pudo registrar la telemetría de tareas.", error);
            }
        });
        return next();
    };
}

module.exports = { taskOperationTelemetry };
