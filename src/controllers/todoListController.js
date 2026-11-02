const todoList = require("../services/todoListService");

function todoListHandle(handler) {
    return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

const todoListController = {
    overview: todoListHandle(async (req, res) =>
        res.json(await todoList.todoListGetOverview(req.authUser.id, req.query.timeZone))),
    listProjectsWithOptions: todoListHandle(async (req, res) =>
        res.json({
            projects: await todoList.todoListListProjects(
                req.authUser.id,
                req.query.includeArchived === "true"
            )
        })),
    listProjects: todoListHandle(async (req, res) =>
        res.json({ projects: await todoList.todoListListProjects(req.authUser.id, req.query.includeArchived === "true") })),
    getProject: todoListHandle(async (req, res) =>
        res.json({ project: await todoList.todoListGetProject(req.params.id, req.authUser.id) })),
    createProject: todoListHandle(async (req, res) =>
        res.status(201).json({ project: await todoList.todoListCreateProject(req.body, req.authUser.id) })),
    updateProject: todoListHandle(async (req, res) =>
        res.json({ project: await todoList.todoListUpdateProject(req.params.id, req.body, req.authUser.id) })),
    deleteProject: todoListHandle(async (req, res) => {
        await todoList.todoListDeleteProject(req.params.id, req.authUser.id);
        return res.status(204).send();
    }),
    archiveProject: todoListHandle(async (req, res) =>
        res.json({ project: await todoList.todoListArchiveProject(req.params.id, req.body?.isArchived, req.authUser.id) })),
    reorderProjects: todoListHandle(async (req, res) =>
        res.json({ projects: await todoList.todoListReorderProjects(req.body?.ids, req.authUser.id) })),

    listProjectMembers: todoListHandle(async (req, res) =>
        res.json({ members: await todoList.todoListGetMembers(req.params.id, req.authUser.id) })),
    addProjectMember: todoListHandle(async (req, res) =>
        res.status(201).json({
            member: await todoList.todoListAddMember(
                req.params.id,
                req.body?.userId,
                req.body?.role,
                req.authUser.id
            )
        })),
    removeProjectMember: todoListHandle(async (req, res) => {
        await todoList.todoListRemoveMember(req.params.id, req.params.userId, req.authUser.id);
        return res.status(204).send();
    }),
    listUsers: todoListHandle(async (_req, res) =>
        res.json({ users: await todoList.todoListGetUsers() })),

    listSections: todoListHandle(async (req, res) =>
        res.json({ sections: await todoList.todoListListSections(req.params.id, req.authUser.id) })),
    createSection: todoListHandle(async (req, res) =>
        res.status(201).json({
            section: await todoList.todoListCreateSection(req.params.id, req.body, req.authUser.id)
        })),
    updateSection: todoListHandle(async (req, res) =>
        res.json({ section: await todoList.todoListUpdateSection(req.params.id, req.body, req.authUser.id) })),
    deleteSection: todoListHandle(async (req, res) => {
        await todoList.todoListDeleteSection(req.params.id, req.authUser.id);
        return res.status(204).send();
    }),
    setSectionPosition: todoListHandle(async (req, res) =>
        res.json({
            sections: await todoList.todoListSetSectionPosition(
                req.params.id,
                req.body?.position,
                req.authUser.id
            )
        })),

    listItems: todoListHandle(async (req, res) =>
        res.json(await todoList.todoListListItems(req.query, req.authUser.id))),
    getItem: todoListHandle(async (req, res) =>
        res.json({ item: await todoList.todoListGetItem(req.params.id, req.authUser.id) })),
    createItem: todoListHandle(async (req, res) =>
        res.status(201).json({ item: await todoList.todoListCreateItem(req.body, req.authUser.id) })),
    updateItem: todoListHandle(async (req, res) =>
        res.json({ item: await todoList.todoListUpdateItem(req.params.id, req.body, req.authUser.id) })),
    deleteItem: todoListHandle(async (req, res) => {
        await todoList.todoListDeleteItem(req.params.id, req.authUser.id);
        return res.status(204).send();
    }),
    completeItem: todoListHandle(async (req, res) =>
        res.json({ item: await todoList.todoListSetItemStatus(req.params.id, "completed", req.authUser.id) })),
    reopenItem: todoListHandle(async (req, res) =>
        res.json({ item: await todoList.todoListSetItemStatus(req.params.id, "pending", req.authUser.id) })),
    archiveItem: todoListHandle(async (req, res) =>
        res.json({
            item: await todoList.todoListSetItemArchive(req.params.id, req.body?.isArchived, req.authUser.id)
        })),
    setItemImportant: todoListHandle(async (req, res) =>
        res.json({
            item: await todoList.todoListSetItemImportant(req.params.id, req.body?.isImportant, req.authUser.id)
        })),
    setItemPriority: todoListHandle(async (req, res) =>
        res.json({ item: await todoList.todoListSetItemPriority(req.params.id, req.body?.priority, req.authUser.id) })),
    moveItem: todoListHandle(async (req, res) =>
        res.json({
            item: await todoList.todoListMoveItem(
                req.params.id,
                req.body?.todoListId,
                req.body?.sectionId,
                req.authUser.id,
                req.body?.position
            )
        })),
    setItemPosition: todoListHandle(async (req, res) =>
        res.json({
            item: await todoList.todoListSetItemPosition(
                req.params.id,
                req.body?.position,
                req.authUser.id
            )
        })),
    duplicateItem: todoListHandle(async (req, res) =>
        res.status(201).json({ item: await todoList.todoListDuplicateItem(req.params.id, req.authUser.id) })),

    listLabels: todoListHandle(async (req, res) =>
        res.json({ labels: await todoList.todoListGetLabels(req.authUser.id) })),
    createLabel: todoListHandle(async (req, res) =>
        res.status(201).json({ label: await todoList.todoListCreateLabel(req.body, req.authUser.id) })),
    updateLabel: todoListHandle(async (req, res) =>
        res.json({ label: await todoList.todoListUpdateLabel(req.params.id, req.body, req.authUser.id) })),
    deleteLabel: todoListHandle(async (req, res) => {
        await todoList.todoListDeleteLabel(req.params.id, req.authUser.id);
        return res.status(204).send();
    }),

    listChildren: todoListHandle(async (req, res) =>
        res.json({ children: await todoList.todoListListChildren(req.params.id, req.authUser.id) })),
    createChild: todoListHandle(async (req, res) =>
        res.status(201).json({
            child: await todoList.todoListCreateChild(req.params.id, req.body, req.authUser.id)
        })),
    updateChild: todoListHandle(async (req, res) =>
        res.json({ child: await todoList.todoListUpdateChild(req.params.id, req.body, req.authUser.id) })),
    deleteChild: todoListHandle(async (req, res) => {
        await todoList.todoListDeleteChild(req.params.id, req.authUser.id);
        return res.status(204).send();
    }),

    listComments: todoListHandle(async (req, res) =>
        res.json({ comments: await todoList.todoListListComments(req.params.id, req.authUser.id) })),
    createComment: todoListHandle(async (req, res) =>
        res.status(201).json({
            comment: await todoList.todoListAddComment(req.params.id, req.body, req.authUser.id)
        })),
    updateComment: todoListHandle(async (req, res) =>
        res.json({ comment: await todoList.todoListUpdateComment(req.params.id, req.body, req.authUser.id) })),
    deleteComment: todoListHandle(async (req, res) => {
        await todoList.todoListDeleteComment(req.params.id, req.authUser.id);
        return res.status(204).send();
    }),

    listAttachments: todoListHandle(async (req, res) => {
        const item = await todoList.todoListGetItem(req.params.id, req.authUser.id);
        return res.json({ attachments: item.attachments });
    }),
    createAttachment: todoListHandle(async (req, res) =>
        res.status(201).json({
            attachment: await todoList.todoListAddAttachment(req.params.id, req.file, req.authUser.id)
        })),
    deleteAttachment: todoListHandle(async (req, res) => {
        await todoList.todoListDeleteAttachmentById(req.params.id, req.authUser.id);
        return res.status(204).send();
    }),

    listReminders: todoListHandle(async (req, res) =>
        res.json({ reminders: await todoList.todoListListReminders(req.params.id, req.authUser.id) })),
    createReminder: todoListHandle(async (req, res) =>
        res.status(201).json({
            reminder: await todoList.todoListCreateReminder(req.params.id, req.body, req.authUser.id)
        })),
    updateReminder: todoListHandle(async (req, res) =>
        res.json({ reminder: await todoList.todoListUpdateReminder(req.params.id, req.body, req.authUser.id) })),
    deleteReminder: todoListHandle(async (req, res) => {
        await todoList.todoListDeleteReminder(req.params.id, req.authUser.id);
        return res.status(204).send();
    }),
    listNotifications: todoListHandle(async (req, res) =>
        res.json({ notifications: await todoList.todoListGetNotifications(req.authUser.id) })),
    readNotification: todoListHandle(async (req, res) => {
        await todoList.todoListMarkNotificationRead(req.params.id, req.authUser.id);
        return res.status(204).send();
    })
};

module.exports = { todoListController };
