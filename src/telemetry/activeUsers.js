const { createHash } = require("node:crypto");
const { FieldValue, Timestamp } = require("firebase-admin/firestore");

const RETENTION_MS = 2 * 86400000;

function activeUserWindowMinutes(value = process.env.MONITORING_ACTIVE_USERS_WINDOW_MINUTES) {
    if (value === undefined || value === "") return 5;
    if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 1440) {
        throw new Error("MONITORING_ACTIVE_USERS_WINDOW_MINUTES debe ser un entero entre 1 y 1440.");
    }
    return Number(value);
}

async function recordInteraction(db, environment, userId) {
    const id = createHash("sha256").update(JSON.stringify([environment, userId])).digest("hex");
    await db.collection("monitoringActiveUsers").doc(id).set({
        environment,
        lastInteractionAt: FieldValue.serverTimestamp(),
        expiresAt: Timestamp.fromMillis(Date.now() + RETENTION_MS)
    });
}

async function countActiveUsers(db, environment, now, windowMinutes) {
    const result = await db.collection("monitoringActiveUsers")
        .where("environment", "==", environment)
        .where("lastInteractionAt", ">=", Timestamp.fromMillis(now - windowMinutes * 60000))
        .where("lastInteractionAt", "<=", Timestamp.fromMillis(now))
        .count().get();
    const count = result.data().count;
    if (!Number.isSafeInteger(count) || count < 0) throw new Error("Recuento de usuarios activos no válido.");
    return { count, windowMinutes, checkedAt: new Date(now).toISOString() };
}

module.exports = { activeUserWindowMinutes, recordInteraction, countActiveUsers };
