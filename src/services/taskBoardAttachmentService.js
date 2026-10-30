const { randomUUID } = require("node:crypto");
const { getStorage } = require("firebase-admin/storage");
const { getAdminApp } = require("../config/firebaseAdmin");

const MAX_ATTACHMENT_SIZE = 15 * 1024 * 1024;
const DOWNLOAD_TOKEN_METADATA_KEY = "firebaseStorageDownloadTokens";

function safeFileName(name) {
    return String(name || "archivo").replace(/[^a-zA-Z0-9._-]/g, "-").slice(-120);
}

function getBucket() {
    const app = getAdminApp();
    const bucket = getStorage(app).bucket();
    if (!bucket.name) {
        throw Object.assign(new Error("Firebase Storage no está configurado."), { statusCode: 503 });
    }
    return bucket;
}

async function uploadTaskAttachment(taskId, file, uploadedBy) {
    if (!file?.buffer) {
        throw Object.assign(new Error("Selecciona un archivo."), { statusCode: 400 });
    }
    if (file.size > MAX_ATTACHMENT_SIZE) {
        throw Object.assign(new Error("El archivo supera el límite de 15 MB."), { statusCode: 400 });
    }

    const bucket = getBucket();
    const id = randomUUID();
    const path = `task-board/${taskId}/${id}-${safeFileName(file.originalname)}`;
    const downloadToken = randomUUID();
    const storageFile = bucket.file(path);
    await storageFile.save(file.buffer, {
        resumable: false,
        metadata: {
            contentType: file.mimetype || "application/octet-stream",
            metadata: { [DOWNLOAD_TOKEN_METADATA_KEY]: downloadToken }
        }
    });

    return {
        id,
        name: file.originalname || "archivo",
        size: file.size,
        contentType: file.mimetype || "application/octet-stream",
        path,
        url: `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(path)}?alt=media&token=${downloadToken}`,
        uploadedAt: new Date().toISOString(),
        uploadedById: uploadedBy.id,
        uploadedByName: `${uploadedBy.firstName} ${uploadedBy.lastName}`.trim()
    };
}

async function deleteTaskAttachment(path) {
    if (!path) return;
    await getBucket().file(path).delete({ ignoreNotFound: true });
}

module.exports = {
    MAX_ATTACHMENT_SIZE,
    deleteTaskAttachment,
    uploadTaskAttachment
};
