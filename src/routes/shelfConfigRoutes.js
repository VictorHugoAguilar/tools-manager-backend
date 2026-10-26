const express = require("express");
const {
    getShelfConfig,
    updateShelfConfig
} = require("../controllers/shelfConfigController");

const shelfConfigRouter = express.Router();

shelfConfigRouter.get("/", getShelfConfig);
shelfConfigRouter.put("/", updateShelfConfig);

module.exports = { shelfConfigRouter };

