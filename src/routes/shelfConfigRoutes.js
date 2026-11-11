const express = require("express");
const { storageReadTelemetry } = require("../middleware/storageReadTelemetry");
const {
    getShelfConfig,
    updateShelfConfig
} = require("../controllers/shelfConfigController");

const shelfConfigRouter = express.Router();

shelfConfigRouter.get("/", storageReadTelemetry("storage.shelf_config.viewed"), getShelfConfig);
shelfConfigRouter.put("/", updateShelfConfig);

module.exports = { shelfConfigRouter };
