const express = require("express");
const {
    getAllToolTypes,
    getToolTypeById,
    createToolType,
    updateToolType,
    deleteToolType
} = require("../controllers/toolTypeController");

const toolTypeRouter = express.Router();

toolTypeRouter.get("/", getAllToolTypes);
toolTypeRouter.get("/:id", getToolTypeById);
toolTypeRouter.post("/", createToolType);
toolTypeRouter.put("/:id", updateToolType);
toolTypeRouter.delete("/:id", deleteToolType);

module.exports = { toolTypeRouter };
