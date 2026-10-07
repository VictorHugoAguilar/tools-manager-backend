const tagService = require("../services/tagService");
const { validateTagPayload } = require("../validators/tagValidator");

function getAllTags(req, res) {
    return handleControllerError(res, async () => {
        const tags = await tagService.findAll();
        return res.json(tags);
    });
}

function getTagById(req, res) {
    return handleControllerError(res, async () => {
        const tag = await tagService.findById(req.params.id);

        if (!tag) {
            return res.status(404).json({ message: "Tag not found" });
        }

        return res.json(tag);
    });
}

function createTag(req, res) {
    return handleControllerError(res, async () => {
        const validation = validateTagPayload(req.body);

        if (!validation.isValid) {
            return res.status(400).json({
                message: "Validation error",
                errors: validation.errors
            });
        }

        const tag = await tagService.create(validation.data);
        return res.status(201).json(tag);
    });
}

function updateTag(req, res) {
    return handleControllerError(res, async () => {
        const validation = validateTagPayload(req.body);

        if (!validation.isValid) {
            return res.status(400).json({
                message: "Validation error",
                errors: validation.errors
            });
        }

        const tag = await tagService.update(req.params.id, validation.data);

        if (!tag) {
            return res.status(404).json({ message: "Tag not found" });
        }

        if (tag.duplicated) {
            return res.status(409).json({
                message: "Tag already exists",
                errors: [`tag "${tag.name}" already exists`]
            });
        }

        return res.json(tag);
    });
}

function deleteTag(req, res) {
    return handleControllerError(res, async () => {
        const deleted = await tagService.remove(req.params.id);

        if (!deleted) {
            return res.status(404).json({ message: "Tag not found" });
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
    getAllTags,
    getTagById,
    createTag,
    updateTag,
    deleteTag
};
