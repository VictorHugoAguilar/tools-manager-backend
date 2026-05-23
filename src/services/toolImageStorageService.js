const { randomUUID } = require("crypto");
const path = require("path");
const {
    deleteObject,
    getDownloadURL,
    ref,
    uploadBytes
} = require("firebase/storage");
const { getStorageInstance } = require("../config/database");

function sanitizeFileName(fileName) {
    return fileName.replace(/[^a-zA-Z0-9._-]/g, "-");
}

function buildStoragePath(pathPrefix, originalName) {
    const extension = path.extname(originalName || "").toLowerCase();
    const safeExtension = extension || ".bin";
    const uniqueName = `${Date.now()}-${randomUUID()}${safeExtension}`;

    return `${pathPrefix}/${sanitizeFileName(uniqueName)}`;
}

async function uploadImage(pathPrefix, file, customMetadata = {}) {
    const storage = getStorageInstance();
    const storagePath = buildStoragePath(pathPrefix, file.originalname);
    const fileRef = ref(storage, storagePath);

    await uploadBytes(fileRef, file.buffer, {
        contentType: file.mimetype,
        customMetadata
    });

    const downloadUrl = await getDownloadURL(fileRef);

    return {
        storagePath,
        downloadUrl
    };
}

function isFirebaseStorageUrl(url) {
    if (typeof url !== "string" || url.trim() === "") {
        return false;
    }

    const bucket = process.env.FIREBASE_STORAGE_BUCKET || "";

    return (
        url.startsWith("gs://") ||
        url.includes("firebasestorage.googleapis.com") ||
        (bucket !== "" && url.includes(bucket))
    );
}

async function uploadImageForTool(toolId, file) {
    return uploadImage(`tools/${toolId}`, file, { toolId });
}

async function uploadImageForStorageBox(boxId, file) {
    return uploadImage(`storage-boxes/${boxId}`, file, { boxId });
}

async function uploadImageForStorageProduct(boxId, productId, file) {
    return uploadImage(`storage-boxes/${boxId}/products/${productId}`, file, {
        boxId,
        productId
    });
}

async function deleteImageByUrl(fileUrl) {
    if (!isFirebaseStorageUrl(fileUrl)) {
        return false;
    }

    try {
        const storage = getStorageInstance();
        const fileRef = ref(storage, fileUrl);
        await deleteObject(fileRef);
        return true;
    } catch (error) {
        console.warn("Could not delete previous Firebase Storage image", error);
        return false;
    }
}

module.exports = {
    uploadImageForTool,
    uploadImageForStorageBox,
    uploadImageForStorageProduct,
    deleteImageByUrl
};
