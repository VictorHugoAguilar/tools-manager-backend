const multer = require("multer");

const uploadWorkshopStorageImage = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (_req, file, callback) => {
        if (!file.mimetype || !file.mimetype.startsWith("image/")) {
            callback(new Error("Only image files are allowed"));
            return;
        }

        callback(null, true);
    }
}).single("image");

module.exports = { uploadWorkshopStorageImage };
