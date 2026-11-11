const { Timestamp } = require("firebase-admin/firestore");

const INTERVAL_MS = 60000;
const LIMITS = [50, 100, 250, 500, 1000, 3000];
const HISTOGRAM_KEYS = ["0-50", "50-100", "100-250", "250-500", "500-1000", "1000-3000", "3000+"];

class HttpMetrics {
    constructor({ instanceId, environment, getDatabase, capacity = 120, maxAttempts = 3, retryBaseDelayMs = 1000 }) {
        this.instanceId = instanceId;
        this.environment = environment;
        this.getDatabase = getDatabase;
        this.capacity = capacity;
        this.maxAttempts = maxAttempts;
        this.retryBaseDelayMs = retryBaseDelayMs;
        this.buckets = new Map();
        this.pending = [];
        this.closedBefore = -Infinity;
        this.inFlight = null;
        this.nextRetryAt = 0;
        this.dropped = 0;
        this.droppedSamples = 0;
        this.failed = 0;
        this.consecutiveFailures = 0;
    }

    record(durationMs, statusCode, now = Date.now()) {
        if (!Number.isFinite(durationMs) || durationMs < 0 ||
            !Number.isInteger(statusCode) || statusCode < 100 || statusCode > 599) {
            throw new Error("Métrica HTTP no válida.");
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
            bucket = {
                start, count: 0, errors: 0, sum: 0, min: durationMs, max: durationMs,
                histogram: Object.fromEntries(HISTOGRAM_KEYS.map((key) => [key, 0]))
            };
            this.buckets.set(start, bucket);
        }
        bucket.count += 1;
        if (statusCode >= 500) bucket.errors += 1;
        bucket.sum += durationMs;
        bucket.min = Math.min(bucket.min, durationMs);
        bucket.max = Math.max(bucket.max, durationMs);
        const index = LIMITS.findIndex((limit) => durationMs < limit);
        bucket.histogram[HISTOGRAM_KEYS[index < 0 ? LIMITS.length : index]] += 1;
    }

    rotate(now = Date.now()) {
        const currentStart = Math.floor(now / INTERVAL_MS) * INTERVAL_MS;
        this.closedBefore = Math.max(this.closedBefore, currentStart);
        for (const [start, bucket] of this.buckets) {
            if (start >= currentStart) continue;
            this.buckets.delete(start);
            if (this.pending.length >= this.capacity) {
                this.dropped += 1;
                continue;
            }
            this.pending.push({ bucket, attempts: 0 });
        }
    }

    createDocument(bucket) {
        return {
            schemaVersion: 1, intervalStart: Timestamp.fromMillis(bucket.start), intervalSeconds: 60,
            service: "backend", environment: this.environment, instanceId: this.instanceId,
            metricName: "http_requests", count: bucket.count, errors: bucket.errors,
            sum: bucket.sum, min: bucket.min, max: bucket.max, histogram: bucket.histogram,
            expiresAt: Timestamp.fromMillis(bucket.start + 90 * 86400000)
        };
    }

    documentId(bucket) {
        return `${this.instanceId}_${bucket.start}`;
    }

    flush(now = Date.now()) {
        this.rotate(now);
        if (this.inFlight) return this.inFlight;
        if (!this.pending.length || now < this.nextRetryAt) return Promise.resolve();
        const item = this.pending.shift();
        const { bucket } = item;
        this.inFlight = Promise.resolve().then(async () => {
            const document = this.createDocument(bucket);
            try {
                await this.getDatabase().collection("monitoringMetricBuckets")
                    .doc(this.documentId(bucket)).create(document);
            } catch (error) {
                if (error.code !== 6 && error.code !== "already-exists") throw error;
            }
            this.consecutiveFailures = 0;
            this.nextRetryAt = 0;
        }).catch((error) => {
            this.consecutiveFailures += 1;
            item.attempts += 1;
            if (item.attempts < this.maxAttempts && this.pending.length < this.capacity) {
                this.pending.unshift(item);
            } else {
                this.failed += 1;
            }
            this.nextRetryAt = Date.now() + Math.min(this.retryBaseDelayMs * 2 ** Math.min(this.consecutiveFailures - 1, 10), 60000);
            if (this.consecutiveFailures === 1 || this.consecutiveFailures % 60 === 0) {
                console.error("No se pudieron guardar las métricas en Firestore.", error);
            }
        }).finally(() => { this.inFlight = null; });
        return this.inFlight;
    }

    getHealth() {
        return {
            pending: this.pending.length,
            activeIntervals: this.buckets.size,
            dropped: this.dropped,
            droppedSamples: this.droppedSamples,
            failed: this.failed,
            consecutiveFailures: this.consecutiveFailures
        };
    }
}

module.exports = { HttpMetrics, HISTOGRAM_KEYS, INTERVAL_MS };
