const changes = (prefix, operations) => operations.map((operation) => `${prefix}.${operation}`);

const HISTORY_ACTIONS = {
    tools: [
        ...changes("tool", ["created", "updated", "state.updated", "image.updated", "deleted"]),
        ...changes("repair", ["created", "updated", "deleted"])
    ],
    board: [
        ...changes("task_board.column", ["created", "updated", "deleted", "reordered"]),
        ...changes("task_board.label", ["created", "updated", "deleted"]),
        ...changes("task_board.task", ["created", "updated", "moved", "deleted"]),
        ...changes("task_board.comment", ["created", "updated", "deleted"]),
        ...changes("task_board.attachment", ["created", "deleted"])
    ],
    todo: [
        ...changes("todo.project", ["created", "updated", "archived", "restored", "deleted", "reordered"]),
        ...changes("todo.member", ["added", "removed"]),
        ...changes("todo.section", ["created", "updated", "deleted", "reordered"]),
        ...changes("todo.label", ["created", "updated", "deleted"]),
        ...changes("todo.item", ["created", "updated", "moved", "completed", "reopened", "archived", "unarchived",
            "importance.updated", "priority.updated", "reordered"]),
        ...changes("todo.child", ["created", "updated", "deleted"]),
        ...changes("todo.comment", ["created", "updated", "deleted"]),
        ...changes("todo.reminder", ["created", "updated", "deleted"])
    ],
    drawing: [
        ...changes("drawing.document", ["created", "updated", "archived", "restored", "deleted", "duplicated"]),
        ...changes("drawing.page", ["created", "updated", "deleted", "reordered", "duplicated"]),
        "drawing.version.restored"
    ],
    catalogs: ["technician", "location", "tool_type", "tag"]
        .flatMap((prefix) => changes(prefix, ["created", "updated", "deleted"])),
    identity: [
        ...changes("user", ["created", "updated", "deleted", "role.updated", "status.updated",
            "password.reset", "avatar.updated", "profile.updated", "password.changed", "password.recovered",
            "registered", "registration.rolled_back"]),
        "role.permissions.updated"
    ]
};

module.exports = { HISTORY_ACTIONS };
