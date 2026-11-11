const express = require("express");
const { uploadImageFile } = require("../middleware/uploadMiddleware");
const { storageReadTelemetry } = require("../middleware/storageReadTelemetry");
const {
    addStorageProduct,
    createStorageBox,
    deleteStorageBox,
    deleteStorageProduct,
    getAllStorageBoxes,
    getStorageBoxById,
    searchStorageProducts,
    uploadStorageBoxImage,
    uploadStorageProductImage,
    updateStorageBox,
    updateStorageProduct
} = require("../controllers/storageBoxController");

const storageBoxRouter = express.Router();

storageBoxRouter.get("/", storageReadTelemetry("storage.boxes.viewed"), getAllStorageBoxes);
storageBoxRouter.get("/search", storageReadTelemetry("storage.boxes.searched"), searchStorageProducts);
storageBoxRouter.get("/:id", storageReadTelemetry("storage.box.viewed"), getStorageBoxById);
storageBoxRouter.post("/", createStorageBox);
storageBoxRouter.post("/:boxId/products", addStorageProduct);
storageBoxRouter.post("/:id/image", uploadImageFile, uploadStorageBoxImage);
storageBoxRouter.post("/:boxId/products/:productId/image", uploadImageFile, uploadStorageProductImage);
storageBoxRouter.put("/:id", updateStorageBox);
storageBoxRouter.put("/:boxId/products/:productId", updateStorageProduct);
storageBoxRouter.delete("/:boxId/products/:productId", deleteStorageProduct);
storageBoxRouter.delete("/:id", deleteStorageBox);

module.exports = { storageBoxRouter };
