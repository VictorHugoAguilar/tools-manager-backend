const multer = require("multer");

const MAX_TASK_ATTACHMENT_SIZE = 15 * 1024 * 1024;

const uploadTaskAttachment = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_TASK_ATTACHMENT_SIZE }
}).single("file");

module.exports = {
    MAX_TASK_ATTACHMENT_SIZE,
    uploadTaskAttachment
};
