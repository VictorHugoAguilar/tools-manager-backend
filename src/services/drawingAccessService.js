const { randomUUID } = require("node:crypto");
const { getAdminDatabase } = require("../config/firebaseAdmin");
const { getProfile, listProfiles } = require("./userService");
const { consumeDrawingRateLimit } = require("./drawingRateLimitService");

const ROLES = new Set(["Editor", "Viewer"]);
const ROLE_LEVEL = { Viewer: 1, Editor: 2, Owner: 3 };

function accessError(message, statusCode = 400) {
    return Object.assign(new Error(message), { statusCode });
}

function drawingRef(path = "") {
    const root = getAdminDatabase().ref("drawing");
    return path ? root.child(path) : root;
}

function permissionId(documentId, userId) {
    return Buffer.from(`${documentId}\0${userId}`).toString("base64url");
}

async function getDocumentAccess(documentId, userId, shareToken) {
    if (typeof documentId !== "string" || !documentId || typeof userId !== "string" || !userId) return null;
    const documentSnapshot = await drawingRef(`documents/${documentId}`).get();
    const document = documentSnapshot.val();
    if (!document || document.deletedAt) return null;
    if (document.ownerUserId === userId) {
        return { document: { id: documentId, ...document }, role: "Owner" };
    }

    const permissionSnapshot = await drawingRef(`access/${documentId}/permissions/${userId}`).get();
    const permission = permissionSnapshot.val();
    if (!permission || permission.status !== "Active" || !ROLES.has(permission.role)) {
        if (shareToken) {
            const { validateShareToken } = require("./drawingShareLinkService");
            const linkAccess = await validateShareToken(documentId, shareToken);
            if (linkAccess) return { document: linkAccess.document, role: "Viewer", viaShareLink: true };
        }
        throw accessError("No tienes permiso para acceder a esta pizarra.", 403);
    }
    return { document: { id: documentId, ...document }, role: permission.role };
}

async function requireDocumentAccess(documentId, userId, requiredRole = "Viewer", shareToken) {
    const access = await getDocumentAccess(documentId, userId, shareToken);
    if (!access) return null;
    if ((ROLE_LEVEL[access.role] || 0) < (ROLE_LEVEL[requiredRole] || 0)) {
        throw accessError("No tienes permiso para realizar esta operación.", 403);
    }
    return access;
}

async function listSharedDocuments(userId) {
    const indexSnapshot = await drawingRef(`accessByUser/${userId}`).get();
    const documentIds = Object.keys(indexSnapshot.val() || {});
    const documents = await Promise.all(documentIds.map(async (documentId) => {
        try {
            const access = await getDocumentAccess(documentId, userId);
            return access && access.role !== "Owner"
                ? { ...access.document, accessRole: access.role }
                : null;
        } catch (error) {
            if (error?.statusCode === 403) return null;
            throw error;
        }
    }));
    return documents.filter(Boolean).sort((left, right) =>
        String(right.updatedAt).localeCompare(String(left.updatedAt))
    );
}

async function listPermissions(documentId, actorUserId) {
    const access = await requireDocumentAccess(documentId, actorUserId, "Owner");
    if (!access) return null;
    const snapshot = await drawingRef(`access/${documentId}/permissions`).get();
    const members = Object.entries(snapshot.val() || {})
        .filter(([, permission]) => permission?.status === "Active" && ROLES.has(permission.role))
        .map(([userId, permission]) => ({
            id: permission.id,
            userId,
            role: permission.role,
            grantedByUserId: permission.grantedByUserId,
            createdAt: permission.createdAt,
            updatedAt: permission.updatedAt
        }));
    const owner = await getProfile(access.document.ownerUserId);
    const ownerEntry = owner ? [{
        id: null,
        userId: owner.id,
        role: "Owner",
        firstName: owner.firstName,
        lastName: owner.lastName,
        profileImage: owner.profileImage,
        createdAt: access.document.createdAt,
        updatedAt: access.document.updatedAt
    }] : [];
    const profiles = await Promise.all(members.map((member) => getProfile(member.userId)));
    const participantEntries = members.map((member, index) => ({
        ...member,
        firstName: profiles[index]?.firstName || "",
        lastName: profiles[index]?.lastName || "",
        profileImage: profiles[index]?.profileImage || ""
    }));
    return [...ownerEntry, ...participantEntries];
}

async function createInvitation(documentId, actorUserId, invitedUserId, role) {
    const access = await requireDocumentAccess(documentId, actorUserId, "Owner");
    if (!access) return null;
    await consumeDrawingRateLimit(actorUserId, "createInvitation", 15);
    if (typeof invitedUserId !== "string" || !invitedUserId || invitedUserId === actorUserId) {
        throw accessError("Selecciona otro usuario para invitar.");
    }
    if (!ROLES.has(role)) throw accessError("El rol de acceso no es válido.");
    const recipient = await getProfile(invitedUserId);
    if (!recipient || !recipient.isActive) throw accessError("No se pudo invitar a ese usuario.", 404);

    const now = Date.now();
    const expiresAt = now + 7 * 24 * 60 * 60 * 1000;
    const invitationId = randomUUID();
    const ref = drawingRef(`access/${documentId}`);
    let conflictMessage = "";
    const transaction = await ref.transaction((current) => {
        conflictMessage = "";
        current = current || {};
        const permissions = current.permissions || {};
        const existing = permissions[invitedUserId];
        if (existing?.status === "Active") {
            conflictMessage = "El usuario ya tiene acceso a esta pizarra.";
            return;
        }
        if (existing?.status === "Pending" && Number(existing.expiresAt) > now) {
            conflictMessage = "Ya hay una invitación pendiente para este usuario.";
            return;
        }
        if (existing?.status === "Pending" && existing.invitationId &&
            current.invitations?.[existing.invitationId]) {
            current.invitations[existing.invitationId].status = "Expired";
        }
        const invitation = {
            id: invitationId,
            documentId,
            invitedUserId,
            role,
            status: "Pending",
            invitedByUserId: actorUserId,
            createdAt: new Date(now).toISOString(),
            expiresAt
        };
        current.permissions = {
            ...permissions,
            [invitedUserId]: {
                id: permissionId(documentId, invitedUserId),
                role,
                status: "Pending",
                invitationId,
                invitedByUserId: actorUserId,
                createdAt: invitation.createdAt,
                expiresAt
            }
        };
        current.invitations = { ...(current.invitations || {}), [invitationId]: invitation };
        current.pendingInvitationsByUser = {
            ...(current.pendingInvitationsByUser || {}),
            [invitedUserId]: invitationId
        };
        return current;
    });
    if (conflictMessage) {
        if (conflictMessage === "Ya hay una invitación pendiente para este usuario.") {
            const currentSnapshot = await ref.get();
            const current = currentSnapshot.val();
            const existing = current?.permissions?.[invitedUserId];
            const invitation = existing?.invitationId && current.invitations?.[existing.invitationId];
            if (invitation?.status === "Pending" && invitation.expiresAt > now) {
                await drawingRef().update({
                    [`invitationsByRecipient/${invitedUserId}/${invitation.id}`]: true,
                    [`invitationLookup/${invitation.id}`]: documentId
                });
            }
        }
        throw accessError(conflictMessage, 409);
    }
    if (!transaction.committed) throw accessError("No se pudo crear la invitación.", 409);

    await drawingRef().update({
        [`invitationsByRecipient/${invitedUserId}/${invitationId}`]: true,
        [`invitationLookup/${invitationId}`]: documentId,
        [`accessAudit/${randomUUID()}`]: {
            action: "invitation.created",
            documentId,
            actorUserId,
            targetUserId: invitedUserId,
            createdAt: new Date(now).toISOString()
        }
    });
    return { ...transaction.snapshot.val().invitations[invitationId], recipient: {
        id: recipient.id,
        firstName: recipient.firstName,
        lastName: recipient.lastName,
        profileImage: recipient.profileImage
    } };
}

async function listReceivedInvitations(userId) {
    const index = await drawingRef(`invitationsByRecipient/${userId}`).get();
    const invitationIds = Object.keys(index.val() || {});
    const invitations = await Promise.all(invitationIds.map(async (id) => {
        const documentIdSnapshot = await drawingRef(`invitationLookup/${id}`).get();
        const documentId = documentIdSnapshot.val();
        if (typeof documentId !== "string") return null;
        const invitationSnapshot = await drawingRef(`access/${documentId}/invitations/${id}`).get();
        const invitation = invitationSnapshot.val();
        if (!invitation || invitation.invitedUserId !== userId) return null;
        const currentInvitation = invitation.status === "Pending" && invitation.expiresAt <= Date.now()
            ? await expireInvitation(documentId, id, userId)
            : invitation;
        const documentSnapshot = await drawingRef(`documents/${documentId}`).get();
        const document = documentSnapshot.val();
        return {
            ...(currentInvitation || invitation),
            documentName: document?.name || "Pizarra no disponible",
            ownerUserId: document?.ownerUserId || ""
        };
    }));
    return invitations.filter(Boolean).sort((left, right) =>
        String(right.createdAt).localeCompare(String(left.createdAt))
    );
}

async function listDocumentInvitations(documentId, actorUserId) {
    const access = await requireDocumentAccess(documentId, actorUserId, "Owner");
    if (!access) return null;
    const snapshot = await drawingRef(`access/${documentId}/invitations`).get();
    const invitations = Object.values(snapshot.val() || {});
    for (const invitation of invitations) {
        if (invitation.status === "Pending" && invitation.expiresAt <= Date.now()) {
            await expireInvitation(documentId, invitation.id, invitation.invitedUserId);
        }
    }
    const updated = await drawingRef(`access/${documentId}/invitations`).get();
    return Object.values(updated.val() || {}).sort((left, right) =>
        String(right.createdAt).localeCompare(String(left.createdAt))
    );
}

async function expireInvitation(documentId, invitationId, userId) {
    const ref = drawingRef(`access/${documentId}`);
    const accessSnapshot = await ref.get();
    const accessAtStart = accessSnapshot.val();
    let expired = null;
    const result = await ref.transaction((current) => {
        expired = null;
        // Con la caché local vacía la transacción recibe null: se sustituye por la
        // lectura previa y Firebase reintenta con el valor real del servidor.
        if (current === null) current = structuredClone(accessAtStart);
        const invitation = current?.invitations?.[invitationId];
        if (!invitation || invitation.status !== "Pending" || invitation.expiresAt > Date.now()) return;
        invitation.status = "Expired";
        const permission = current.permissions?.[userId];
        if (permission?.invitationId === invitationId && permission.status === "Pending") {
            delete current.permissions[userId];
        }
        if (current.pendingInvitationsByUser?.[userId] === invitationId) {
            delete current.pendingInvitationsByUser[userId];
        }
        expired = invitation;
        return current;
    });
    if (expired && result.committed) {
        await drawingRef(`invitationsByRecipient/${userId}/${invitationId}`).set(true);
    }
    return expired;
}

async function transitionInvitation(invitationId, actorUserId, action) {
    const lookup = await drawingRef(`invitationLookup/${invitationId}`).get();
    const documentId = lookup.val();
    if (typeof documentId !== "string") return null;
    const ref = drawingRef(`access/${documentId}`);
    const accessSnapshot = await ref.get();
    const accessAtStart = accessSnapshot.val();
    const current = accessAtStart?.invitations?.[invitationId] ?? null;
    if (!current) return null;
    if (action === "accept" || action === "decline") {
        if (current.invitedUserId !== actorUserId) throw accessError("La invitación no está disponible.", 404);
        if (action === "accept" && current.status === "Accepted") {
            const permissionSnapshot = await drawingRef(
                `access/${documentId}/permissions/${actorUserId}`
            ).get();
            const permission = permissionSnapshot.val();
            if (permission?.status !== "Active" || permission.invitationId !== invitationId) {
                throw accessError("La invitación ya no está disponible.", 409);
            }
            const id = permission.id || permissionId(documentId, actorUserId);
            await drawingRef().update({
                [`accessByUser/${actorUserId}/${documentId}`]: true,
                [`permissionsById/${id}`]: {
                    documentId,
                    userId: actorUserId
                }
            });
            return { ...current, documentId };
        }
    } else {
        const access = await requireDocumentAccess(documentId, actorUserId, "Owner");
        if (!access) return null;
        if (current.status !== "Pending") throw accessError("La invitación ya no está pendiente.", 409);
    }

    let conflict = "";
    let expired = false;
    let resultInvitation = null;
    const transaction = await ref.transaction((access) => {
        conflict = "";
        expired = false;
        resultInvitation = null;
        // Con la caché local vacía la transacción recibe null: se sustituye por la
        // lectura previa y Firebase reintenta con el valor real del servidor.
        if (access === null) access = structuredClone(accessAtStart);
        const invitation = access?.invitations?.[invitationId];
        if (!invitation) return;
        if (invitation.status !== "Pending") {
            conflict = "La invitación ya no está pendiente.";
            return;
        }
        if (invitation.expiresAt <= Date.now()) {
            invitation.status = "Expired";
            if (access.permissions?.[invitation.invitedUserId]?.invitationId === invitationId) {
                delete access.permissions[invitation.invitedUserId];
            }
            if (access.pendingInvitationsByUser?.[invitation.invitedUserId] === invitationId) {
                delete access.pendingInvitationsByUser[invitation.invitedUserId];
            }
            expired = true;
            resultInvitation = { ...invitation };
            return access;
        }
        const now = new Date().toISOString();
        const permission = access.permissions?.[invitation.invitedUserId];
        if (action === "accept") {
            if (!permission || permission.invitationId !== invitationId) {
                conflict = "La invitación ya no está disponible.";
                return;
            }
            permission.status = "Active";
            permission.updatedAt = now;
            invitation.status = "Accepted";
            invitation.acceptedAt = now;
        } else if (action === "decline") {
            if (permission?.invitationId === invitationId) delete access.permissions[invitation.invitedUserId];
            invitation.status = "Declined";
            invitation.declinedAt = now;
        } else {
            if (permission?.invitationId === invitationId) delete access.permissions[invitation.invitedUserId];
            invitation.status = "Revoked";
            invitation.revokedAt = now;
        }
        if (access.pendingInvitationsByUser?.[invitation.invitedUserId] === invitationId) {
            delete access.pendingInvitationsByUser[invitation.invitedUserId];
        }
        resultInvitation = { ...invitation };
        return access;
    });
    if (!transaction.committed && !conflict) return null;
    if (conflict) throw accessError(conflict, 409);
    if (!transaction.committed) throw accessError(conflict || "No se pudo actualizar la invitación.", 409);

    const invitation = resultInvitation;
    if (expired) {
        await drawingRef(`invitationsByRecipient/${invitation.invitedUserId}/${invitationId}`).set(true);
        throw accessError("La invitación ha caducado.", 410);
    }
    const updates = {
        [`invitationsByRecipient/${invitation.invitedUserId}/${invitationId}`]: true,
        [`accessAudit/${randomUUID()}`]: {
            action: `invitation.${{ accept: "accepted", decline: "declined", cancel: "revoked" }[action]}`,
            documentId,
            actorUserId,
            targetUserId: invitation.invitedUserId,
            createdAt: new Date().toISOString()
        }
    };
    if (action === "accept") {
        updates[`accessByUser/${invitation.invitedUserId}/${documentId}`] = true;
        updates[`permissionsById/${permissionId(documentId, invitation.invitedUserId)}`] = {
            documentId,
            userId: invitation.invitedUserId
        };
    }
    await drawingRef().update(updates);
    return { ...invitation, documentId };
}

async function changePermission(permissionIdValue, actorUserId, role) {
    if (typeof permissionIdValue !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(permissionIdValue)) return null;
    if (!ROLES.has(role)) throw accessError("El rol de acceso no es válido.");
    const lookupSnapshot = await drawingRef(`permissionsById/${permissionIdValue}`).get();
    const lookup = lookupSnapshot.val();
    if (!lookup?.documentId || !lookup?.userId) return null;
    const access = await requireDocumentAccess(lookup.documentId, actorUserId, "Owner");
    if (!access) return null;
    const ref = drawingRef(`access/${lookup.documentId}`);
    const accessSnapshot = await ref.get();
    const accessAtStart = accessSnapshot.val();
    let updated = null;
    const result = await ref.transaction((current) => {
        // Con la caché local vacía la transacción recibe null: se sustituye por la
        // lectura previa y Firebase reintenta con el valor real del servidor.
        if (current === null) current = structuredClone(accessAtStart);
        const permission = current?.permissions?.[lookup.userId];
        if (!permission || permission.status !== "Active" || permission.id !== permissionIdValue) return;
        permission.role = role;
        permission.updatedAt = new Date().toISOString();
        const invitation = permission.invitationId && current.invitations?.[permission.invitationId];
        if (invitation?.status === "Accepted") invitation.role = role;
        updated = { ...permission };
        return current;
    });
    if (!result.committed) return null;
    await drawingRef(`accessAudit/${randomUUID()}`).set({
        action: "permission.changed",
        documentId: lookup.documentId,
        actorUserId,
        targetUserId: lookup.userId,
        role,
        createdAt: new Date().toISOString()
    });
    return { id: permissionIdValue, userId: lookup.userId, ...updated };
}

async function revokePermission(permissionIdValue, actorUserId) {
    if (typeof permissionIdValue !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(permissionIdValue)) return false;
    const lookupSnapshot = await drawingRef(`permissionsById/${permissionIdValue}`).get();
    const lookup = lookupSnapshot.val();
    if (!lookup?.documentId || !lookup?.userId) return false;
    const access = await requireDocumentAccess(lookup.documentId, actorUserId, "Owner");
    if (!access) return false;
    const ref = drawingRef(`access/${lookup.documentId}`);
    const accessSnapshot = await ref.get();
    const accessAtStart = accessSnapshot.val();
    let revoked = false;
    const result = await ref.transaction((current) => {
        revoked = false;
        // Con la caché local vacía la transacción recibe null: se sustituye por la
        // lectura previa y Firebase reintenta con el valor real del servidor.
        if (current === null) current = structuredClone(accessAtStart);
        const permission = current?.permissions?.[lookup.userId];
        if (!permission || permission.status !== "Active" || permission.id !== permissionIdValue) return;
        delete current.permissions[lookup.userId];
        revoked = true;
        return current;
    });
    if (!result.committed || !revoked) return false;
    await drawingRef().update({
        [`accessByUser/${lookup.userId}/${lookup.documentId}`]: null,
        [`permissionsById/${permissionIdValue}`]: null,
        [`accessAudit/${randomUUID()}`]: {
            action: "permission.revoked",
            documentId: lookup.documentId,
            actorUserId,
            targetUserId: lookup.userId,
            createdAt: new Date().toISOString()
        }
    });
    return true;
}

async function resolveInvitation(invitationId, userId) {
    const lookup = await drawingRef(`invitationLookup/${invitationId}`).get();
    const documentId = lookup.val();
    if (typeof documentId !== "string") return null;
    const snapshot = await drawingRef(`access/${documentId}/invitations/${invitationId}`).get();
    const invitation = snapshot.val();
    if (!invitation || invitation.invitedUserId !== userId) return null;
    return { ...invitation, documentId };
}

async function searchUsers(search, currentUserId) {
    const query = typeof search === "string" ? search.trim() : "";
    if (query.length < 2 || query.length > 100) {
        throw accessError("La búsqueda debe tener entre 2 y 100 caracteres.");
    }
    await consumeDrawingRateLimit(currentUserId, "searchUsers", 30);
    const result = await listProfiles({ search: query, limit: 25, page: 1, status: "active" });
    return result.users
        .filter((user) => user.id !== currentUserId)
        .map((user) => ({
            id: user.id,
            firstName: user.firstName,
            lastName: user.lastName,
            email: user.email,
            profileImage: user.profileImage
        }));
}

module.exports = {
    ROLES,
    changePermission,
    createInvitation,
    getDocumentAccess,
    listDocumentInvitations,
    listPermissions,
    listReceivedInvitations,
    listSharedDocuments,
    permissionId,
    requireDocumentAccess,
    resolveInvitation,
    revokePermission,
    searchUsers,
    transitionInvitation
};
