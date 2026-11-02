const { randomUUID } = require("node:crypto");
const { getStorage } = require("firebase-admin/storage");
const { getAdminApp } = require("../config/firebaseAdmin");

const TODO_LIST_MAX_ATTACHMENT_SIZE = 20 * 1024 * 1024;
const TODO_LIST_ALLOWED_TYPES = new Set([
    "application/pdf",
    "image/jpeg",
    "image/png",
    "image/webp",
    "text/plain",
    "application/rtf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-powerpoint",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "text/csv"
]);

function todoListAttachmentError(message, statusCode) {
    return Object.assign(new Error(message), { statusCode });
}

function todoListSafeFileName(fileName) {
    return String(fileName || "archivo")
        .normalize("NFKD")
        .replace(/[^\w.-]/g, "_")
        .slice(-120) || "archivo";
}

function todoListGetBucket() {
    const todoListBucket = getStorage(getAdminApp()).bucket();
    if (!todoListBucket.name) {
        throw todoListAttachmentError("Firebase Storage no está configurado.", 503);
    }
    return todoListBucket;
}

async function todoListUploadAttachment(todoListItemId, todoListFile, todoListActorId) {
    if (!todoListFile?.buffer) {
        throw todoListAttachmentError("Selecciona un archivo adjunto.", 400);
    }
    if (todoListFile.size > TODO_LIST_MAX_ATTACHMENT_SIZE) {
        throw todoListAttachmentError("El archivo supera el límite de 20 MB.", 413);
    }
    if (!TODO_LIST_ALLOWED_TYPES.has(todoListFile.mimetype)) {
        throw todoListAttachmentError("El formato del archivo no está permitido.", 415);
    }

    const todoListBucket = todoListGetBucket();
    const todoListAttachmentId = randomUUID();
    const todoListPath = `todo-list/${todoListItemId}/${todoListAttachmentId}-${todoListSafeFileName(todoListFile.originalname)}`;
    const todoListStorageFile = todoListBucket.file(todoListPath);
    await todoListStorageFile.save(todoListFile.buffer, {
        resumable: false,
        metadata: { contentType: todoListFile.mimetype }
    });

    return {
        id: todoListAttachmentId,
        todoListItemId,
        fileName: todoListFile.originalname || "archivo",
        storagePath: todoListPath,
        contentType: todoListFile.mimetype,
        size: todoListFile.size,
        uploadedByUserId: todoListActorId,
        createdAt: new Date().toISOString()
    };
}

async function todoListGetAttachmentUrl(todoListPath) {
    if (!todoListPath) {
        throw todoListAttachmentError("La ruta del archivo no es válida.", 400);
    }
    const [todoListUrl] = await todoListGetBucket().file(todoListPath).getSignedUrl({
        action: "read",
        expires: Date.now() + 15 * 60 * 1000
    });
    return todoListUrl;
}

async function todoListDeleteAttachment(todoListPath) {
    if (!todoListPath) return;
    await todoListGetBucket().file(todoListPath).delete({ ignoreNotFound: true });
}

module.exports = {
    TODO_LIST_MAX_ATTACHMENT_SIZE,
    todoListDeleteAttachment,
    todoListGetAttachmentUrl,
    todoListUploadAttachment
};
