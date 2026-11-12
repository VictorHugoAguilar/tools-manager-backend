const express = require("express");
const { randomUUID } = require("node:crypto");
const { getFirestore, Timestamp } = require("firebase-admin/firestore");
const { getAdminApp } = require("../config/firebaseAdmin");
const { requireAuthenticated, requirePermission } = require("../middleware/authMiddleware");

const TOOL_ACTIONS = ["tool.created", "tool.updated", "tool.state.updated", "tool.image.updated", "tool.deleted"];
const REPAIR_ACTIONS = ["repair.created", "repair.updated", "repair.deleted"];
const LIMIT = 25;

function createToolTracingRouter({ getDatabase = () => getFirestore(getAdminApp()) } = {}) {
    const router = express.Router();
    router.use(requireAuthenticated, requirePermission("tracing:app"));
    router.get("/:toolId/history", async (req, res, next) => {
        const { toolId } = req.params;
        if (!toolId || toolId.length > 128 || /[.#$/\[\]\u0000-\u001f\u007f]/.test(toolId) ||
            Object.keys(req.query).length) {
            return res.status(400).json({ message: "El identificador de herramienta no es válido." });
        }
        try {
            const db = getDatabase();
            await db.collection("auditEvents").doc(randomUUID()).create({
                schemaVersion: 1, action: "tracing.tool-history.accessed",
                actorId: req.authUser.id, occurredAt: Timestamp.now()
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
            const events = db.collection("auditEvents");
            const [tools, repairs] = await Promise.all([
                events.where("targetId", "==", toolId).where("action", "in", TOOL_ACTIONS)
                    .orderBy("occurredAt", "desc").limit(LIMIT).get(),
                events.where("toolId", "==", toolId).where("action", "in", REPAIR_ACTIONS)
                    .orderBy("occurredAt", "desc").limit(LIMIT).get()
            ]);
            const mapped = [...tools.docs, ...repairs.docs].map((doc) => {
                const data = doc.data();
                return {
                    eventId: doc.id, action: data.action, actorId: data.actorId,
                    targetId: data.targetId, occurredAt: data.occurredAt
                };
            }).sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || b.eventId.localeCompare(a.eventId))
                .slice(0, LIMIT);
            res.set("Cache-Control", "no-store");
            return res.json({ events: mapped, limit: LIMIT });
        } catch (error) {
            return next(error);
        }
    });
    return router;
}

module.exports = { createToolTracingRouter, toolTracingRouter: createToolTracingRouter() };
