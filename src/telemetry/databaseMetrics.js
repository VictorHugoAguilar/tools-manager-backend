const { HttpMetrics } = require("./httpMetrics");

class DatabaseMetrics extends HttpMetrics {
    documentId(bucket) {
        return `database_${this.instanceId}_${bucket.start}`;
    }

    recordOperation(durationMs, failed, now = Date.now()) {
        this.record(durationMs, failed ? 500 : 200, now);
    }

    createDocument(bucket) {
        return { ...super.createDocument(bucket), metricName: "database_operations" };
    }
}

module.exports = { DatabaseMetrics };
