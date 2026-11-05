const { createHash, randomBytes, randomUUID } = require("node:crypto");
const { getAdminDatabase } = require("../config/firebaseAdmin");
const { requireDocumentAccess } = require("./drawingAccessService");
const { consumeDrawingRateLimit } = require("./drawingRateLimitService");

function drawingRef(path = "") {
    const root = getAdminDatabase().ref("drawing");
    return path ? root.child(path) : root;
}

function shareError(message, statusCode = 400) {
    return Object.assign(new Error(message), { statusCode });
}

function hashToken(token) {
    return createHash("sha256").update(token).digest("hex");
}

async function getShareLink(documentId, userId) {
    const access = await requireDocumentAccess(documentId, userId, "Owner");
    if (!access) return null;
    const snapshot = await drawingRef(`shareLinks/${documentId}`).get();
    const link = snapshot.val();
    if (!link || !link.isActive || (link.expiresAt && link.expiresAt <= Date.now())) {
        return { isActive: false, expiresAt: link?.expiresAt ?? null };
    }
    return {
        id: link.id,
        documentId,
        permission: "Viewer",
        isActive: true,
        createdAt: link.createdAt,
        expiresAt: link.expiresAt ?? null
    };
}

async function createShareLink(documentId, userId, expiresAtInput) {
    const access = await requireDocumentAccess(documentId, userId, "Owner");
    if (!access) return null;
    await consumeDrawingRateLimit(userId, "createShareLink", 10);
    let expiresAt = null;
    if (expiresAtInput !== undefined && expiresAtInput !== null && expiresAtInput !== "") {
        expiresAt = typeof expiresAtInput === "number"
            ? expiresAtInput
            : Date.parse(expiresAtInput);
        if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() ||
            expiresAt > Date.now() + 90 * 24 * 60 * 60 * 1000) {
            throw shareError("La fecha de caducidad debe estar dentro de los próximos 90 días.");
        }
    }
    const token = randomBytes(32).toString("base64url");
    const tokenHash = hashToken(token);
    const now = new Date().toISOString();
    const record = {
        id: randomUUID(),
        documentId,
        tokenHash,
        permission: "Viewer",
        isActive: true,
        createdByUserId: userId,
        createdAt: now,
        expiresAt,
        revokedAt: null
    };
    const previous = await drawingRef(`shareLinks/${documentId}`).get();
    const previousHash = previous.val()?.tokenHash;
    const updates = {
        [`shareLinks/${documentId}`]: record,
        [`shareLinksByToken/${tokenHash}`]: documentId,
        [`accessAudit/${randomUUID()}`]: {
            action: "shareLink.created",
            documentId,
            actorUserId: userId,
            createdAt: now,
            expiresAt
        }
    };
    if (typeof previousHash === "string") updates[`shareLinksByToken/${previousHash}`] = null;
    await drawingRef().update(updates);
    return {
        link: {
            id: record.id,
            documentId,
            permission: "Viewer",
            isActive: true,
            createdAt: now,
            expiresAt
        },
        token
    };
}

async function revokeShareLink(documentId, userId) {
    const access = await requireDocumentAccess(documentId, userId, "Owner");
    if (!access) return false;
    const ref = drawingRef(`shareLinks/${documentId}`);
    const linkSnapshot = await ref.get();
    const linkAtStart = linkSnapshot.val();
    let tokenHash = null;
    let revoked = false;
    const result = await ref.transaction((current) => {
        // Con la caché local vacía la transacción recibe null: se sustituye por la
        // lectura previa y Firebase reintenta con el valor real del servidor.
        if (current === null) current = structuredClone(linkAtStart);
        if (!current || !current.isActive) return;
        tokenHash = current.tokenHash;
        current.isActive = false;
        current.revokedAt = new Date().toISOString();
        revoked = true;
        return current;
    });
    if (!result.committed || !revoked) return false;
    const updates = {
        [`accessAudit/${randomUUID()}`]: {
            action: "shareLink.revoked",
            documentId,
            actorUserId: userId,
            createdAt: new Date().toISOString()
        }
    };
    if (typeof tokenHash === "string") updates[`shareLinksByToken/${tokenHash}`] = null;
    await drawingRef().update(updates);
    return true;
}

async function resolveShareLink(token, userId) {
    await consumeDrawingRateLimit(userId, "resolveShareLink", 30);
    if (typeof token !== "string" || token.length < 40 || token.length > 128) {
        throw shareError("El enlace de lectura no es válido.", 404);
    }
    const tokenHash = hashToken(token);
    const lookup = await drawingRef(`shareLinksByToken/${tokenHash}`).get();
    const documentId = lookup.val();
    if (typeof documentId !== "string") throw shareError("El enlace de lectura no es válido.", 404);
    const access = await getLinkAccess(documentId, tokenHash, userId);
    if (!access) throw shareError("El enlace de lectura ha caducado o se ha revocado.", 410);
    await drawingRef(`accessAudit/${randomUUID()}`).set({
        action: "shareLink.opened",
        documentId,
        actorUserId: userId,
        createdAt: new Date().toISOString()
    });
    return {
        documentId,
        documentName: access.document.name,
        ownerUserId: access.document.ownerUserId,
        role: "Viewer"
    };
}

async function getLinkAccess(documentId, tokenHash, userId) {
    const [documentSnapshot, linkSnapshot] = await Promise.all([
        drawingRef(`documents/${documentId}`).get(),
        drawingRef(`shareLinks/${documentId}`).get()
    ]);
    const document = documentSnapshot.val();
    const link = linkSnapshot.val();
    if (!document || document.deletedAt || document.isArchived ||
        !link || !link.isActive || link.tokenHash !== tokenHash ||
        (link.expiresAt && link.expiresAt <= Date.now())) return null;
    return { document: { id: documentId, ...document }, userId, role: "Viewer", tokenHash };
}

async function validateShareToken(documentId, token) {
    if (typeof token !== "string" || token.length < 40 || token.length > 128) return null;
    const tokenHash = hashToken(token);
    return validateShareTokenHash(documentId, tokenHash);
}

async function validateShareTokenHash(documentId, tokenHash) {
    const lookup = await drawingRef(`shareLinksByToken/${tokenHash}`).get();
    if (lookup.val() !== documentId) return null;
    return getLinkAccess(documentId, tokenHash, "");
}

module.exports = {
    createShareLink,
    getShareLink,
    hashToken,
    resolveShareLink,
    revokeShareLink,
    validateShareToken,
    validateShareTokenHash
};
