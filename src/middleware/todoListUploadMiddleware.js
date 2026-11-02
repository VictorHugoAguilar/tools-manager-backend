const multer = require("multer");
const { TODO_LIST_MAX_ATTACHMENT_SIZE } = require("../services/todoListAttachmentService");

const todoListMulter = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: TODO_LIST_MAX_ATTACHMENT_SIZE }
}).single("file");

function todoListUploadAttachment(req, res, next) {
    todoListMulter(req, res, (error) => {
        if (!error) return next();
        if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
            return res.status(413).json({ message: "El archivo supera el límite de 20 MB." });
        }
        return next(error);
    });
}

module.exports = { todoListUploadAttachment };
