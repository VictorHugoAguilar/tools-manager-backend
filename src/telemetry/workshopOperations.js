const routes = {
    "/categories": ["POST"],
    "/categories/:id": ["DELETE"],
    "/shelves": ["POST"],
    "/shelves/:id": ["PUT", "DELETE"],
    "/levels": ["POST"],
    "/levels/:id": ["PUT", "DELETE"],
    "/organizers": ["POST"],
    "/organizers/:id": ["PUT", "DELETE"],
    "/compartments": ["POST"],
    "/compartments/:id": ["PUT", "DELETE"],
    "/materials": ["POST"],
    "/materials/:id": ["PUT", "DELETE"],
    "/materials/:id/image": ["POST"]
};

function isWorkshopOperation(route, method) {
    return Object.hasOwn(routes, route) && routes[route].includes(method);
}

module.exports = { isWorkshopOperation };
