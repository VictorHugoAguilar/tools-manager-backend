const multer = require("multer");

const MAX_DRAWING_ASSET_SIZE = 10 * 1024 * 1024;
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_DRAWING_ASSET_SIZE }
}).single("file");

function uploadDrawingAsset(req, res, next) {
    upload(req, res, (error) => {
        if (!error) return next();
        if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
            return res.status(413).json({ message: "La imagen supera el límite de 10 MB." });
        }
        return next(error);
    });
}

module.exports = { MAX_DRAWING_ASSET_SIZE, uploadDrawingAsset };
