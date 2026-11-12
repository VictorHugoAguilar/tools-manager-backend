const express = require("express");
const controller = require("../controllers/workshopStorageController");
const { uploadWorkshopStorageImage } = require("../middleware/workshopStorageUploadMiddleware");
const { storageReadTelemetry } = require("../middleware/storageReadTelemetry");
const { workshopOperationTelemetry } = require("../middleware/workshopOperationTelemetry");

const workshopStorageRouter = express.Router();
workshopStorageRouter.use(workshopOperationTelemetry());

workshopStorageRouter.get("/", storageReadTelemetry("storage.workshop.viewed"), controller.getAll);
workshopStorageRouter.get("/search", storageReadTelemetry("storage.workshop.searched"), controller.search);
workshopStorageRouter.get("/categories", storageReadTelemetry("storage.workshop.categories.viewed"), controller.getMaterialCategories);
workshopStorageRouter.post("/categories", controller.createMaterialCategory);
workshopStorageRouter.delete("/categories/:id", controller.deleteMaterialCategory);

workshopStorageRouter.post("/shelves", controller.createShelf);
workshopStorageRouter.put("/shelves/:id", controller.updateShelf);
workshopStorageRouter.delete("/shelves/:id", controller.deleteShelf);

workshopStorageRouter.post("/levels", controller.createLevel);
workshopStorageRouter.put("/levels/:id", controller.updateLevel);
workshopStorageRouter.delete("/levels/:id", controller.deleteLevel);

workshopStorageRouter.post("/organizers", controller.createOrganizer);
workshopStorageRouter.put("/organizers/:id", controller.updateOrganizer);
workshopStorageRouter.delete("/organizers/:id", controller.deleteOrganizer);

workshopStorageRouter.post("/compartments", controller.createCompartment);
workshopStorageRouter.put("/compartments/:id", controller.updateCompartment);
workshopStorageRouter.delete("/compartments/:id", controller.deleteCompartment);

workshopStorageRouter.post("/materials", controller.createMaterial);
workshopStorageRouter.put("/materials/:id", controller.updateMaterial);
workshopStorageRouter.delete("/materials/:id", controller.deleteMaterial);
workshopStorageRouter.post(
    "/materials/:id/image",
    uploadWorkshopStorageImage,
    controller.uploadMaterialImage
);

module.exports = { workshopStorageRouter };
