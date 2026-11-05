const { createHash, randomBytes } = require("node:crypto");
const { getAdminDatabase } = require("../config/firebaseAdmin");
const { getDocumentAccess } = require("./drawingAccessService");
const { validateShareTokenHash, hashToken } = require("./drawingShareLinkService");
const { getProfile } = require("./userService");
const { consumeDrawingRateLimit } = require("./drawingRateLimitService");

const SESSION_TTL_MS = 5 * 60 * 1000;

function drawingRef(path = "") {
    const root = getAdminDatabase().ref("drawing");
    return path ? root.child(path) : root;
}

function collaborationError(message, statusCode = 403) {
    return Object.assign(new Error(message), { statusCode });
}

function parseRoomName(value) {
    if (typeof value !== "string") return null;
    const match = /^drawing:([0-9a-f-]{36}):([0-9a-f-]{36})$/i.exec(value);
    return match ? { documentId: match[1], pageId: match[2] } : null;
}

async function createCollaborationSession(documentId, pageId, userId, shareToken) {
    await consumeDrawingRateLimit(userId, "collaborationSession", 120);
    const access = await getDocumentAccess(documentId, userId, shareToken);
    if (!access) return null;
    const pageSnapshot = await drawingRef(`pages/${pageId}`).get();
    const page = pageSnapshot.val();
    if (!page || page.deletedAt || page.documentId !== documentId) return null;
    const profile = await getProfile(userId);
    if (!profile || !profile.isActive) return null;
    const token = randomBytes(32).toString("base64url");
    const tokenHash = hashToken(token);
    const now = Date.now();
    const shareLinkTokenHash = access.viaShareLink ? hashToken(shareToken) : null;
    await drawingRef(`collaborationSessions/${tokenHash}`).set({
        documentId,
        pageId,
        userId,
        role: access.role,
        shareLinkTokenHash,
        sessionVersion: profile.sessionVersion,
        createdAt: now,
        expiresAt: now + SESSION_TTL_MS
    });
    return {
        token,
        expiresAt: now + SESSION_TTL_MS,
        roomName: `drawing:${documentId}:${pageId}`,
        role: access.role
    };
}

async function verifyCollaborationSession(token, roomName) {
    const room = parseRoomName(roomName);
    if (!room || typeof token !== "string" || token.length < 40 || token.length > 128) return null;
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const sessionRef = drawingRef(`collaborationSessions/${tokenHash}`);
    const sessionSnapshot = await sessionRef.get();
    const session = sessionSnapshot.val();
    if (!session || session.documentId !== room.documentId || session.pageId !== room.pageId ||
        !Number.isFinite(session.expiresAt)) return null;
    if (session.expiresAt <= Date.now()) {
        await sessionRef.remove();
        return null;
    }
    return revalidateCollaborationContext({
        documentId: room.documentId,
        pageId: room.pageId,
        userId: session.userId,
        shareLinkTokenHash: session.shareLinkTokenHash,
        sessionVersion: session.sessionVersion,
        tokenHash
    });
}

async function revalidateCollaborationContext(context) {
    const profile = await getProfile(context.userId);
    if (!profile || !profile.isActive || profile.sessionVersion !== context.sessionVersion) return null;
    if (context.shareLinkTokenHash) {
        const documentSnapshot = await drawingRef(`documents/${context.documentId}`).get();
        const document = documentSnapshot.val();
        if (!document || document.deletedAt || document.isArchived ||
            !await validateShareTokenHash(context.documentId, context.shareLinkTokenHash)) return null;
        return {
            ...context,
            role: "Viewer",
            displayName: `${profile.firstName} ${profile.lastName}`.trim(),
            profileImage: profile.profileImage
        };
    }

    const access = await getDocumentAccess(context.documentId, context.userId);
    if (!access) return null;
    return {
        ...context,
        role: access.role,
        displayName: `${profile.firstName} ${profile.lastName}`.trim(),
        profileImage: profile.profileImage
    };
}

module.exports = {
    SESSION_TTL_MS,
    createCollaborationSession,
    parseRoomName,
    revalidateCollaborationContext,
    verifyCollaborationSession
};
