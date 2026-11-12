const { telemetry } = require("./telemetry");

function installProcessFailureHandlers({
    manager = telemetry,
    processRef = process,
    logger = console,
    timeoutMs = 2000
} = {}) {
    let handling = false;
    const handle = (kind) => (error) => {
        logger.error(kind === "uncaughtException" ? "Excepción no controlada." : "Promesa rechazada sin controlar.", error);
        if (handling) return;
        handling = true;
        let recorded = Promise.resolve();
        try {
            if (manager.recordProcessFailure(kind, error)) recorded = manager.flushForShutdown(timeoutMs);
        } catch (recordError) {
            logger.error("No se pudo registrar el fallo del proceso.", recordError);
        }
        // Se conserva el comportamiento por defecto de Node: terminar con error.
        recorded.finally(() => processRef.exit(1));
    };
    const uncaught = handle("uncaughtException");
    const rejected = handle("unhandledRejection");
    processRef.on("uncaughtException", uncaught);
    processRef.on("unhandledRejection", rejected);
    return () => {
        processRef.off("uncaughtException", uncaught);
        processRef.off("unhandledRejection", rejected);
    };
}

module.exports = { installProcessFailureHandlers };
