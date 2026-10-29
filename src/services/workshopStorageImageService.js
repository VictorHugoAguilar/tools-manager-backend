const { deleteObject, getDownloadURL, ref, uploadBytes } = require("firebase/storage");
const { getStorageInstance } = require("../config/database");

async function uploadMaterialImage(materialId, file) {
    const storage = getStorageInstance();
    const storagePath = `workshop-storage/materials/${materialId}/${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9._-]/g, "-")}`;
    const imageRef = ref(storage, storagePath);
    await uploadBytes(imageRef, file.buffer, { contentType: file.mimetype });

    return {
        imageUrl: await getDownloadURL(imageRef),
        imagePath: storagePath
    };
}

async function deleteMaterialImage(storagePath) {
    if (storagePath) {
        await deleteObject(ref(getStorageInstance(), storagePath));
    }
}

module.exports = { deleteMaterialImage, uploadMaterialImage };
