const {
    deleteImageByUrl,
    uploadImageForUser
} = require("./toolImageStorageService");
const { getProfile, updateProfile } = require("./userService");

function validateUserAvatar(file) {
    if (!file) {
        throw Object.assign(new Error("Selecciona una imagen."), { statusCode: 400 });
    }

    const bytes = file.buffer;
    const isJpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    const isPng = bytes.length >= 8 &&
        bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const isWebp = bytes.length >= 12 &&
        bytes.toString("ascii", 0, 4) === "RIFF" &&
        bytes.toString("ascii", 8, 12) === "WEBP";
    const validMime = ["image/jpeg", "image/png", "image/webp"].includes(file.mimetype);

    if (!validMime || !(isJpeg || isPng || isWebp)) {
        throw Object.assign(new Error("El archivo debe ser una imagen JPEG, PNG o WebP válida."), {
            statusCode: 400
        });
    }
}

async function updateUserAvatar(uid, file) {
    validateUserAvatar(file);
    const existing = await getProfile(uid);
    if (!existing) {
        throw Object.assign(new Error("Usuario no encontrado."), { statusCode: 404 });
    }

    const uploaded = await uploadImageForUser(uid, file);
    const updated = await updateProfile(uid, { profileImage: uploaded.downloadUrl });
    if (!updated) {
        await deleteImageByUrl(uploaded.downloadUrl);
        throw Object.assign(new Error("No se pudo actualizar la imagen de perfil."), { statusCode: 500 });
    }
    if (existing.profileImage) await deleteImageByUrl(existing.profileImage);
    return updated;
}

module.exports = {
    updateUserAvatar,
    validateUserAvatar
};
