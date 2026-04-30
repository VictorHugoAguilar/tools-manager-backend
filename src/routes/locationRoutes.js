const express = require("express");
const {
    getAllLocations,
    getLocationById,
    createLocation,
    updateLocation,
    deleteLocation
} = require("../controllers/locationController");

const locationRouter = express.Router();

locationRouter.get("/", getAllLocations);
locationRouter.get("/:id", getLocationById);
locationRouter.post("/", createLocation);
locationRouter.put("/:id", updateLocation);
locationRouter.delete("/:id", deleteLocation);

module.exports = { locationRouter };
