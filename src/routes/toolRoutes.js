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
const {
    getToolRepairs,
    getToolRepairById,
    createToolRepair,
    updateToolRepair,
    deleteToolRepair
} = require("../controllers/repairHistoryController");

const toolRouter = express.Router();

toolRouter.get("/", getAllTools);
toolRouter.get("/:id", getToolById);
toolRouter.get("/:toolId/repairs", getToolRepairs);
toolRouter.get("/:toolId/repairs/:repairId", getToolRepairById);
toolRouter.post("/", createTool);
toolRouter.post("/:toolId/repairs", createToolRepair);
toolRouter.put("/:id", updateTool);
toolRouter.put("/:toolId/repairs/:repairId", updateToolRepair);
toolRouter.patch("/:id/state", updateToolState);
toolRouter.post("/:id/image", uploadToolImage, uploadToolImageController);
toolRouter.delete("/:toolId/repairs/:repairId", deleteToolRepair);
toolRouter.delete("/:id/image", deleteToolImage);
toolRouter.delete("/:id", deleteTool);

module.exports = { toolRouter };
