const { createHash, randomBytes } = require("node:crypto");
const { getAdminDatabase } = require("../config/firebaseAdmin");
const { getProfileWithPermissions } = require("./userService");

const SESSION_TTL_MS = 5 * 24 * 60 * 60 * 1000;

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

async function resolveSession(token) {
    const tokenHash = hashToken(token);
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
    return { profile, tokenHash };
}

async function deleteSession(tokenHash) {
    await getSessionsRef().child(tokenHash).remove();
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

module.exports = {
    SESSION_TTL_MS,
    createSession,
    deleteSession,
    consumePasswordReset,
    resolveSession,
    storePasswordReset
};
