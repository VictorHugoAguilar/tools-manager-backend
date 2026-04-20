const express = require("express");
const { uploadToolImage } = require("../middleware/uploadMiddleware");
const {
    getAllTools,
    getToolById,
    createTool,
    updateTool,
    updateToolState,
    uploadToolImage: uploadToolImageController,
    deleteToolImage,
    deleteTool
} = require("../controllers/toolController");

const toolRouter = express.Router();

toolRouter.get("/", getAllTools);
toolRouter.get("/:id", getToolById);
toolRouter.post("/", createTool);
toolRouter.put("/:id", updateTool);
toolRouter.patch("/:id/state", updateToolState);
toolRouter.post("/:id/image", uploadToolImage, uploadToolImageController);
toolRouter.delete("/:id/image", deleteToolImage);
toolRouter.delete("/:id", deleteTool);

module.exports = { toolRouter };