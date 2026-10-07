const express = require("express");
const {
    getAllTags,
    getTagById,
    createTag,
    updateTag,
    deleteTag
} = require("../controllers/tagController");

const tagRouter = express.Router();

tagRouter.get("/", getAllTags);
tagRouter.get("/:id", getTagById);
tagRouter.post("/", createTag);
tagRouter.put("/:id", updateTag);
tagRouter.delete("/:id", deleteTag);

module.exports = { tagRouter };
