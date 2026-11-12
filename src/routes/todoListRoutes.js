const express = require("express");
const { todoListController } = require("../controllers/todoListController");
const { todoListUploadAttachment } = require("../middleware/todoListUploadMiddleware");
const { todoListStartReminderWorker } = require("../services/todoListService");
const { taskOperationTelemetry } = require("../middleware/taskOperationTelemetry");

const todoListRouter = express.Router();
todoListRouter.use(taskOperationTelemetry("todo"));
todoListRouter.use((_req, _res, next) => {
    todoListStartReminderWorker();
    next();
});

todoListRouter.get("/", todoListController.overview);
todoListRouter.get("/users", todoListController.listUsers);
todoListRouter.get("/projects", todoListController.listProjectsWithOptions);
todoListRouter.post("/projects/reorder", todoListController.reorderProjects);
todoListRouter.get("/projects/:id", todoListController.getProject);
todoListRouter.post("/projects", todoListController.createProject);
todoListRouter.put("/projects/:id", todoListController.updateProject);
todoListRouter.delete("/projects/:id", todoListController.deleteProject);
todoListRouter.patch("/projects/:id/archive", todoListController.archiveProject);
todoListRouter.get("/projects/:id/members", todoListController.listProjectMembers);
todoListRouter.post("/projects/:id/members", todoListController.addProjectMember);
todoListRouter.delete("/projects/:id/members/:userId", todoListController.removeProjectMember);
todoListRouter.get("/projects/:id/sections", todoListController.listSections);
todoListRouter.post("/projects/:id/sections", todoListController.createSection);
todoListRouter.patch("/sections/:id", todoListController.updateSection);
todoListRouter.delete("/sections/:id", todoListController.deleteSection);
todoListRouter.patch("/sections/:id/position", todoListController.setSectionPosition);

todoListRouter.get("/items", todoListController.listItems);
todoListRouter.post("/items", todoListController.createItem);
todoListRouter.get("/items/:id", todoListController.getItem);
todoListRouter.put("/items/:id", todoListController.updateItem);
todoListRouter.delete("/items/:id", todoListController.deleteItem);
todoListRouter.patch("/items/:id/complete", todoListController.completeItem);
todoListRouter.patch("/items/:id/reopen", todoListController.reopenItem);
todoListRouter.patch("/items/:id/archive", todoListController.archiveItem);
todoListRouter.patch("/items/:id/important", todoListController.setItemImportant);
todoListRouter.patch("/items/:id/priority", todoListController.setItemPriority);
todoListRouter.patch("/items/:id/move", todoListController.moveItem);
todoListRouter.patch("/items/:id/position", todoListController.setItemPosition);
todoListRouter.post("/items/:id/duplicate", todoListController.duplicateItem);

todoListRouter.get("/labels", todoListController.listLabels);
todoListRouter.post("/labels", todoListController.createLabel);
todoListRouter.put("/labels/:id", todoListController.updateLabel);
todoListRouter.delete("/labels/:id", todoListController.deleteLabel);

todoListRouter.get("/items/:id/children", todoListController.listChildren);
todoListRouter.post("/items/:id/children", todoListController.createChild);
todoListRouter.put("/children/:id", todoListController.updateChild);
todoListRouter.delete("/children/:id", todoListController.deleteChild);
todoListRouter.get("/items/:id/comments", todoListController.listComments);
todoListRouter.post("/items/:id/comments", todoListController.createComment);
todoListRouter.put("/comments/:id", todoListController.updateComment);
todoListRouter.delete("/comments/:id", todoListController.deleteComment);
todoListRouter.get("/items/:id/attachments", todoListController.listAttachments);
todoListRouter.post("/items/:id/attachments", todoListUploadAttachment, todoListController.createAttachment);
todoListRouter.delete("/attachments/:id", todoListController.deleteAttachment);
todoListRouter.get("/items/:id/reminders", todoListController.listReminders);
todoListRouter.post("/items/:id/reminders", todoListController.createReminder);
todoListRouter.put("/reminders/:id", todoListController.updateReminder);
todoListRouter.delete("/reminders/:id", todoListController.deleteReminder);
todoListRouter.get("/notifications", todoListController.listNotifications);
todoListRouter.patch("/notifications/:id/read", todoListController.readNotification);
todoListRouter.get("/:id", todoListController.getProject);
todoListRouter.put("/:id", todoListController.updateProject);
todoListRouter.delete("/:id", todoListController.deleteProject);
todoListRouter.patch("/:id/archive", todoListController.archiveProject);

module.exports = { todoListRouter };
