const { FieldValue, Timestamp } = require("firebase-admin/firestore");
const { ResourceSampler, MAX_SAMPLE_AGE_MS } = require("./resourceSampler");

const HEARTBEAT_INTERVAL_MS = 30000;
const FRESHNESS_MS = 120000;
const RETENTION_MS = 2 * 86400000;
const MAX_INSTANCES = 500;
const METRIC_HEALTH_KEYS = ["pending", "activeIntervals", "dropped", "droppedSamples", "failed", "consecutiveFailures"];

class Heartbeat {
    constructor({ getDatabase, instanceId, service, environment, intervalMs = HEARTBEAT_INTERVAL_MS, resourceSampler }) {
        this.getDatabase = getDatabase;
        this.instanceId = instanceId;
        this.service = service;
        this.environment = environment;
        this.intervalMs = intervalMs;
        this.timer = null;
        this.inFlight = null;
        this.failures = 0;
        this.lastSuccess = null;
        this.webSocketStatsProvider = null;
        this.webSocketMetricHealthProvider = null;
        this.resourceSampler = resourceSampler || new ResourceSampler({ intervalMs });
    }

    setWebSocketMetricHealthProvider(provider) {
        if (this.service !== "websocket" || typeof provider !== "function") {
            throw new Error("Proveedor de salud WebSocket no válido.");
        }
        this.webSocketMetricHealthProvider = provider;
    }

    setWebSocketStatsProvider(provider) {
        if (this.service !== "websocket" || typeof provider !== "function") {
            throw new Error("Proveedor de métricas WebSocket no válido.");
        }
        this.webSocketStatsProvider = provider;
    }

    start() {
        if (this.timer) return;
        this.resourceSampler.start();
        void this.write();
        this.timer = setInterval(() => { void this.write(); }, this.intervalMs);
        this.timer.unref();
    }

    stop() {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        this.resourceSampler.stop();
    }

    write() {
        if (this.inFlight) return this.inFlight;
        this.inFlight = Promise.resolve().then(() => {
            const webSocketStats = this.webSocketStatsProvider?.();
            const webSocketMetricHealth = this.webSocketMetricHealthProvider?.();
            if (webSocketStats && ["activeConnections", "openedConnections", "closedConnections", "receivedUpdates"]
                .some((key) => !Number.isSafeInteger(webSocketStats[key]) || webSocketStats[key] < 0)) {
                throw new Error("Métricas WebSocket no válidas.");
            }
            if (webSocketMetricHealth && METRIC_HEALTH_KEYS.some((key) =>
                !Number.isSafeInteger(webSocketMetricHealth[key]) || webSocketMetricHealth[key] < 0)) {
                throw new Error("Salud de métricas WebSocket no válida.");
            }
            return this.getDatabase().collection("monitoringInstances").doc(this.instanceId).set({
                schemaVersion: 1,
                service: this.service,
                environment: this.environment,
                heartbeatAt: FieldValue.serverTimestamp(),
                expiresAt: Timestamp.fromMillis(Date.now() + RETENTION_MS),
                resources: this.resourceSampler.snapshot(),
                ...(webSocketStats ? { webSocketStats } : {}),
                ...(webSocketMetricHealth ? {
                    webSocketMetricHealth: Object.fromEntries(
                        METRIC_HEALTH_KEYS.map((key) => [key, webSocketMetricHealth[key]])
                    )
                } : {})
            });
        }).then(() => {
            this.failures = 0;
            this.lastSuccess = new Date().toISOString();
        }).catch((error) => {
            this.failures += 1;
            if (this.failures === 1 || this.failures % 60 === 0) {
                console.error("No se pudo guardar el heartbeat de monitorización.", error);
            }
        }).finally(() => { this.inFlight = null; });
        return this.inFlight;
    }
}

async function loadHeartbeatSummary(db, { now, environment }) {
    const snapshot = await db.collection("monitoringInstances")
        .where("environment", "==", environment)
        .where("heartbeatAt", ">=", Timestamp.fromMillis(now - RETENTION_MS))
        .where("heartbeatAt", "<=", Timestamp.fromMillis(now))
        .orderBy("heartbeatAt", "desc")
        .limit(MAX_INSTANCES + 1)
        .get();
    if (snapshot.docs.length > MAX_INSTANCES) {
        throw Object.assign(new Error("Hay demasiadas instancias para consultar los heartbeats."), { statusCode: 503 });
    }
    const services = {
        backend: { recentInstances: 0, lastHeartbeatAt: null },
        websocket: { recentInstances: 0, lastHeartbeatAt: null, activeConnections: null, metricHealth: null }
    };
    let knownConnections = 0;
    let missingConnections = 0;
    const metricHealth = Object.fromEntries(METRIC_HEALTH_KEYS.map((key) => [key, 0]));
    let missingMetricHealth = 0;
    const resources = { backend: [], websocket: [] };
    for (const doc of snapshot.docs) {
        const data = doc.data();
        if (data.environment !== environment || !Object.hasOwn(services, data.service)) continue;
        if (!data.heartbeatAt || typeof data.heartbeatAt.toMillis !== "function") {
            throw new Error("Heartbeat almacenado no válido.");
        }
        const time = data.heartbeatAt.toMillis();
        if (!Number.isFinite(time) || time > now) throw new Error("Heartbeat almacenado no válido.");
        const summary = services[data.service];
        if (!summary.lastHeartbeatAt || time > Date.parse(summary.lastHeartbeatAt)) {
            summary.lastHeartbeatAt = new Date(time).toISOString();
        }
        if (now - time <= FRESHNESS_MS) {
            summary.recentInstances += 1;
            if (typeof doc.id === "string" && doc.id) {
                const processSample = data.resources?.process;
                const diskSample = data.resources?.disk;
                const freshSample = (sample) => sample && Number.isSafeInteger(sample.sampledAt) &&
                    sample.sampledAt <= now && now - sample.sampledAt <= MAX_SAMPLE_AGE_MS;
                const validProcess = freshSample(processSample) &&
                    (processSample.cpuPercent === null ||
                        (typeof processSample.cpuPercent === "number" && Number.isFinite(processSample.cpuPercent) && processSample.cpuPercent >= 0)) &&
                    Number.isSafeInteger(processSample.rssBytes) && processSample.rssBytes >= 0;
                const validDisk = freshSample(diskSample) &&
                    Number.isSafeInteger(diskSample.totalBytes) && diskSample.totalBytes > 0 &&
                    Number.isSafeInteger(diskSample.usedBytes) && diskSample.usedBytes >= 0 &&
                    diskSample.usedBytes <= diskSample.totalBytes &&
                    Number.isSafeInteger(diskSample.availableBytes) && diskSample.availableBytes >= 0 &&
                    diskSample.availableBytes <= diskSample.totalBytes - diskSample.usedBytes;
                resources[data.service].push({
                    instanceId: doc.id,
                    heartbeatAt: new Date(time).toISOString(),
                    process: validProcess ? {
                        sampledAt: new Date(processSample.sampledAt).toISOString(),
                        cpuPercent: processSample.cpuPercent, rssBytes: processSample.rssBytes
                    } : null,
                    disk: validDisk ? {
                        sampledAt: new Date(diskSample.sampledAt).toISOString(),
                        totalBytes: diskSample.totalBytes, usedBytes: diskSample.usedBytes,
                        availableBytes: diskSample.availableBytes
                    } : null
                });
            }
            if (data.service === "websocket") {
                const active = data.webSocketStats?.activeConnections;
                if (Number.isSafeInteger(active) && active >= 0) knownConnections += active;
                else missingConnections += 1;
                const health = data.webSocketMetricHealth;
                if (!health || METRIC_HEALTH_KEYS.some((key) =>
                    !Number.isSafeInteger(health[key]) || health[key] < 0)) {
                    missingMetricHealth += 1;
                } else {
                    for (const key of METRIC_HEALTH_KEYS) metricHealth[key] += health[key];
                }
            }
        }
    }
    if (services.websocket.recentInstances && !missingConnections) {
        services.websocket.activeConnections = knownConnections;
    }
    if (services.websocket.recentInstances && !missingMetricHealth) {
        services.websocket.metricHealth = metricHealth;
    }
    return { freshnessSeconds: FRESHNESS_MS / 1000, services, resources };
}

module.exports = { Heartbeat, loadHeartbeatSummary, FRESHNESS_MS, RETENTION_MS, MAX_INSTANCES };
