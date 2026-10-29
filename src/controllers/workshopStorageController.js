const {
    create,
    deleteEntity,
    findAll,
    findEntity,
    searchMaterials,
    updateEntity
} = require("../services/workshopStorageService");
const {
    deleteMaterialImage,
    uploadMaterialImage
} = require("../services/workshopStorageImageService");
const { validateWorkshopStoragePayload } = require("../validators/workshopStorageValidator");
const {
    createMaterialCategory,
    deleteMaterialCategory,
    findAllMaterialCategories
} = require("../services/workshopStorageCategoryService");

function handleError(res, error) {
    console.error(error);
    return res.status(error.statusCode || 500).json({
        message: error.statusCode ? error.message : "Internal server error"
    });
}

function respond(handler) {
    return async (req, res) => {
        try {
            return await handler(req, res);
        } catch (error) {
            return handleError(res, error);
        }
    };
}

function validatePayload(collection, body) {
    const validation = validateWorkshopStoragePayload(collection, body);

    if (!validation.isValid) {
        const error = new Error(validation.errors.join(", "));
        error.statusCode = 400;
        throw error;
    }

    return validation.data;
}

function createRecord(collection) {
    return respond(async (req, res) => {
        const entity = await create(collection, validatePayload(collection, req.body));
        return res.status(201).json(entity);
    });
}

function updateRecord(collection) {
    return respond(async (req, res) => {
        const entity = await updateEntity(collection, req.params.id, validatePayload(collection, req.body));
        return entity
            ? res.json(entity)
            : res.status(404).json({ message: "Record not found" });
    });
}

function deleteRecord(collection) {
    return respond(async (req, res) => {
        const deleted = await deleteEntity(collection, req.params.id);
        return deleted
            ? res.status(204).send()
            : res.status(404).json({ message: "Record not found" });
    });
}

function createWorkshopStorageController() {
    return {
        getAll: respond(async (_req, res) => res.json(await findAll())),
        search: respond(async (req, res) => {
            const query = typeof req.query.q === "string" ? req.query.q : "";
            return res.json(await searchMaterials(query));
        }),
        getMaterialCategories: respond(async (_req, res) => {
            return res.json(await findAllMaterialCategories());
        }),
        createMaterialCategory: respond(async (req, res) => {
            const category = await createMaterialCategory(req.body?.name);
            return res.status(201).json(category);
        }),
        deleteMaterialCategory: respond(async (req, res) => {
            const deleted = await deleteMaterialCategory(req.params.id);
            return deleted
                ? res.status(204).send()
                : res.status(404).json({ message: "Material category not found" });
        }),
        createShelf: createRecord("shelves"),
        updateShelf: updateRecord("shelves"),
        deleteShelf: deleteRecord("shelves"),
        createLevel: createRecord("levels"),
        updateLevel: updateRecord("levels"),
        deleteLevel: deleteRecord("levels"),
        createOrganizer: createRecord("organizers"),
        updateOrganizer: updateRecord("organizers"),
        deleteOrganizer: deleteRecord("organizers"),
        createCompartment: createRecord("compartments"),
        updateCompartment: updateRecord("compartments"),
        deleteCompartment: deleteRecord("compartments"),
        createMaterial: createRecord("materials"),
        updateMaterial: updateRecord("materials"),
        deleteMaterial: respond(async (req, res) => {
            const existing = await findEntity("materials", req.params.id);
            if (!existing) {
                return res.status(404).json({ message: "Record not found" });
            }

            await deleteEntity("materials", req.params.id);
            await deleteMaterialImage(existing.imagePath);
            return res.status(204).send();
        }),
        uploadMaterialImage: respond(async (req, res) => {
            if (!req.file) {
                return res.status(400).json({ message: "An image file is required" });
            }

            const existing = await findEntity("materials", req.params.id);

            if (!existing) {
                return res.status(404).json({ message: "Material not found" });
            }

            const uploaded = await uploadMaterialImage(req.params.id, req.file);

            try {
                const material = await updateEntity("materials", req.params.id, uploaded);
                if (existing.imagePath) {
                    await deleteMaterialImage(existing.imagePath);
                }
                return res.json({ material });
            } catch (error) {
                await deleteMaterialImage(uploaded.imagePath);
                throw error;
            }
        })
    };
}

const controller = createWorkshopStorageController();

module.exports = { ...controller };
