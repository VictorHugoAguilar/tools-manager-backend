const locationService = require("../services/locationService");
const { validateLocationPayload } = require("../validators/locationValidator");

function getAllLocations(req, res) {
    return handleControllerError(res, async () => {
        const locations = await locationService.findAll();
        return res.json(locations);
    });
}

function getLocationById(req, res) {
    return handleControllerError(res, async () => {
        const location = await locationService.findById(req.params.id);

        if (!location) {
            return res.status(404).json({ message: "Location not found" });
        }

        return res.json(location);
    });
}

function createLocation(req, res) {
    return handleControllerError(res, async () => {
        const validation = validateLocationPayload(req.body);

        if (!validation.isValid) {
            return res.status(400).json({
                message: "Validation error",
                errors: validation.errors
            });
        }

        const location = await locationService.create(validation.data);
        return res.status(201).json(location);
    });
}

function updateLocation(req, res) {
    return handleControllerError(res, async () => {
        const validation = validateLocationPayload(req.body);

        if (!validation.isValid) {
            return res.status(400).json({
                message: "Validation error",
                errors: validation.errors
            });
        }

        const location = await locationService.update(req.params.id, validation.data);

        if (!location) {
            return res.status(404).json({ message: "Location not found" });
        }

        return res.json(location);
    });
}

function deleteLocation(req, res) {
    return handleControllerError(res, async () => {
        const deleted = await locationService.remove(req.params.id);

        if (!deleted) {
            return res.status(404).json({ message: "Location not found" });
        }

        return res.status(204).send();
    });
}

async function handleControllerError(res, action) {
    try {
        return await action();
    } catch (error) {
        console.error(error);
        return res.status(500).json({
            message: "Internal server error"
        });
    }
}

module.exports = {
    getAllLocations,
    getLocationById,
    createLocation,
    updateLocation,
    deleteLocation
};
