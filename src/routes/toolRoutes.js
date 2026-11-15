const express = require("express");
const { uploadToolImage } = require("../middleware/uploadMiddleware");
const { toolOperationTelemetry } = require("../middleware/toolOperationTelemetry");
const { requireModuleWhenEnabled } = require("../middleware/authMiddleware");
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
const toolAccess = requireModuleWhenEnabled("dashboard", "inventory");
const repairAccess = requireModuleWhenEnabled("repairs");

toolRouter.get("/", toolAccess, getAllTools);
toolRouter.get("/:id", toolAccess, getToolById);
toolRouter.get("/:toolId/repairs", repairAccess, getToolRepairs);
toolRouter.get("/:toolId/repairs/:repairId", repairAccess, getToolRepairById);
toolRouter.post("/", toolAccess, toolOperationTelemetry("tools.create.completed"), createTool);
toolRouter.post("/:toolId/repairs", repairAccess, toolOperationTelemetry("tools.repair.create.completed"), createToolRepair);
toolRouter.put("/:id", toolAccess, toolOperationTelemetry("tools.update.completed"), updateTool);
toolRouter.put("/:toolId/repairs/:repairId", repairAccess, toolOperationTelemetry("tools.repair.update.completed"), updateToolRepair);
toolRouter.patch("/:id/state", toolAccess, toolOperationTelemetry("tools.state.completed"), updateToolState);
toolRouter.post("/:id/image", toolAccess, toolOperationTelemetry("tools.image.upload.completed"), uploadToolImage, uploadToolImageController);
toolRouter.delete("/:toolId/repairs/:repairId", repairAccess, toolOperationTelemetry("tools.repair.delete.completed"), deleteToolRepair);
toolRouter.delete("/:id/image", toolAccess, toolOperationTelemetry("tools.image.delete.completed"), deleteToolImage);
toolRouter.delete("/:id", toolAccess, toolOperationTelemetry("tools.delete.completed"), deleteTool);

module.exports = { toolRouter };
