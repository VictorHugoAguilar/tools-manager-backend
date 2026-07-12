const {
    create,
    createProduct,
    findAll,
    findById,
    findProductById,
    remove,
    removeProduct,
    update,
    updateProduct,
    updateImageUrl,
    updateProductImageUrl
} = require("../services/storageBoxService");
const {
    deleteImageByUrl,
    uploadImageForStorageBox,
    uploadImageForStorageProduct
} = require("../services/toolImageStorageService");
const {
    validateStorageBoxPayload,
    validateStorageProductPayload
} = require("../validators/storageBoxValidator");

function getAllStorageBoxes(_req, res) {
    return handleControllerError(res, async () => {
        const boxes = await findAll();
        return res.json(boxes);
    });
}

function getStorageBoxById(req, res) {
    return handleControllerError(res, async () => {
        const box = await findById(req.params.id);

        if (!box) {
            return res.status(404).json({ message: "Storage box not found" });
        }

        return res.json(box);
    });
}

function createStorageBox(req, res) {
    return handleControllerError(res, async () => {
        const validation = validateStorageBoxPayload(req.body, { requireCode: false });

        if (!validation.isValid) {
            return res.status(400).json({
                message: "Validation error",
                errors: validation.errors
            });
        }

        const box = await create(validation.data);
        return res.status(201).json(box);
    });
}

function updateStorageBox(req, res) {
    return handleControllerError(res, async () => {
        const validation = validateStorageBoxPayload(req.body, { requireCode: true });

        if (!validation.isValid) {
            return res.status(400).json({
                message: "Validation error",
                errors: validation.errors
            });
        }

        const updatedBox = await update(req.params.id, validation.data);

        if (!updatedBox) {
            return res.status(404).json({ message: "Storage box not found" });
        }

        return res.json(updatedBox);
    });
}

function deleteStorageBox(req, res) {
    return handleControllerError(res, async () => {
        const deleted = await remove(req.params.id);

        if (!deleted) {
            return res.status(404).json({ message: "Storage box not found" });
        }

        return res.status(204).send();
    });
}

function uploadStorageBoxImage(req, res) {
    return handleControllerError(res, async () => {
        if (!req.file) {
            return res.status(400).json({
                message: "Validation error",
                errors: ["image file is required"]
            });
        }

        const existingBox = await findById(req.params.id);

        if (!existingBox) {
            return res.status(404).json({ message: "Storage box not found" });
        }

        const previousImageUrl = existingBox.imageUrl;
        const uploadedImage = await uploadImageForStorageBox(req.params.id, req.file);
        const updatedBox = await updateImageUrl(req.params.id, uploadedImage.downloadUrl);

        if (previousImageUrl && previousImageUrl !== uploadedImage.downloadUrl) {
            await deleteImageByUrl(previousImageUrl);
        }

        return res.json({
            message: "Box image uploaded successfully",
            box: updatedBox
        });
    });
}

function addStorageProduct(req, res) {
    return handleControllerError(res, async () => {
        const validation = validateStorageProductPayload(req.body);

        if (!validation.isValid) {
            return res.status(400).json({
                message: "Validation error",
                errors: validation.errors
            });
        }

        const product = await createProduct(req.params.boxId, validation.data);

        if (!product) {
            return res.status(404).json({ message: "Storage box not found" });
        }

        return res.status(201).json(product);
    });
}

function updateStorageProduct(req, res) {
    return handleControllerError(res, async () => {
        const validation = validateStorageProductPayload(req.body);

        if (!validation.isValid) {
            return res.status(400).json({
                message: "Validation error",
                errors: validation.errors
            });
        }

        const product = await updateProduct(
            req.params.boxId,
            req.params.productId,
            validation.data
        );

        if (!product) {
            return res.status(404).json({ message: "Storage product not found" });
        }

        return res.json(product);
    });
}

function uploadStorageProductImage(req, res) {
    return handleControllerError(res, async () => {
        if (!req.file) {
            return res.status(400).json({
                message: "Validation error",
                errors: ["image file is required"]
            });
        }

        const box = await findById(req.params.boxId);

        if (!box) {
            return res.status(404).json({ message: "Storage box not found" });
        }

        const existingProduct = await findProductById(req.params.boxId, req.params.productId);

        if (!existingProduct) {
            return res.status(404).json({ message: "Storage product not found" });
        }

        const previousImageUrl = existingProduct.imageUrl;
        const uploadedImage = await uploadImageForStorageProduct(
            req.params.boxId,
            req.params.productId,
            req.file
        );
        const updatedProduct = await updateProductImageUrl(
            req.params.boxId,
            req.params.productId,
            uploadedImage.downloadUrl
        );

        if (previousImageUrl && previousImageUrl !== uploadedImage.downloadUrl) {
            await deleteImageByUrl(previousImageUrl);
        }

        return res.json({
            message: "Product image uploaded successfully",
            product: updatedProduct
        });
    });
}

function deleteStorageProduct(req, res) {
    return handleControllerError(res, async () => {
        const deleted = await removeProduct(req.params.boxId, req.params.productId);

        if (!deleted) {
            return res.status(404).json({ message: "Storage product not found" });
        }

        return res.status(204).send();
    });
}

async function handleControllerError(res, action) {
    try {
        return await action();
    } catch (error) {
        console.error(error);
        const errorCode = String(error?.code || "");

        if (errorCode.startsWith("storage/")) {
            return res.status(502).json({
                message: "Firebase Storage error",
                errors: [error.message || "Could not upload image to Firebase Storage"]
            });
        }

        return res.status(500).json({
            message: "Internal server error"
        });
    }
}

module.exports = {
    getAllStorageBoxes,
    getStorageBoxById,
    createStorageBox,
    updateStorageBox,
    deleteStorageBox,
    uploadStorageBoxImage,
    addStorageProduct,
    updateStorageProduct,
    uploadStorageProductImage,
    deleteStorageProduct
};
