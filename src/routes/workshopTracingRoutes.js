const express = require("express");
const { randomUUID } = require("node:crypto");
const { getFirestore, Timestamp } = require("firebase-admin/firestore");
const { getAdminApp } = require("../config/firebaseAdmin");
const { requireAuthenticated, requirePermission } = require("../middleware/authMiddleware");

const ACTIONS = ["shelves", "levels", "organizers", "compartments", "materials"]
    .flatMap((collection) => ["created", "updated", "deleted"].map((change) => `workshop.${collection}.${change}`))
    .concat("workshop.materials.image.updated", "workshop.category.created", "workshop.category.deleted");
const LIMIT = 25;

function createWorkshopTracingRouter({ getDatabase = () => getFirestore(getAdminApp()) } = {}) {
    const router = express.Router();
    router.use(requireAuthenticated, requirePermission("tracing:app"));
    router.get("/:targetId/history", async (req, res, next) => {
        const { targetId } = req.params;
        if (!targetId || targetId.length > 128 || /[.#$/\[\]\u0000-\u001f\u007f]/.test(targetId) ||
            Object.keys(req.query).length) {
            return res.status(400).json({ message: "La consulta de trazabilidad no es válida." });
        }
        try {
            const db = getDatabase();
            await db.collection("auditEvents").doc(randomUUID()).create({
                schemaVersion: 1, action: "tracing.workshop-history.accessed",
                actorId: req.authUser.id, targetId, occurredAt: Timestamp.now()
            });
            const snapshot = await db.collection("auditEvents")
                .where("targetId", "==", targetId).where("action", "in", ACTIONS)
                .orderBy("occurredAt", "desc").limit(LIMIT).get();
            const events = snapshot.docs.map((doc) => {
                const data = doc.data();
                return {
                    eventId: doc.id, action: data.action, actorId: data.actorId,
                    targetId: data.targetId, occurredAt: data.occurredAt
                };
            });
            res.set("Cache-Control", "no-store");
            return res.json({ events, limit: LIMIT });
        } catch (error) {
            return next(error);
        }
    });
    router.use((error, _req, res, next) => {
        const detail = `${typeof error.details === "string" ? error.details : ""} ${typeof error.message === "string" ? error.message : ""}`;
        if ((error.code === 9 || error.code === "FAILED_PRECONDITION") &&
            /(?:requires an index|index.*(?:is not ready|is currently building))/i.test(detail)) {
            console.error("La consulta de trazabilidad necesita un índice de Firestore:", error);
            return res.status(503).json({ code: "TRACING_INDEX_UNAVAILABLE", message: "Faltan índices de Firestore o aún se están creando." });
        }
        return next(error);
    });
    return router;
}

module.exports = { createWorkshopTracingRouter, workshopTracingRouter: createWorkshopTracingRouter() };
