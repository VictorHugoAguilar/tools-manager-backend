const { transactCatalog } = require("./businessOutbox");

function createCatalogRecord(collection, id, data, actorId) {
    return transactCatalog({ id, actorId, collection, operation: "created",
        change: (current) => {
            if (current) throw Object.assign(new Error("El registro ya existe."), { statusCode: 409 });
            const value = { id, ...data };
            return { value, result: value };
        } });
}

function updateCatalogRecord(collection, id, data, actorId) {
    return transactCatalog({ id, actorId, collection, operation: "updated",
        change: (current) => current ? { value: { id, ...data }, result: { id, ...data } } : null });
}

async function removeCatalogRecord(collection, id, actorId) {
    return Boolean(await transactCatalog({ id, actorId, collection, operation: "deleted",
        change: (current) => current ? { value: null, result: true } : null }));
}

module.exports = { createCatalogRecord, updateCatalogRecord, removeCatalogRecord };
