const { telemetry } = require("../telemetry/telemetry");
const { isWorkshopOperation } = require("../telemetry/workshopOperations");

function workshopOperationTelemetry(manager = telemetry) {
    return (req, res, next) => {
        if (!manager.enabled) return next();
        const start = process.hrtime.bigint();
        res.once("finish", () => {
            const route = req.route?.path;
            if (typeof route !== "string" || !isWorkshopOperation(route, req.method)) return;
            try {
                manager.recordWorkshopOperation({
                    route, method: req.method, actorId: req.authUser?.id,
                    traceId: res.getHeader("x-trace-id"), requestId: res.getHeader("x-request-id"),
                    durationMs: Number(process.hrtime.bigint() - start) / 1e6,
                    statusCode: res.statusCode
                });
            } catch (error) {
                console.error("No se pudo registrar la telemetría del almacenamiento del taller.", error);
            }
        });
        return next();
    };
}

module.exports = { workshopOperationTelemetry };
