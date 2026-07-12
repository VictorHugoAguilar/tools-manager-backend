const { randomUUID } = require("crypto");
const path = require("path");

let cachedAuthToken = null;

function sanitizeFileName(fileName) {
    return fileName.replace(/[^a-zA-Z0-9._-]/g, "-");
}

function normalizeStorageBucket(value) {
    return String(value || "").replace(/^gs:\/\//, "");
}

function getStorageBucket() {
    const bucket = normalizeStorageBucket(process.env.FIREBASE_STORAGE_BUCKET);

    if (!bucket) {
        throw Object.assign(
            new Error("FIREBASE_STORAGE_BUCKET is required to upload images"),
            { code: "storage/missing-bucket" }
        );
    }

    return bucket;
}

function buildStoragePath(pathPrefix, originalName) {
    const extension = path.extname(originalName || "").toLowerCase();
    const safeExtension = extension || ".bin";
    const uniqueName = `${Date.now()}-${randomUUID()}${safeExtension}`;

    return `${pathPrefix}/${sanitizeFileName(uniqueName)}`;
}

function buildDownloadUrl(bucket, storagePath, downloadToken) {
    return `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/${encodeURIComponent(storagePath)}?alt=media&token=${downloadToken}`;
}

async function readErrorResponse(response) {
    const text = await response.text();

    try {
        const parsed = JSON.parse(text);
        return parsed.error?.message || parsed.message || text;
    } catch {
        return text;
    }
}

async function getAnonymousAuthToken() {
    if (process.env.FIREBASE_STORAGE_AUTH_MODE === "none") {
        return null;
    }

    if (cachedAuthToken && cachedAuthToken.expiresAt > Date.now() + 60_000) {
        return cachedAuthToken.idToken;
    }

    const apiKey = process.env.FIREBASE_API_KEY;

    if (!apiKey) {
        return null;
    }

    const response = await fetch(
        `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${apiKey}`,
        {
            method: "POST",
            headers: {
                "content-type": "application/json"
            },
            body: JSON.stringify({ returnSecureToken: true })
        }
    );

    if (!response.ok) {
        return null;
    }

    const payload = await response.json();
    const expiresInMs = Number(payload.expiresIn || 3600) * 1000;
    cachedAuthToken = {
        idToken: payload.idToken,
        expiresAt: Date.now() + expiresInMs
    };

    return cachedAuthToken.idToken;
}

async function requestFirebaseStorage(url, options = {}) {
    const idToken = await getAnonymousAuthToken();
    const headers = {
        ...(options.headers || {})
    };

    if (idToken) {
        headers.authorization = `Bearer ${idToken}`;
    }

    return fetch(url, {
        ...options,
        headers
    });
}

function buildUploadMetadataHeaders(customMetadata, downloadToken) {
    return Object.entries({
        ...customMetadata,
        firebaseStorageDownloadTokens: downloadToken
    }).reduce((headers, [key, value]) => ({
        ...headers,
        [`x-goog-meta-${key}`]: String(value)
    }), {});
}

async function uploadImage(pathPrefix, file, customMetadata = {}) {
    const bucket = getStorageBucket();
    const storagePath = buildStoragePath(pathPrefix, file.originalname);
    const downloadToken = randomUUID();
    const uploadUrl = `https://firebasestorage.googleapis.com/v0/b/${bucket}/o?uploadType=media&name=${encodeURIComponent(storagePath)}`;
    const response = await requestFirebaseStorage(uploadUrl, {
        method: "POST",
        headers: {
            "content-type": file.mimetype,
            "content-length": String(file.buffer.length),
            ...buildUploadMetadataHeaders(customMetadata, downloadToken)
        },
        body: file.buffer
    });

    if (!response.ok) {
        const errorMessage = await readErrorResponse(response);
        throw Object.assign(
            new Error(`Firebase Storage upload failed (${response.status}): ${errorMessage}`),
            { code: "storage/upload-failed" }
        );
    }

    return {
        storagePath,
        downloadUrl: buildDownloadUrl(bucket, storagePath, downloadToken)
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
        const bucket = getStorageBucket();
        const storagePath = extractStoragePathFromUrl(fileUrl, bucket);

        if (!storagePath) {
            return false;
        }

        const deleteUrl = `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/${encodeURIComponent(storagePath)}`;
        const response = await requestFirebaseStorage(deleteUrl, {
            method: "DELETE"
        });

        return response.ok || response.status === 404;
    } catch (error) {
        console.warn("Could not delete previous Firebase Storage image", error);
        return false;
    }
}

function extractStoragePathFromUrl(fileUrl, bucket) {
    if (fileUrl.startsWith("gs://")) {
        return fileUrl.replace(`gs://${bucket}/`, "");
    }

    const match = fileUrl.match(/\/o\/([^?]+)/);

    if (!match) {
        return null;
    }

    return decodeURIComponent(match[1]);
}

module.exports = {
    uploadImageForTool,
    uploadImageForStorageBox,
    uploadImageForStorageProduct,
    deleteImageByUrl
};
