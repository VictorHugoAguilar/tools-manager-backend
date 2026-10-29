const {
    get,
    push,
    ref,
    remove: removeValue,
    set
} = require("firebase/database");
const { getDatabaseInstance } = require("../config/database");

const CATEGORY_PATH = "workshopStorageSettings/materialCategories";
const DEFAULT_CATEGORIES = [
    { id: "screws", name: "Tornillos" },
    { id: "nuts", name: "Tuercas" },
    { id: "washers", name: "Arandelas" },
    { id: "wall-plugs", name: "Tacos" },
    { id: "electrical-parts", name: "Piezas eléctricas" },
    { id: "other", name: "Otros" }
];

function databaseRef(path) {
    return ref(getDatabaseInstance(), path);
}

function normalizeCategoryName(name) {
    return String(name ?? "").trim().replace(/\s+/g, " ");
}

function serializeCategories(snapshot) {
    const config = snapshot.val();

    if (!snapshot.exists()) {
        return DEFAULT_CATEGORIES;
    }

    return Object.entries(config.categories || {})
        .map(([id, category]) => ({ id, name: category.name }))
        .sort((left, right) => left.name.localeCompare(right.name, "es", { sensitivity: "base" }));
}

async function ensureCategoryConfig() {
    const configurationRef = databaseRef(CATEGORY_PATH);
    const snapshot = await get(configurationRef);

    if (snapshot.exists()) {
        return configurationRef;
    }

    const categories = Object.fromEntries(
        DEFAULT_CATEGORIES.map(({ id, name }) => [id, { name }])
    );
    await set(configurationRef, { initialized: true, categories });
    return configurationRef;
}

async function findAllMaterialCategories() {
    const snapshot = await get(databaseRef(CATEGORY_PATH));
    return serializeCategories(snapshot);
}

async function createMaterialCategory(value) {
    const name = normalizeCategoryName(value);

    if (!name || name.length > 100) {
        throw Object.assign(new Error("Category name must contain 1 to 100 characters"), {
            statusCode: 400
        });
    }

    const configurationRef = await ensureCategoryConfig();
    const snapshot = await get(configurationRef);
    const categories = serializeCategories(snapshot);
    const duplicate = categories.some((category) =>
        category.name.localeCompare(name, "es", { sensitivity: "base" }) === 0
    );

    if (duplicate) {
        throw Object.assign(new Error("A material category with that name already exists"), {
            statusCode: 409
        });
    }

    const categoryRef = push(databaseRef(`${CATEGORY_PATH}/categories`));
    const category = { id: categoryRef.key, name };
    await set(categoryRef, { name });
    return category;
}

async function deleteMaterialCategory(id) {
    if (!id || typeof id !== "string") {
        return false;
    }

    await ensureCategoryConfig();
    const categoryRef = databaseRef(`${CATEGORY_PATH}/categories/${id}`);
    const snapshot = await get(categoryRef);

    if (!snapshot.exists()) {
        return false;
    }

    await removeValue(categoryRef);
    return true;
}

module.exports = {
    createMaterialCategory,
    deleteMaterialCategory,
    findAllMaterialCategories
};
