const { Timestamp, FieldPath } = require("firebase-admin/firestore");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_RANGE_MS = 7 * 86400000;

function invalid() {
    return Object.assign(new Error("Los filtros de eventos no son válidos."), { statusCode: 400 });
}

function parseEventFilters(query, now = Date.now()) {
    const allowed = new Set(["from", "to", "service", "level", "eventName", "traceId", "cursor"]);
    if (Object.keys(query).some((key) => !allowed.has(key)) ||
        Object.values(query).some((value) => typeof value !== "string")) throw invalid();
    const from = Date.parse(query.from);
    const to = Date.parse(query.to);
    if (!query.from || !query.to || !Number.isFinite(from) || !Number.isFinite(to) ||
        new Date(from).toISOString() !== query.from || new Date(to).toISOString() !== query.to ||
        from >= to || to > now || to - from > MAX_RANGE_MS) throw invalid();
    if (query.service && !["frontend", "backend", "websocket"].includes(query.service)) throw invalid();
    if (query.level && !["DEBUG", "INFO", "WARN", "ERROR"].includes(query.level)) throw invalid();
    if (query.eventName && !/^[a-z][a-z0-9_.]{0,99}$/.test(query.eventName)) throw invalid();
    if (query.traceId && !UUID.test(query.traceId)) throw invalid();
    if (query.cursor && !UUID.test(query.cursor)) throw invalid();
    return { ...query, from, to, traceId: query.traceId?.toLowerCase() };
}

function serializeEvent(doc) {
    const data = doc.data();
    return {
        eventId: doc.id,
        receivedAt: data.receivedAt.toDate().toISOString(),
        service: data.service,
        level: data.level,
        eventName: data.eventName,
        ...(data.traceId ? { traceId: data.traceId } : {}),
        ...(data.connectionId ? { connectionId: data.connectionId } : {}),
        ...(data.http ? { http: data.http } : {}),
        ...(data.page ? { page: data.page } : {}),
        ...(typeof data.actorId === "string" && data.actorId ? { actorId: data.actorId } : {}),
        ...(typeof data.durationMs === "number" ? { durationMs: data.durationMs } : {})
    };
}

async function findEvents(db, filters, environment) {
    let query = db.collection("monitoringEvents")
        .where("environment", "==", environment)
        .where("receivedAt", ">=", Timestamp.fromMillis(filters.from))
        .where("receivedAt", "<=", Timestamp.fromMillis(filters.to));
    for (const key of ["service", "level", "eventName", "traceId"]) {
        if (filters[key]) query = query.where(key, "==", filters[key]);
    }
    query = query.orderBy("receivedAt", "desc").orderBy(FieldPath.documentId(), "desc");
    if (filters.cursor) {
        const cursor = await db.collection("monitoringEvents").doc(filters.cursor).get();
        if (!cursor.exists) throw invalid();
        const data = cursor.data();
        const received = data.receivedAt?.toMillis();
        if (data.environment !== environment || !Number.isFinite(received) ||
            received < filters.from || received > filters.to ||
            ["service", "level", "eventName", "traceId"].some((key) => filters[key] && data[key] !== filters[key])) {
            throw invalid();
        }
        query = query.startAfter(cursor);
    }
    const snapshot = await query.limit(26).get();
    const docs = snapshot.docs.slice(0, 25);
    return {
        events: docs.map(serializeEvent),
        nextCursor: snapshot.docs.length > 25 ? docs.at(-1).id : null
    };
}

module.exports = { findEvents, parseEventFilters, serializeEvent };
