const { createHash, randomBytes } = require("node:crypto");
const { getAdminDatabase } = require("../config/firebaseAdmin");
const { getProfileWithPermissions } = require("./userService");
const { transactAdminUser } = require("../audit/businessOutbox");
const { CacheService } = require("../cache/cacheService");
const { cacheConfig } = require("../cache/sharedCache");

const SESSION_TTL_MS = 5 * 24 * 60 * 60 * 1000;
const AUTH_CACHE_TTL_MS = 30000;
const AUTH_CACHE_MAX_ENTRIES = 500;
const sessionCache = new CacheService({ enabled: cacheConfig.enabled, maxEntries: AUTH_CACHE_MAX_ENTRIES });
const sessionLoads = new Map();

function hashToken(token) {
    return createHash("sha256").update(token).digest("hex");
}

function getSessionsRef() {
    return getAdminDatabase().ref("authSessions");
}

function getPasswordResetsRef() {
    return getAdminDatabase().ref("authPasswordResets");
}

async function createSession(uid) {
    const profile = await getProfileWithPermissions(uid);
    if (!profile || !profile.isActive) {
        throw Object.assign(new Error("La cuenta está inactiva o no tiene un perfil válido."), {
            statusCode: 403
        });
    }

    const token = randomBytes(32).toString("base64url");
    const tokenHash = hashToken(token);
    const expiresAt = Date.now() + SESSION_TTL_MS;
    await getSessionsRef().child(tokenHash).set({
        uid,
        sessionVersion: profile.sessionVersion,
        expiresAt
    });
    return { token, tokenHash, expiresAt };
}

async function loadSession(tokenHash) {
    const ref = getSessionsRef().child(tokenHash);
    const snapshot = await ref.get();
    const session = snapshot.val();
    if (!session) return null;
    if (!Number.isFinite(session.expiresAt) || session.expiresAt <= Date.now()) {
        await ref.remove();
        return null;
    }

    const profile = await getProfileWithPermissions(session.uid);
    if (!profile || !profile.isActive || profile.sessionVersion !== session.sessionVersion) {
        await ref.remove();
        return null;
    }
    if (session.expiresAt <= Date.now()) return null;
    return { profile, tokenHash, expiresAt: session.expiresAt };
}

async function resolveSession(token) {
    const tokenHash = hashToken(token);
    let result = sessionCache.get(tokenHash);
    if (!result) {
        let load = sessionLoads.get(tokenHash);
        if (!load) {
            const startedAt = Date.now();
            const tracked = sessionCache.enabled && sessionLoads.size < AUTH_CACHE_MAX_ENTRIES;
            load = {};
            if (tracked) sessionLoads.set(tokenHash, load);
            load.promise = loadSession(tokenHash).then((session) => {
                if (session && tracked && sessionLoads.get(tokenHash) === load) {
                    const ttl = Math.min(startedAt + AUTH_CACHE_TTL_MS, session.expiresAt) - Date.now();
                    if (ttl > 0) sessionCache.set(tokenHash, session, ttl);
                }
                return session;
            }).finally(() => {
                if (sessionLoads.get(tokenHash) === load) sessionLoads.delete(tokenHash);
            });
        }
        result = await load.promise;
    }
    if (!result || result.expiresAt <= Date.now()) return null;
    return { profile: structuredClone(result.profile), tokenHash: result.tokenHash };
}

async function deleteSession(tokenHash) {
    sessionCache.invalidate(tokenHash);
    sessionLoads.delete(tokenHash);
    try {
        await getSessionsRef().child(tokenHash).remove();
    } finally {
        sessionCache.invalidate(tokenHash);
        sessionLoads.delete(tokenHash);
    }
}

function clearAuthenticationCache() {
    sessionCache.clear();
    sessionLoads.clear();
}

async function storePasswordReset(token, uid, expiresAt, sessionVersion) {
    await getPasswordResetsRef().child(hashToken(token)).set({ uid, expiresAt, sessionVersion });
}

async function consumePasswordReset(token) {
    const ref = getPasswordResetsRef().child(hashToken(token));
    let consumed;
    const result = await ref.transaction((current) => {
        consumed = undefined;
        if (!current || !Number.isFinite(current.expiresAt) || current.expiresAt <= Date.now()) return;
        if (typeof current.uid === "string" && current.uid) consumed = current;
        return null;
    });
    return result.committed ? consumed : null;
}

async function completeAuditedPasswordReset(token, passwordHash) {
    const tokenHash = hashToken(token);
    const snapshot = await getPasswordResetsRef().child(tokenHash).get();
    const reset = snapshot.val();
    if (!reset || typeof reset.uid !== "string" || !reset.uid ||
        !Number.isFinite(reset.expiresAt) || reset.expiresAt <= Date.now()) return null;
    return transactAdminUser({
        id: reset.uid, actorId: reset.uid, action: "user.password.recovered",
        change: (current, _profiles, root) => {
            const latest = root.authPasswordResets?.[tokenHash];
            if (!latest || latest.uid !== reset.uid ||
                !Number.isFinite(latest.expiresAt) || latest.expiresAt <= Date.now() ||
                !current || latest.sessionVersion === undefined ||
                (Number(current.sessionVersion) || 0) !== latest.sessionVersion) return null;
            const updated = {
                ...current, passwordHash,
                sessionVersion: (Number(current.sessionVersion) || 0) + 1,
                updatedAt: new Date().toISOString()
            };
            delete root.authPasswordResets[tokenHash];
            return { value: updated, result: true };
        }
    });
}

module.exports = {
    SESSION_TTL_MS,
    clearAuthenticationCache,
    createSession,
    deleteSession,
    consumePasswordReset,
    completeAuditedPasswordReset,
    resolveSession,
    storePasswordReset
};
