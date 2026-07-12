const multer = require("multer");

const MAX_IMAGE_SIZE_MB = 20;

const uploadImageFile = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: MAX_IMAGE_SIZE_MB * 1024 * 1024
    },
    fileFilter: (_req, file, callback) => {
        if (!file.mimetype || !file.mimetype.startsWith("image/")) {
            callback(new Error("Only image files are allowed"));
            return;
        }

        callback(null, true);
    }
}).single("image");

module.exports = {
    MAX_IMAGE_SIZE_MB,
    uploadToolImage: uploadImageFile,
    uploadImageFile
};
