const express = require("express");
const { drawingController } = require("../controllers/drawingController");
const { uploadDrawingAsset } = require("../middleware/drawingUploadMiddleware");

const drawingRouter = express.Router();

drawingRouter.get("/documents", drawingController.listDocuments);
drawingRouter.post("/documents", drawingController.createDocument);
drawingRouter.get("/documents/:documentId", drawingController.getDocument);
drawingRouter.patch("/documents/:documentId", drawingController.updateDocument);
drawingRouter.delete("/documents/:documentId", drawingController.deleteDocument);
drawingRouter.post("/documents/:documentId/duplicate", drawingController.duplicateDocument);
drawingRouter.post("/documents/:documentId/archive", drawingController.archiveDocument);
drawingRouter.post("/documents/:documentId/restore", drawingController.restoreDocument);

drawingRouter.get("/documents/:documentId/pages", drawingController.listPages);
drawingRouter.post("/documents/:documentId/pages", drawingController.createPage);
drawingRouter.patch("/documents/:documentId/pages/reorder", drawingController.reorderPages);
drawingRouter.get("/pages/:pageId", drawingController.getPage);
drawingRouter.patch("/pages/:pageId", drawingController.updatePage);
drawingRouter.delete("/pages/:pageId", drawingController.deletePage);
drawingRouter.post("/pages/:pageId/duplicate", drawingController.duplicatePage);
drawingRouter.get("/pages/:pageId/snapshot", drawingController.getSnapshot);
drawingRouter.put("/pages/:pageId/snapshot", drawingController.saveSnapshot);
drawingRouter.get("/pages/:pageId/versions", drawingController.listVersions);
drawingRouter.get("/pages/:pageId/versions/:version", drawingController.getVersion);
drawingRouter.post("/pages/:pageId/versions/:version/restore", drawingController.restoreVersion);
drawingRouter.get("/pages/:pageId/preferences", drawingController.getPreferences);
drawingRouter.put("/pages/:pageId/preferences", drawingController.savePreferences);

drawingRouter.post("/documents/:documentId/assets", uploadDrawingAsset, drawingController.uploadAsset);
drawingRouter.get("/assets/:assetId", drawingController.downloadAsset);
drawingRouter.delete("/assets/:assetId", drawingController.deleteAsset);

drawingRouter.get("/users/search", drawingController.searchUsers);
drawingRouter.get("/invitations", drawingController.listReceivedInvitations);
drawingRouter.post("/invitations/:invitationId/accept", drawingController.acceptInvitation);
drawingRouter.post("/invitations/:invitationId/decline", drawingController.declineInvitation);
drawingRouter.delete("/invitations/:invitationId", drawingController.cancelInvitation);
drawingRouter.post("/share-links/resolve", drawingController.resolveShareLink);
drawingRouter.post("/documents/:documentId/collaboration-session", drawingController.createCollaborationSession);
drawingRouter.get("/documents/:documentId/permissions", drawingController.listPermissions);
drawingRouter.post("/documents/:documentId/invitations", drawingController.createInvitation);
drawingRouter.get("/documents/:documentId/invitations", drawingController.listDocumentInvitations);
drawingRouter.get("/documents/:documentId/share-link", drawingController.getShareLink);
drawingRouter.post("/documents/:documentId/share-link", drawingController.createShareLink);
drawingRouter.delete("/documents/:documentId/share-link", drawingController.revokeShareLink);
drawingRouter.patch("/permissions/:permissionId", drawingController.updatePermission);
drawingRouter.delete("/permissions/:permissionId", drawingController.revokePermission);

module.exports = { drawingRouter };
