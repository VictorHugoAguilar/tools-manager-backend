const {
    findAll,
    findById,
    create,
    update,
    updateState,
    updateImageUrl,
    remove
} = require("../services/toolService");
const {
    deleteImageByUrl,
    uploadImageForTool
} = require("../services/toolImageStorageService");
const {
    validateToolPayload,
    validateStatePayload,
    buildToolQueryOptions
} = require("../validators/toolValidator");

function getAllTools(req, res) {
    return handleControllerError(res, async () => {
        const queryOptions = buildToolQueryOptions(req.query);

        if (!queryOptions.isValid) {
            return res.status(400).json({
                message: "Validation error",
                errors: queryOptions.errors
            });
        }

        const tools = await findAll(queryOptions.data);
        return res.json(tools);
    });
}

function getToolById(req, res) {
    return handleControllerError(res, async () => {
        const tool = await findById(req.params.id);

        if (!tool) {
            return res.status(404).json({ message: "Tool not found" });
        }

        return res.json(tool);
    });
}

function createTool(req, res) {
    return handleControllerError(res, async () => {
        const validation = validateToolPayload(req.body, { requireId: false });

        if (!validation.isValid) {
            return res.status(400).json({
                message: "Validation error",
                errors: validation.errors
            });
        }

        const tool = await create(validation.data);
        return res.status(201).json(tool);
    });
}

function updateTool(req, res) {
    return handleControllerError(res, async () => {
        const validation = validateToolPayload(req.body, { requireId: true });

        if (!validation.isValid) {
            return res.status(400).json({
                message: "Validation error",
                errors: validation.errors
            });
        }

        const updatedTool = await update(req.params.id, validation.data);

        if (!updatedTool) {
            return res.status(404).json({ message: "Tool not found" });
        }

        return res.json(updatedTool);
    });
}

function updateToolState(req, res) {
    return handleControllerError(res, async () => {
        const validation = validateStatePayload(req.body);

        if (!validation.isValid) {
            return res.status(400).json({
                message: "Validation error",
                errors: validation.errors
            });
        }

        const updatedTool = await updateState(req.params.id, validation.data.state);

        if (!updatedTool) {
            return res.status(404).json({ message: "Tool not found" });
        }