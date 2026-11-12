const routes = {
    board: {
        "/": ["GET"],
        "/columns": ["POST"],
        "/columns/reorder": ["PUT"],
        "/columns/:id": ["PATCH", "DELETE"],
        "/tasks": ["POST"],
        "/tasks/:id": ["PATCH", "DELETE"],
        "/tasks/:id/move": ["POST"],
        "/tasks/:id/comments": ["POST"],
        "/tasks/:id/comments/:commentId": ["PUT", "DELETE"],
        "/tasks/:id/attachments": ["POST"],
        "/tasks/:id/attachments/:attachmentId": ["DELETE"],
        "/labels": ["POST"],
        "/labels/:id": ["PATCH", "DELETE"]
    },
    todo: {
        "/": ["GET"],
        "/users": ["GET"],
        "/projects": ["GET", "POST"],
        "/projects/reorder": ["POST"],
        "/projects/:id": ["GET", "PUT", "DELETE"],
        "/projects/:id/archive": ["PATCH"],
        "/projects/:id/members": ["GET", "POST"],
        "/projects/:id/members/:userId": ["DELETE"],
        "/projects/:id/sections": ["GET", "POST"],
        "/sections/:id": ["PATCH", "DELETE"],
        "/sections/:id/position": ["PATCH"],
        "/items": ["GET", "POST"],
        "/items/:id": ["GET", "PUT", "DELETE"],
        "/items/:id/complete": ["PATCH"],
        "/items/:id/reopen": ["PATCH"],
        "/items/:id/archive": ["PATCH"],
        "/items/:id/important": ["PATCH"],
        "/items/:id/priority": ["PATCH"],
        "/items/:id/move": ["PATCH"],
        "/items/:id/position": ["PATCH"],
        "/items/:id/duplicate": ["POST"],
        "/labels": ["GET", "POST"],
        "/labels/:id": ["PUT", "DELETE"],
        "/items/:id/children": ["GET", "POST"],
        "/children/:id": ["PUT", "DELETE"],
        "/items/:id/comments": ["GET", "POST"],
        "/comments/:id": ["PUT", "DELETE"],
        "/items/:id/attachments": ["GET", "POST"],
        "/attachments/:id": ["DELETE"],
        "/items/:id/reminders": ["GET", "POST"],
        "/reminders/:id": ["PUT", "DELETE"],
        "/notifications": ["GET"],
        "/notifications/:id/read": ["PATCH"],
        "/:id": ["GET", "PUT", "DELETE"],
        "/:id/archive": ["PATCH"]
    }
};

function isTaskOperation(module, route, method) {
    return Object.hasOwn(routes, module) && Object.hasOwn(routes[module], route) &&
        routes[module][route].includes(method);
}

module.exports = { isTaskOperation };
