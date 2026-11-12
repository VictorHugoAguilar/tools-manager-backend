const { telemetry } = require("../telemetry/telemetry");

function authOperationTelemetry(operation, manager = telemetry) {
    return (req, res, next) => {
        if (!manager.enabled) return next();
        const start = process.hrtime.bigint();
        res.once("finish", () => {
            try {
                manager.recordAuthOperation({
                    operation,
                    actorId: res.locals.telemetryActorId || req.authUser?.id,
                    traceId: res.getHeader("x-trace-id"), requestId: res.getHeader("x-request-id"),
                    durationMs: Number(process.hrtime.bigint() - start) / 1e6,
                    statusCode: res.statusCode
                });
            } catch (error) {
                console.error("No se pudo registrar la telemetría de autenticación.", error);
            }
        });
        return next();
    };
}

module.exports = { authOperationTelemetry };
