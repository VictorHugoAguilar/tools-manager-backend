const { randomUUID } = require("node:crypto");

const NORMAL_CLOSE_CODES = new Set([1000, 1001]);

function createCollaborationTelemetry(manager) {
    let activeConnections = 0;
    let openedConnections = 0;
    let closedConnections = 0;
    let receivedUpdates = 0;
    let receivedAwareness = 0;
    let rejectedMessages = 0;
    let abnormalClosures = 0;
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
                connection.onClose((_document, event) => {
                    if (closed) return;
                    closed = true;
                    activeConnections -= 1;
                    closedConnections += 1;
                    recordMetric("closed");
                    // Solo se usa el código numérico; el motivo textual puede contener datos del cliente.
                    if (Number.isInteger(event?.code) && !NORMAL_CLOSE_CODES.has(event.code)) {
                        abnormalClosures += 1;
                        recordMetric("abnormalClosed");
                    }
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
        awarenessReceived() {
            if (manager.enabled) {
                receivedAwareness += 1;
                recordMetric("awareness");
            }
        },
        messageRejected() {
            if (manager.enabled) {
                rejectedMessages += 1;
                recordMetric("rejected");
            }
        },
        getStats() {
            return {
                activeConnections, openedConnections, closedConnections, receivedUpdates,
                receivedAwareness, rejectedMessages, abnormalClosures
            };
        }
    };
}

module.exports = { createCollaborationTelemetry };
