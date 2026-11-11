const { randomUUID } = require("node:crypto");

function createCollaborationTelemetry(manager) {
    let activeConnections = 0;
    let openedConnections = 0;
    let closedConnections = 0;
    let receivedUpdates = 0;
    function record(eventName, connectionId) {
        if (!manager.enabled) return;
        try {
            manager.recordWebSocketEvent(eventName, connectionId);
        } catch (error) {
            console.error("No se pudo registrar la telemetría WebSocket.", error);
        }
    }

    function recordMetric(counter) {
        try {
            manager.webSocketMetrics?.record(counter);
        } catch (error) {
            console.error("No se pudo registrar la métrica WebSocket.", error);
        }
    }

    return {
        connected(connection) {
            if (!manager.enabled) return;
            try {
                const connectionId = randomUUID();
                let closed = false;
                connection.onClose(() => {
                    if (closed) return;
                    closed = true;
                    activeConnections -= 1;
                    closedConnections += 1;
                    recordMetric("closed");
                    record("websocket.connection.closed", connectionId);
                });
                activeConnections += 1;
                openedConnections += 1;
                recordMetric("opened");
                record("websocket.connection.opened", connectionId);
            } catch (error) {
                console.error("No se pudo registrar la conexión WebSocket.", error);
            }
        },
        authenticationFailed() {
            record("websocket.authentication.failed");
        },
        documentLoadFailed() {
            record("websocket.document.load.failed");
        },
        documentStoreFailed() {
            record("websocket.document.store.failed");
        },
        updateReceived() {
            if (manager.enabled) {
                receivedUpdates += 1;
                recordMetric("updates");
            }
        },
        getStats() {
            return { activeConnections, openedConnections, closedConnections, receivedUpdates };
        }
    };
}

module.exports = { createCollaborationTelemetry };
