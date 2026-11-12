const express = require("express");
const { randomUUID } = require("node:crypto");
const { getFirestore, Timestamp } = require("firebase-admin/firestore");
const { getAdminApp } = require("../config/firebaseAdmin");
const { requireAuthenticated, requirePermission } = require("../middleware/authMiddleware");

const ACTIONS = {
    board: ["task_board.task.created", "task_board.task.updated", "task_board.task.moved", "task_board.task.deleted"],
    todo: [
        "todo.item.created", "todo.item.updated", "todo.item.moved", "todo.item.completed",
        "todo.item.reopened", "todo.item.archived", "todo.item.unarchived",
        "todo.item.importance.updated", "todo.item.priority.updated", "todo.item.reordered"
    ]
};
const LIMIT = 25;

function createTaskTracingRouter({ getDatabase = () => getFirestore(getAdminApp()) } = {}) {
    const router = express.Router();
    router.use(requireAuthenticated, requirePermission("tracing:app"));
    router.get("/:module/:taskId/history", async (req, res, next) => {
        const { module, taskId } = req.params;
        if (!Object.hasOwn(ACTIONS, module) || !taskId || taskId.length > 128 ||
            /[.#$/\[\]\u0000-\u001f\u007f]/.test(taskId) || Object.keys(req.query).length) {
            return res.status(400).json({ message: "La consulta de trazabilidad no es válida." });
        }
        try {
            const db = getDatabase();
            await db.collection("auditEvents").doc(randomUUID()).create({
                schemaVersion: 1, action: "tracing.task-history.accessed",
                actorId: req.authUser.id, targetId: taskId, taskModule: module, occurredAt: Timestamp.now()
            });
            const snapshot = await db.collection("auditEvents")
                .where("targetId", "==", taskId).where("action", "in", ACTIONS[module])
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

module.exports = { createTaskTracingRouter, taskTracingRouter: createTaskTracingRouter() };
