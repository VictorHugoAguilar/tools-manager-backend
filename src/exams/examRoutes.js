const express = require("express");
const multer = require("multer");
const { requirePermission } = require("../middleware/authMiddleware");
const { createExamService } = require("./examService");

const MAX_FILE_BYTES = 2 * 1024 * 1024;
// Busboy signals its limit when it is reached, so allow one byte past the inclusive maximum.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_BYTES + 1, files: 1 } });

function createExamRouter(serviceFactory = createExamService) {
    const router = express.Router();
    const handle = (fn) => async (req, res, next) => {
        try {
            res.json(await fn(serviceFactory(), req));
        } catch (error) {
            next(error);
        }
    };
    router.get("/sections", handle((service) => service.catalog()));
    router.get("/history", handle((service, req) => service.history(req.authUser.id)));
    router.post("/exams", handle((service, req) => service.start(req.authUser.id, req.body?.section, req.body?.minutes)));
    router.get("/exams/:id", handle((service, req) => service.change(req.authUser.id, req.params.id, { type: "read" })));
    router.put("/exams/:id/answer", handle((service, req) => service.change(req.authUser.id, req.params.id, {
        type: "answer", questionId: req.body?.questionId, optionId: req.body?.optionId
    })));
    router.post("/exams/:id/finish", handle((service, req) => service.change(req.authUser.id, req.params.id, { type: "finish" })));
    const uploadJson = (req, res, next) => upload.single("file")(req, res, (error) => {
        if (error instanceof multer.MulterError) {
            return next(Object.assign(new Error(error.code === "LIMIT_FILE_SIZE"
                ? "El archivo supera el límite de 2 MB." : "No se pudo procesar el archivo."), { statusCode: 400 }));
        }
        return next(error);
    });
    router.post("/import", requirePermission("users:manage"), uploadJson, handle((service, req) => {
        if (!req.file) throw Object.assign(new Error("Selecciona un archivo JSON."), { statusCode: 400 });
        let data;
        try {
            data = JSON.parse(req.file.buffer.toString("utf8"));
        } catch (error) {
            if (!(error instanceof SyntaxError)) throw error;
            throw Object.assign(new Error("El archivo no contiene JSON válido."), { statusCode: 400 });
        }
        return service.importBank(data);
    }));
    router.post("/import-initial", requirePermission("users:manage"), handle((service) =>
        service.importBank(require("../../data/exams/banco_practica_harec.json"))));
    return router;
}

module.exports = { createExamRouter };
