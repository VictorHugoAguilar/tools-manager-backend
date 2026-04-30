const repairHistoryService = require("../services/repairHistoryService");
const technicianService = require("../services/technicianService");
const { findById: findToolById } = require("../services/toolService");
const { validateRepairPayload } = require("../validators/repairHistoryValidator");

function getToolRepairs(req, res) {
    return handleControllerError(res, async () => {
        const tool = await findToolById(req.params.toolId);

        if (!tool) {
            return res.status(404).json({ message: "Tool not found" });
        }

        const repairs = await repairHistoryService.findAllByToolId(req.params.toolId);
        return res.json(repairs);
    });
}

function getToolRepairById(req, res) {
    return handleControllerError(res, async () => {
        const repair = await repairHistoryService.findById(req.params.toolId, req.params.repairId);

        if (!repair) {
            return res.status(404).json({ message: "Repair record not found" });
        }

        return res.json(repair);
    });
}

function createToolRepair(req, res) {
    return handleControllerError(res, async () => {
        const tool = await findToolById(req.params.toolId);

        if (!tool) {
            return res.status(404).json({ message: "Tool not found" });
        }

        const validation = validateRepairPayload(req.body);

        if (!validation.isValid) {
            return res.status(400).json({
                message: "Validation error",
                errors: validation.errors
            });
        }

        const technician = await technicianService.findById(validation.data.technicianId);

        if (!technician) {
            return res.status(400).json({
                message: "Validation error",
                errors: ["technicianId does not reference an existing technician"]
            });
        }

        const repair = await repairHistoryService.create(req.params.toolId, {
            ...validation.data,
            technicianName: technician.name
        });

        return res.status(201).json(repair);
    });
}

function updateToolRepair(req, res) {
    return handleControllerError(res, async () => {
        const tool = await findToolById(req.params.toolId);

        if (!tool) {
            return res.status(404).json({ message: "Tool not found" });
        }

        const validation = validateRepairPayload(req.body);

        if (!validation.isValid) {
            return res.status(400).json({
                message: "Validation error",
                errors: validation.errors
            });
        }

        const technician = await technicianService.findById(validation.data.technicianId);

        if (!technician) {
            return res.status(400).json({
                message: "Validation error",
                errors: ["technicianId does not reference an existing technician"]
            });
        }

        const repair = await repairHistoryService.update(req.params.toolId, req.params.repairId, {
            ...validation.data,
            technicianName: technician.name
        });

        if (!repair) {
            return res.status(404).json({ message: "Repair record not found" });
        }

        return res.json(repair);
    });
}

function deleteToolRepair(req, res) {
    return handleControllerError(res, async () => {
        const deleted = await repairHistoryService.remove(req.params.toolId, req.params.repairId);

        if (!deleted) {
            return res.status(404).json({ message: "Repair record not found" });
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
    getToolRepairs,
    getToolRepairById,
    createToolRepair,
    updateToolRepair,
    deleteToolRepair
};
