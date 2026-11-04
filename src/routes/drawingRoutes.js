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

module.exports = { drawingRouter };
