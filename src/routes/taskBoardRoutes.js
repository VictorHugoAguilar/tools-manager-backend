const express = require("express");
const { taskBoardController } = require("../controllers/taskBoardController");
const { uploadTaskAttachment } = require("../middleware/taskBoardUploadMiddleware");
const { taskOperationTelemetry } = require("../middleware/taskOperationTelemetry");

const taskBoardRouter = express.Router();
taskBoardRouter.use(taskOperationTelemetry("board"));

taskBoardRouter.get("/", taskBoardController.getBoard);
taskBoardRouter.post("/columns", taskBoardController.createColumn);
taskBoardRouter.put("/columns/reorder", taskBoardController.reorderColumns);
taskBoardRouter.patch("/columns/:id", taskBoardController.updateColumn);
taskBoardRouter.delete("/columns/:id", taskBoardController.deleteColumn);

taskBoardRouter.post("/tasks", taskBoardController.createTask);
taskBoardRouter.patch("/tasks/:id", taskBoardController.updateTask);
taskBoardRouter.post("/tasks/:id/move", taskBoardController.moveTask);
taskBoardRouter.delete("/tasks/:id", taskBoardController.deleteTask);
taskBoardRouter.post("/tasks/:id/comments", taskBoardController.addComment);
taskBoardRouter.put("/tasks/:id/comments/:commentId", taskBoardController.updateComment);
taskBoardRouter.delete("/tasks/:id/comments/:commentId", taskBoardController.deleteComment);
taskBoardRouter.post("/tasks/:id/attachments", uploadTaskAttachment, taskBoardController.addAttachment);
taskBoardRouter.delete(
    "/tasks/:id/attachments/:attachmentId",
    taskBoardController.removeAttachment
);

taskBoardRouter.post("/labels", taskBoardController.createLabel);
taskBoardRouter.patch("/labels/:id", taskBoardController.updateLabel);
taskBoardRouter.delete("/labels/:id", taskBoardController.deleteLabel);

module.exports = { taskBoardRouter };
