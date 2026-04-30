const technicianService = require("../services/technicianService");
const { validateTechnicianPayload } = require("../validators/technicianValidator");

function getAllTechnicians(req, res) {
    return handleControllerError(res, async () => {
        const technicians = await technicianService.findAll();
        return res.json(technicians);
    });
}

function getTechnicianById(req, res) {
    return handleControllerError(res, async () => {
        const technician = await technicianService.findById(req.params.id);

        if (!technician) {
            return res.status(404).json({ message: "Technician not found" });
        }

        return res.json(technician);
    });
}

function createTechnician(req, res) {
    return handleControllerError(res, async () => {
        const validation = validateTechnicianPayload(req.body);

        if (!validation.isValid) {
            return res.status(400).json({
                message: "Validation error",
                errors: validation.errors
            });
        }

        const technician = await technicianService.create(validation.data);
        return res.status(201).json(technician);
    });
}

function updateTechnician(req, res) {
    return handleControllerError(res, async () => {
        const validation = validateTechnicianPayload(req.body);

        if (!validation.isValid) {
            return res.status(400).json({
                message: "Validation error",
                errors: validation.errors
            });
        }

        const technician = await technicianService.update(req.params.id, validation.data);

        if (!technician) {
            return res.status(404).json({ message: "Technician not found" });
        }

        return res.json(technician);
    });
}

function deleteTechnician(req, res) {
    return handleControllerError(res, async () => {
        const deleted = await technicianService.remove(req.params.id);

        if (!deleted) {
            return res.status(404).json({ message: "Technician not found" });
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
    getAllTechnicians,
    getTechnicianById,
    createTechnician,
    updateTechnician,
    deleteTechnician
};
