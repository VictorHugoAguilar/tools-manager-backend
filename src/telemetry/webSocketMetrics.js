const { Timestamp } = require("firebase-admin/firestore");
const { HttpMetrics, INTERVAL_MS } = require("./httpMetrics");

const COUNTERS = ["opened", "closed", "updates"];

class WebSocketMetrics extends HttpMetrics {
    documentId(bucket) {
        return `websocket_${this.instanceId}_${bucket.start}`;
    }

    record(counter, now = Date.now()) {
        if (!COUNTERS.includes(counter) || !Number.isFinite(now)) {
            throw new Error("Métrica WebSocket no válida.");
        }
        const start = Math.floor(now / INTERVAL_MS) * INTERVAL_MS;
        if (start < this.closedBefore) {
            this.droppedSamples += 1;
            return;
        }
        let bucket = this.buckets.get(start);
        if (!bucket) {
            if (this.buckets.size >= this.capacity) {
                this.droppedSamples += 1;
                return;
            }
            bucket = { start, opened: 0, closed: 0, updates: 0 };
            this.buckets.set(start, bucket);
        }
        bucket[counter] += 1;
    }

    createDocument(bucket) {
        return {
            schemaVersion: 1, intervalStart: Timestamp.fromMillis(bucket.start), intervalSeconds: 60,
            service: "websocket", environment: this.environment, instanceId: this.instanceId,
            metricName: "websocket_activity",
            opened: bucket.opened, closed: bucket.closed, updates: bucket.updates,
            expiresAt: Timestamp.fromMillis(bucket.start + 90 * 86400000)
        };
    }
}

module.exports = { WebSocketMetrics, COUNTERS };
