const multer = require("multer");

const MAX_AVATAR_SIZE_MB = 3;
const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

const uploadUserAvatar = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_AVATAR_SIZE_MB * 1024 * 1024 },
    fileFilter: (_req, file, callback) => {
        if (!ALLOWED_IMAGE_TYPES.has(file.mimetype)) {
            callback(new Error("Only JPEG, PNG or WebP images are allowed"));
            return;
        }
        callback(null, true);
    }
}).single("image");

module.exports = {
    ALLOWED_IMAGE_TYPES,
    MAX_AVATAR_SIZE_MB,
    uploadUserAvatar
};
