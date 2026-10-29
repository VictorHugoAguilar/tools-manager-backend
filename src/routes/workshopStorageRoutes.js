const express = require("express");
const controller = require("../controllers/workshopStorageController");
const { uploadWorkshopStorageImage } = require("../middleware/workshopStorageUploadMiddleware");

const workshopStorageRouter = express.Router();

workshopStorageRouter.get("/", controller.getAll);
workshopStorageRouter.get("/search", controller.search);

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
