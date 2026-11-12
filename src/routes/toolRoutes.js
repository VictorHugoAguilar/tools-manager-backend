const express = require("express");
const { uploadToolImage } = require("../middleware/uploadMiddleware");
const { toolOperationTelemetry } = require("../middleware/toolOperationTelemetry");
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
toolRouter.post("/", toolOperationTelemetry("tools.create.completed"), createTool);
toolRouter.post("/:toolId/repairs", toolOperationTelemetry("tools.repair.create.completed"), createToolRepair);
toolRouter.put("/:id", toolOperationTelemetry("tools.update.completed"), updateTool);
toolRouter.put("/:toolId/repairs/:repairId", toolOperationTelemetry("tools.repair.update.completed"), updateToolRepair);
toolRouter.patch("/:id/state", toolOperationTelemetry("tools.state.completed"), updateToolState);
toolRouter.post("/:id/image", toolOperationTelemetry("tools.image.upload.completed"), uploadToolImage, uploadToolImageController);
toolRouter.delete("/:toolId/repairs/:repairId", toolOperationTelemetry("tools.repair.delete.completed"), deleteToolRepair);
toolRouter.delete("/:id/image", toolOperationTelemetry("tools.image.delete.completed"), deleteToolImage);
toolRouter.delete("/:id", toolOperationTelemetry("tools.delete.completed"), deleteTool);

module.exports = { toolRouter };
