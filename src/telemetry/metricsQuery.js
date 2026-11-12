const { Timestamp } = require("firebase-admin/firestore");
const { HISTOGRAM_KEYS, INTERVAL_MS } = require("./httpMetrics");

const MAX_BUCKETS = 25000;

async function loadHttpMetrics(db, { now, durationMs, environment, resolutionMs, metricName = "http_requests" }) {
    const from = Math.ceil((now - durationMs) / INTERVAL_MS) * INTERVAL_MS;
    const to = Math.floor(now / INTERVAL_MS) * INTERVAL_MS;
    const snapshot = await db.collection("monitoringMetricBuckets")
        .where("environment", "==", environment)
        .where("service", "==", "backend")
        .where("metricName", "==", metricName)
        .where("intervalStart", ">=", Timestamp.fromMillis(from))
        .where("intervalStart", "<", Timestamp.fromMillis(to))
        .orderBy("intervalStart", "asc")
        .limit(MAX_BUCKETS + 1)
        .get();
    if (snapshot.docs.length > MAX_BUCKETS) {
        throw Object.assign(new Error("Hay demasiados intervalos de métricas para este periodo."), { statusCode: 503 });
    }

    const resolution = resolutionMs ?? (durationMs <= 3600000 ? INTERVAL_MS : 3600000);
    const groups = new Map();
    let totalCount = 0;
    let totalErrors = 0;
    let totalDuration = 0;
    const histogram = Object.fromEntries(HISTOGRAM_KEYS.map((key) => [key, 0]));
    for (const doc of snapshot.docs) {
        const bucket = doc.data();
        if (bucket.service !== "backend" || bucket.environment !== environment || bucket.metricName !== metricName) continue;
        if (!Number.isSafeInteger(bucket.count) || bucket.count <= 0 ||
            !Number.isSafeInteger(bucket.errors) || bucket.errors < 0 || bucket.errors > bucket.count ||
            typeof bucket.sum !== "number" || !Number.isFinite(bucket.sum) || bucket.sum < 0 ||
            !bucket.intervalStart || typeof bucket.intervalStart.toMillis !== "function" ||
            !bucket.histogram || HISTOGRAM_KEYS.some((key) =>
                !Number.isSafeInteger(bucket.histogram[key]) || bucket.histogram[key] < 0) ||
            HISTOGRAM_KEYS.reduce((sum, key) => sum + bucket.histogram[key], 0) !== bucket.count) {
            throw new Error("Un intervalo de métricas almacenado no es válido.");
        }
        const groupStart = Math.floor(bucket.intervalStart.toMillis() / resolution) * resolution;
        const group = groups.get(groupStart) || { start: groupStart, count: 0, errors: 0, sum: 0 };
        group.count += bucket.count;
        group.errors += bucket.errors;
        group.sum += bucket.sum;
        groups.set(groupStart, group);
        totalCount += bucket.count;
        totalErrors += bucket.errors;
        totalDuration += bucket.sum;
        for (const key of HISTOGRAM_KEYS) histogram[key] += bucket.histogram[key];
    }
    function percentileRange(percentile) {
        if (!totalCount) return null;
        const target = Math.ceil(totalCount * percentile);
        let accumulated = 0;
        for (const key of HISTOGRAM_KEYS) {
            accumulated += histogram[key];
            if (accumulated >= target) return key;
        }
        throw new Error("El histograma de métricas agregado no es válido.");
    }
    return {
        from: new Date(from).toISOString(),
        to: new Date(to).toISOString(),
        resolutionSeconds: resolution / 1000,
        count: totalCount,
        errors: totalErrors,
        averageMs: totalCount ? totalDuration / totalCount : null,
        p95Range: percentileRange(0.95),
        p99Range: percentileRange(0.99),
        points: [...groups.values()].sort((a, b) => a.start - b.start).map((group) => ({
            start: new Date(group.start).toISOString(),
            count: group.count,
            errors: group.errors,
            averageMs: group.sum / group.count
        }))
    };
}

async function loadWebSocketMetrics(db, { now, durationMs, environment, resolutionMs }) {
    const from = Math.ceil((now - durationMs) / INTERVAL_MS) * INTERVAL_MS;
    const to = Math.floor(now / INTERVAL_MS) * INTERVAL_MS;
    const snapshot = await db.collection("monitoringMetricBuckets")
        .where("environment", "==", environment)
        .where("service", "==", "websocket")
        .where("metricName", "==", "websocket_activity")
        .where("intervalStart", ">=", Timestamp.fromMillis(from))
        .where("intervalStart", "<", Timestamp.fromMillis(to))
        .orderBy("intervalStart", "asc")
        .limit(MAX_BUCKETS + 1)
        .get();
    if (snapshot.docs.length > MAX_BUCKETS) {
        throw Object.assign(new Error("Hay demasiados intervalos de métricas para este periodo."), { statusCode: 503 });
    }
    const resolution = resolutionMs ?? (durationMs <= 3600000 ? INTERVAL_MS : 3600000);
    const groups = new Map();
    for (const doc of snapshot.docs) {
        const bucket = doc.data();
        if (bucket.service !== "websocket" || bucket.environment !== environment ||
            bucket.metricName !== "websocket_activity") continue;
        if (!bucket.intervalStart || typeof bucket.intervalStart.toMillis !== "function" ||
            !Number.isFinite(bucket.intervalStart.toMillis()) ||
            WEBSOCKET_REQUIRED.some((key) => !Number.isSafeInteger(bucket[key]) || bucket[key] < 0) ||
            WEBSOCKET_OPTIONAL.some((key) => bucket[key] !== undefined &&
                (!Number.isSafeInteger(bucket[key]) || bucket[key] < 0))) {
            throw new Error("Un intervalo de métricas WebSocket almacenado no es válido.");
        }
        const start = Math.floor(bucket.intervalStart.toMillis() / resolution) * resolution;
        const group = groups.get(start) ||
            { start, opened: 0, closed: 0, updates: 0, awareness: 0, rejected: 0, abnormalClosed: 0 };
        for (const key of [...WEBSOCKET_REQUIRED, ...WEBSOCKET_OPTIONAL]) group[key] += bucket[key] ?? 0;
        groups.set(start, group);
    }
    return {
        from: new Date(from).toISOString(),
        to: new Date(to).toISOString(),
        resolutionSeconds: resolution / 1000,
        points: [...groups.values()].sort((a, b) => a.start - b.start).map((group) => ({
            ...group, start: new Date(group.start).toISOString()
        }))
    };
}

const WEBSOCKET_REQUIRED = ["opened", "closed", "updates"];
const WEBSOCKET_OPTIONAL = ["awareness", "rejected", "abnormalClosed"];

module.exports = { loadHttpMetrics, loadWebSocketMetrics, MAX_BUCKETS };
