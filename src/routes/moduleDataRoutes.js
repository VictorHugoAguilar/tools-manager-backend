const express = require("express");
const { requireModuleWhenEnabled } = require("../middleware/authMiddleware");
const tools = require("../services/toolService");
const technicians = require("../services/technicianService");
const locations = require("../services/locationService");
const toolTypes = require("../services/toolTypeService");
const tags = require("../services/tagService");
const { validateTagPayload } = require("../validators/tagValidator");

const moduleDataRouter = express.Router();
const fields = {
    categories: ["id", "name", "type", "category", "urlSrc", "state", "brand", "model"],
    reports: ["id", "name", "type", "category", "description", "state", "material", "long", "brand", "model"],
    repairs: ["id", "name", "type", "category", "urlSrc", "state", "brand", "model", "serialNumber", "location", "material"]
};

function project(value, keys) {
    return Object.fromEntries(keys.filter((key) => Object.hasOwn(value, key)).map((key) => [key, value[key]]));
}

function handle(handler) {
    return (req, res, next) => Promise.resolve(handler(req, res)).catch(next);
}

for (const moduleId of Object.keys(fields)) {
    moduleDataRouter.get(`/${moduleId}/tools`, requireModuleWhenEnabled(moduleId), handle(async (_req, res) =>
        res.json((await tools.findAll()).map((tool) => project(tool, fields[moduleId])))
    ));
}

moduleDataRouter.get("/repairs/technicians", requireModuleWhenEnabled("repairs"), handle(async (_req, res) =>
    res.json((await technicians.findAll()).map((technician) => project(technician, ["id", "name", "active"])))
));
moduleDataRouter.get("/repairs/locations", requireModuleWhenEnabled("repairs"), handle(async (_req, res) =>
    res.json((await locations.findAll()).map((location) => project(location, ["id", "name"])))
));
moduleDataRouter.get("/tools/locations", requireModuleWhenEnabled("dashboard", "inventory"), handle(async (_req, res) =>
    res.json((await locations.findAll()).map((location) => project(location, ["id", "name"])))
));
moduleDataRouter.get("/tools/types", requireModuleWhenEnabled("dashboard", "inventory"), handle(async (_req, res) =>
    res.json((await toolTypes.findAll()).map((type) => project(type, ["id", "name"])))
));
moduleDataRouter.get("/storage/tags", requireModuleWhenEnabled("storage"), handle(async (_req, res) =>
    res.json((await tags.findAll()).map((tag) => project(tag, ["id", "name"])))
));
moduleDataRouter.post("/storage/tags", requireModuleWhenEnabled("storage"), handle(async (req, res) => {
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body) ||
        Object.keys(req.body).some((key) => key !== "name")) {
        return res.status(400).json({ message: "La etiqueta no es válida." });
    }
    const validation = validateTagPayload({ name: req.body.name, description: "" });
    if (!validation.isValid) return res.status(400).json({ message: "La etiqueta no es válida." });
    const tag = await tags.create(validation.data, req.authUser.id);
    return res.status(201).json(project(tag, ["id", "name"]));
}));
moduleDataRouter.patch("/repairs/tools/:id/location", requireModuleWhenEnabled("repairs"), handle(async (req, res) => {
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body) ||
        Object.keys(req.body).some((key) => key !== "location") ||
        typeof req.body.location !== "string" || !req.body.location.trim() || req.body.location.length > 200) {
        return res.status(400).json({ message: "La ubicación no es válida." });
    }
    const updated = await tools.updateLocation(req.params.id, req.body.location.trim(), req.authUser.id);
    return updated ? res.json(project(updated, fields.repairs)) : res.status(404).json({ message: "Herramienta no encontrada." });
}));

module.exports = { moduleDataRouter };
