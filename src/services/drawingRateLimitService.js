const { getAdminDatabase } = require("../config/firebaseAdmin");

function rateLimitError(message) {
    return Object.assign(new Error(message), { statusCode: 429 });
}

async function consumeDrawingRateLimit(userId, action, limit, windowMs = 60_000) {
    const ref = getAdminDatabase().ref(`drawing/rateLimits/${userId}/${action}`);
    const now = Date.now();
    let exceeded = false;
    const result = await ref.transaction((current) => {
        exceeded = false;
        const windowStartedAt = Number(current?.windowStartedAt) || 0;
        const count = Number(current?.count) || 0;
        if (!windowStartedAt || now - windowStartedAt >= windowMs) {
            return { windowStartedAt: now, count: 1 };
        }
        if (count >= limit) {
            exceeded = true;
            return;
        }
        return { windowStartedAt, count: count + 1 };
    });
    if (exceeded || !result.committed) throw rateLimitError("Has alcanzado el límite de solicitudes. Inténtalo más tarde.");
}

module.exports = { consumeDrawingRateLimit };
