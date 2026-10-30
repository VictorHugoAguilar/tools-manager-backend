const board = require("../services/taskBoardService");

function respond(handler) {
    return async (req, res, next) => {
        try {
            return await handler(req, res);
        } catch (error) {
            return next(error);
        }
    };
}

const taskBoardController = {
    getBoard: respond(async (req, res) => res.json(await board.getBoard(req.query))),

    createColumn: respond(async (req, res) => res.status(201).json(await board.createColumn(req.body))),
    updateColumn: respond(async (req, res) => {
        const column = await board.updateColumn(req.params.id, req.body);
        return column ? res.json(column) : res.status(404).json({ message: "Lista no encontrada." });
    }),
    deleteColumn: respond(async (req, res) => {
        const deleted = await board.deleteColumn(req.params.id);
        return deleted ? res.status(204).send() : res.status(404).json({ message: "Lista no encontrada." });
    }),
    reorderColumns: respond(async (req, res) => res.json({
        columns: await board.reorderColumns(req.body?.ids)
    })),

    createTask: respond(async (req, res) => res.status(201).json(
        await board.createTask(req.body, req.authUser)
    )),
    updateTask: respond(async (req, res) => {
        const task = await board.updateTask(req.params.id, req.body, req.authUser);
        return task ? res.json(task) : res.status(404).json({ message: "Tarea no encontrada." });
    }),
    moveTask: respond(async (req, res) => {
        const task = await board.moveTask(
            req.params.id,
            req.body?.columnId,
            req.body?.position,
            req.authUser
        );
        return task ? res.json(task) : res.status(404).json({ message: "Tarea no encontrada." });
    }),
    deleteTask: respond(async (req, res) => {
        const deleted = await board.deleteTask(req.params.id);
        return deleted ? res.status(204).send() : res.status(404).json({ message: "Tarea no encontrada." });
    }),

    createLabel: respond(async (req, res) => res.status(201).json(await board.createLabel(req.body))),
    updateLabel: respond(async (req, res) => {
        const label = await board.updateLabel(req.params.id, req.body);
        return label ? res.json(label) : res.status(404).json({ message: "Etiqueta no encontrada." });
    }),
    deleteLabel: respond(async (req, res) => {
        const deleted = await board.deleteLabel(req.params.id);
        return deleted ? res.status(204).send() : res.status(404).json({ message: "Etiqueta no encontrada." });
    }),

    addComment: respond(async (req, res) => {
        const comment = await board.addComment(req.params.id, req.body?.text, req.authUser);
        return comment ? res.status(201).json(comment) : res.status(404).json({ message: "Tarea no encontrada." });
    }),
    addAttachment: respond(async (req, res) => {
        const attachment = await board.addAttachment(req.params.id, req.file, req.authUser);
        return attachment
            ? res.status(201).json(attachment)
            : res.status(404).json({ message: "Tarea no encontrada." });
    }),
    removeAttachment: respond(async (req, res) => {
        const deleted = await board.removeAttachment(req.params.id, req.params.attachmentId);
        return deleted
            ? res.status(204).send()
            : res.status(404).json({ message: "Archivo adjunto no encontrado." });
    })
};

module.exports = { taskBoardController };
