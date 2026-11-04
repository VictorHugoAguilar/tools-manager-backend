const drawing = require("../services/drawingService");

function handle(handler) {
    return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

const drawingController = {
    listDocuments: handle(async (req, res) =>
        res.json(await drawing.listDocuments(req.authUser.id, req.query))),
    getDocument: handle(async (req, res) => {
        const document = await drawing.getDocument(req.params.documentId, req.authUser.id);
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
        const document = await drawing.getDocument(req.params.documentId, req.authUser.id);
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
        const page = await drawing.getPageForUser(req.params.pageId, req.authUser.id);
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
        const snapshot = await drawing.getSnapshot(req.params.pageId, req.authUser.id);
        return snapshot ? res.json(snapshot) : res.status(404).json({ message: "Página no encontrada." });
    }),
    saveSnapshot: handle(async (req, res) => {
        const result = await drawing.saveSnapshot(req.params.pageId, req.body, req.authUser.id);
        return result ? res.json(result) : res.status(404).json({ message: "Página no encontrada." });
    }),
    listVersions: handle(async (req, res) => {
        const versions = await drawing.listVersions(req.params.pageId, req.authUser.id);
        return versions ? res.json({ versions }) : res.status(404).json({ message: "Página no encontrada." });
    }),
    getVersion: handle(async (req, res) => {
        const snapshot = await drawing.getVersion(req.params.pageId, req.params.version, req.authUser.id);
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
        const result = await drawing.streamAsset(req.params.assetId, req.authUser.id);
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
        const preferences = await drawing.getPreferences(req.params.pageId, req.authUser.id);
        return preferences ? res.json({ preferences }) : res.status(404).json({ message: "Página no encontrada." });
    }),
    savePreferences: handle(async (req, res) => {
        const preferences = await drawing.savePreferences(req.params.pageId, req.body, req.authUser.id);
        return preferences ? res.json({ preferences }) : res.status(404).json({ message: "Página no encontrada." });
    })
};

module.exports = { drawingController };
