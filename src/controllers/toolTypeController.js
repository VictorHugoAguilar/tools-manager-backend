const toolTypeService = require("../services/toolTypeService");
const { validateToolTypePayload } = require("../validators/toolTypeValidator");

function getAllToolTypes(req, res) {
    return handleControllerError(res, async () => {
        const toolTypes = await toolTypeService.findAll();
        return res.json(toolTypes);
    });
}

function getToolTypeById(req, res) {
    return handleControllerError(res, async () => {
        const toolType = await toolTypeService.findById(req.params.id);

        if (!toolType) {
            return res.status(404).json({ message: "Tool type not found" });
        }

        return res.json(toolType);
    });
}

function createToolType(req, res) {
    return handleControllerError(res, async () => {
        const validation = validateToolTypePayload(req.body);

        if (!validation.isValid) {
            return res.status(400).json({
                message: "Validation error",
                errors: validation.errors
            });
        }

        const toolType = await toolTypeService.create(validation.data);
        return res.status(201).json(toolType);
    });
}

function updateToolType(req, res) {
    return handleControllerError(res, async () => {
        const validation = validateToolTypePayload(req.body);

        if (!validation.isValid) {
            return res.status(400).json({
                message: "Validation error",
                errors: validation.errors
            });
        }

        const toolType = await toolTypeService.update(req.params.id, validation.data);

        if (!toolType) {
            return res.status(404).json({ message: "Tool type not found" });
        }

        return res.json(toolType);
    });
}

function deleteToolType(req, res) {
    return handleControllerError(res, async () => {
        const deleted = await toolTypeService.remove(req.params.id);

        if (!deleted) {
            return res.status(404).json({ message: "Tool type not found" });
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
    getAllToolTypes,
    getToolTypeById,
    createToolType,
    updateToolType,
    deleteToolType
};
