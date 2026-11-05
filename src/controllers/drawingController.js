const drawing = require("../services/drawingService");
const drawingAccess = require("../services/drawingAccessService");
const drawingLinks = require("../services/drawingShareLinkService");
const drawingCollaboration = require("../services/drawingCollaborationService");

function handle(handler) {
    return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

const drawingController = {
    listDocuments: handle(async (req, res) =>
        res.json(await drawing.listDocuments(req.authUser.id, req.query))),
    getDocument: handle(async (req, res) => {
        const document = await drawing.getDocument(
            req.params.documentId,
            req.authUser.id,
            req.get("x-drawing-share-token")
        );
        return document ? res.json({ document }) : res.status(404).json({ message: "Pizarra no encontrada." });
    }),
    createDocument: handle(async (req, res) =>
        res.status(201).json({ document: await drawing.createDocument(req.body, req.authUser.id) })),
    updateDocument: handle(async (req, res) => {
        const document = await drawing.updateDocument(req.params.documentId, req.body, req.authUser.id);
        return document ? res.json({ document }) : res.status(404).json({ message: "Pizarra no encontrada." });
    }),
    deleteDocument: handle(async (req, res) => {
        const deleted = await drawing.deleteDocument(req.params.documentId, req.authUser.id);
        return deleted ? res.status(204).send() : res.status(404).json({ message: "Pizarra no encontrada." });
    }),
    duplicateDocument: handle(async (req, res) => {
        const document = await drawing.duplicateDocument(req.params.documentId, req.authUser.id);
        return document ? res.status(201).json({ document }) : res.status(404).json({ message: "Pizarra no encontrada." });
    }),
    archiveDocument: handle(async (req, res) => {
        const document = await drawing.setDocumentArchived(req.params.documentId, true, req.authUser.id);
        return document ? res.json({ document }) : res.status(404).json({ message: "Pizarra no encontrada." });
    }),
    restoreDocument: handle(async (req, res) => {
        const document = await drawing.setDocumentArchived(req.params.documentId, false, req.authUser.id);
        return document ? res.json({ document }) : res.status(404).json({ message: "Pizarra no encontrada." });
    }),

    listPages: handle(async (req, res) => {
        const document = await drawing.getDocument(
            req.params.documentId,
            req.authUser.id,
            req.get("x-drawing-share-token")
        );
        return document
            ? res.json({ pages: document.pages })
            : res.status(404).json({ message: "Pizarra no encontrada." });
    }),
    createPage: handle(async (req, res) => {
        const page = await drawing.createPage(req.params.documentId, req.body, req.authUser.id);
        return page ? res.status(201).json({ page }) : res.status(404).json({ message: "Pizarra no encontrada." });
    }),
    reorderPages: handle(async (req, res) => {
        const pages = await drawing.reorderPages(req.params.documentId, req.body?.ids, req.authUser.id);
        return pages ? res.json({ pages }) : res.status(404).json({ message: "Pizarra no encontrada." });
    }),
    getPage: handle(async (req, res) => {
        const page = await drawing.getPageForUser(
            req.params.pageId,
            req.authUser.id,
            "Viewer",
            req.get("x-drawing-share-token")
        );
        if (!page) return res.status(404).json({ message: "Página no encontrada." });
        const { document: _document, ...pageData } = page;
        return res.json({ page: pageData });
    }),
    updatePage: handle(async (req, res) => {
        const page = await drawing.updatePage(req.params.pageId, req.body, req.authUser.id);
        return page ? res.json({ page }) : res.status(404).json({ message: "Página no encontrada." });
    }),
    deletePage: handle(async (req, res) => {
        const deleted = await drawing.deletePage(req.params.pageId, req.authUser.id);
        return deleted ? res.status(204).send() : res.status(404).json({ message: "Página no encontrada." });
    }),
    duplicatePage: handle(async (req, res) => {
        const page = await drawing.duplicatePage(req.params.pageId, req.authUser.id);
        return page ? res.status(201).json({ page }) : res.status(404).json({ message: "Página no encontrada." });
    }),
    getSnapshot: handle(async (req, res) => {
        const snapshot = await drawing.getSnapshot(
            req.params.pageId,
            req.authUser.id,
            req.get("x-drawing-share-token")
        );
        return snapshot ? res.json(snapshot) : res.status(404).json({ message: "Página no encontrada." });
    }),
    saveSnapshot: handle(async (req, res) => {
        const result = await drawing.saveSnapshot(req.params.pageId, req.body, req.authUser.id);
        return result ? res.json(result) : res.status(404).json({ message: "Página no encontrada." });
    }),
    listVersions: handle(async (req, res) => {
        const versions = await drawing.listVersions(
            req.params.pageId,
            req.authUser.id,
            req.get("x-drawing-share-token")
        );
        return versions ? res.json({ versions }) : res.status(404).json({ message: "Página no encontrada." });
    }),
    getVersion: handle(async (req, res) => {
        const snapshot = await drawing.getVersion(
            req.params.pageId,
            req.params.version,
            req.authUser.id,
            req.get("x-drawing-share-token")
        );
        return snapshot ? res.json(snapshot) : res.status(404).json({ message: "Versión no encontrada." });
    }),
    restoreVersion: handle(async (req, res) => {
        const restored = await drawing.restoreVersion(req.params.pageId, req.params.version, req.authUser.id);
        return restored ? res.json(restored) : res.status(404).json({ message: "Versión no encontrada." });
    }),
    uploadAsset: handle(async (req, res) => {
        const asset = await drawing.uploadAsset(
            req.params.documentId,
            req.body?.pageId || null,
            req.file,
            req.authUser.id
        );
        return asset ? res.status(201).json({ asset }) : res.status(404).json({ message: "Pizarra no encontrada." });
    }),
    downloadAsset: handle(async (req, res, next) => {
        const result = await drawing.streamAsset(
            req.params.assetId,
            req.authUser.id,
            req.get("x-drawing-share-token")
        );
        if (!result) return res.status(404).json({ message: "Imagen no encontrada." });
        res.set({
            "Content-Type": result.asset.contentType,
            "Content-Length": String(result.asset.sizeBytes),
            "Content-Disposition": `inline; filename="${result.asset.originalFileName}"`,
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff"
        });
        result.stream.on("error", (error) => {
            if (res.headersSent) return res.destroy(error);
            return next(error);
        });
        return result.stream.pipe(res);
    }),
    deleteAsset: handle(async (req, res) => {
        const deleted = await drawing.deleteAsset(req.params.assetId, req.authUser.id);
        return deleted ? res.status(204).send() : res.status(404).json({ message: "Imagen no encontrada." });
    }),
    getPreferences: handle(async (req, res) => {
        const preferences = await drawing.getPreferences(
            req.params.pageId,
            req.authUser.id,
            req.get("x-drawing-share-token")
        );
        return preferences ? res.json({ preferences }) : res.status(404).json({ message: "Página no encontrada." });
    }),
    savePreferences: handle(async (req, res) => {
        const preferences = await drawing.savePreferences(
            req.params.pageId,
            req.body,
            req.authUser.id,
            req.get("x-drawing-share-token")
        );
        return preferences ? res.json({ preferences }) : res.status(404).json({ message: "Página no encontrada." });
    }),

    searchUsers: handle(async (req, res) =>
        res.json({ users: await drawingAccess.searchUsers(req.query.q, req.authUser.id) })),
    listPermissions: handle(async (req, res) => {
        const permissions = await drawingAccess.listPermissions(req.params.documentId, req.authUser.id);
        return permissions ? res.json({ permissions }) : res.status(404).json({ message: "Pizarra no encontrada." });
    }),
    createInvitation: handle(async (req, res) => {
        const allowed = new Set(["userId", "role"]);
        if (!req.body || typeof req.body !== "object" || Array.isArray(req.body) ||
            Object.keys(req.body).some((key) => !allowed.has(key))) {
            throw Object.assign(new Error("Los datos de la invitación no son válidos."), { statusCode: 400 });
        }
        const invitation = await drawingAccess.createInvitation(
            req.params.documentId,
            req.authUser.id,
            req.body.userId,
            req.body.role
        );
        return invitation ? res.status(201).json({ invitation }) :
            res.status(404).json({ message: "Pizarra no encontrada." });
    }),
    listReceivedInvitations: handle(async (req, res) =>
        res.json({ invitations: await drawingAccess.listReceivedInvitations(req.authUser.id) })),
    listDocumentInvitations: handle(async (req, res) => {
        const invitations = await drawingAccess.listDocumentInvitations(req.params.documentId, req.authUser.id);
        return invitations ? res.json({ invitations }) : res.status(404).json({ message: "Pizarra no encontrada." });
    }),
    acceptInvitation: handle(async (req, res) => {
        const invitation = await drawingAccess.transitionInvitation(req.params.invitationId, req.authUser.id, "accept");
        return invitation ? res.json({ invitation }) : res.status(404).json({ message: "Invitación no encontrada." });
    }),
    declineInvitation: handle(async (req, res) => {
        const invitation = await drawingAccess.transitionInvitation(req.params.invitationId, req.authUser.id, "decline");
        return invitation ? res.json({ invitation }) : res.status(404).json({ message: "Invitación no encontrada." });
    }),
    cancelInvitation: handle(async (req, res) => {
        const invitation = await drawingAccess.transitionInvitation(req.params.invitationId, req.authUser.id, "cancel");
        return invitation ? res.status(204).send() : res.status(404).json({ message: "Invitación no encontrada." });
    }),
    updatePermission: handle(async (req, res) => {
        const allowed = new Set(["role"]);
        if (!req.body || typeof req.body !== "object" || Array.isArray(req.body) ||
            Object.keys(req.body).some((key) => !allowed.has(key))) {
            throw Object.assign(new Error("Los datos del permiso no son válidos."), { statusCode: 400 });
        }
        const permission = await drawingAccess.changePermission(
            req.params.permissionId,
            req.authUser.id,
            req.body.role
        );
        return permission ? res.json({ permission }) :
            res.status(404).json({ message: "Permiso no encontrado." });
    }),
    revokePermission: handle(async (req, res) => {
        const revoked = await drawingAccess.revokePermission(req.params.permissionId, req.authUser.id);
        return revoked ? res.status(204).send() : res.status(404).json({ message: "Permiso no encontrado." });
    }),
    getShareLink: handle(async (req, res) => {
        const link = await drawingLinks.getShareLink(req.params.documentId, req.authUser.id);
        return link ? res.json({ link }) : res.status(404).json({ message: "Pizarra no encontrada." });
    }),
    createShareLink: handle(async (req, res) => {
        const allowed = new Set(["expiresAt"]);
        if (!req.body || typeof req.body !== "object" || Array.isArray(req.body) ||
            Object.keys(req.body).some((key) => !allowed.has(key))) {
            throw Object.assign(new Error("Los datos del enlace no son válidos."), { statusCode: 400 });
        }
        const result = await drawingLinks.createShareLink(
            req.params.documentId,
            req.authUser.id,
            req.body.expiresAt
        );
        return result ? res.status(201).json(result) :
            res.status(404).json({ message: "Pizarra no encontrada." });
    }),
    revokeShareLink: handle(async (req, res) => {
        const revoked = await drawingLinks.revokeShareLink(req.params.documentId, req.authUser.id);
        return revoked ? res.status(204).send() : res.status(404).json({ message: "Enlace no encontrado." });
    }),
    resolveShareLink: handle(async (req, res) => {
        if (!req.body || typeof req.body !== "object" || Array.isArray(req.body) ||
            Object.keys(req.body).length !== 1 || typeof req.body.token !== "string") {
            throw Object.assign(new Error("El enlace de lectura no es válido."), { statusCode: 400 });
        }
        const result = await drawingLinks.resolveShareLink(req.body.token, req.authUser.id);
        return res.json(result);
    }),
    createCollaborationSession: handle(async (req, res) => {
        const allowed = new Set(["pageId"]);
        if (!req.body || typeof req.body !== "object" || Array.isArray(req.body) ||
            Object.keys(req.body).some((key) => !allowed.has(key)) ||
            typeof req.body.pageId !== "string") {
            throw Object.assign(new Error("Los datos de la sesión colaborativa no son válidos."), { statusCode: 400 });
        }
        const session = await drawingCollaboration.createCollaborationSession(
            req.params.documentId,
            req.body.pageId,
            req.authUser.id,
            req.get("x-drawing-share-token")
        );
        return session ? res.json({ session }) : res.status(404).json({ message: "Pizarra o página no encontrada." });
    })
};

module.exports = { drawingController };
