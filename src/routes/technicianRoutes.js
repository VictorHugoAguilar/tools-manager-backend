const express = require("express");
const {
    getAllTechnicians,
    getTechnicianById,
    createTechnician,
    updateTechnician,
    deleteTechnician
} = require("../controllers/technicianController");

const technicianRouter = express.Router();

technicianRouter.get("/", getAllTechnicians);
technicianRouter.get("/:id", getTechnicianById);
technicianRouter.post("/", createTechnician);
technicianRouter.put("/:id", updateTechnician);
technicianRouter.delete("/:id", deleteTechnician);

module.exports = { technicianRouter };
