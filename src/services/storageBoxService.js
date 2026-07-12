const {
    get,
    push,
    ref,
    remove: removeValue,
    set
} = require("firebase/database");
const { getDatabaseInstance } = require("../config/database");
const { deleteImageByUrl } = require("./toolImageStorageService");

function normalizeText(value) {
    return String(value ?? "").trim().toLowerCase();
}

function sortByText(items, selector) {
    return [...items].sort((left, right) =>
        selector(left).localeCompare(selector(right), "es", {
            sensitivity: "base",
            numeric: true
        })
    );
}

function normalizeProductEntity(id, product) {
    return {
        id,
        ...product,
        tags: Array.isArray(product.tags)
            ? product.tags.filter(Boolean)
            : []
    };
}

function serializeProducts(snapshotValue) {
    if (!snapshotValue) {
        return [];
    }

    return sortByText(
        Object.entries(snapshotValue).map(([id, product]) => normalizeProductEntity(id, product)),
        (product) => normalizeText(product.name)
    );
}

function serializeBox(id, box) {
    return {
        id,
        code: box.code,
        name: box.name,
        description: box.description,
        imageUrl: box.imageUrl || "",
        products: serializeProducts(box.products)
    };
}

function serializeBoxes(snapshotValue) {
    if (!snapshotValue) {
        return [];
    }

    return sortByText(
        Object.entries(snapshotValue).map(([id, box]) => serializeBox(id, box)),
        (box) => normalizeText(box.code || box.name)
    );
}

async function getRawBox(id) {
    if (!id || typeof id !== "string") {
        return null;
    }

    const database = getDatabaseInstance();
    const snapshot = await get(ref(database, `storageBoxes/${id}`));

    if (!snapshot.exists()) {
        return null;
    }

    return snapshot.val();
}

function extractCodeNumber(code) {
    const match = String(code ?? "").match(/(\d+)$/);
    return match ? Number(match[1]) : 0;
}

async function generateNextBoxCode() {
    const boxes = await findAll();
    const currentMax = boxes.reduce(
        (highest, box) => Math.max(highest, extractCodeNumber(box.code)),
        0
    );

    return `BOX-${String(currentMax + 1).padStart(4, "0")}`;
}

async function findAll() {
    const database = getDatabaseInstance();
    const snapshot = await get(ref(database, "storageBoxes"));
    return serializeBoxes(snapshot.val());
}

async function findById(id) {
    const rawBox = await getRawBox(id);

    if (!rawBox) {
        return null;
    }

    return serializeBox(id, rawBox);
}

async function create(boxData) {
    const database = getDatabaseInstance();
    const boxesRef = ref(database, "storageBoxes");
    const newBoxRef = push(boxesRef);
    const code = boxData.code && boxData.code.trim() !== ""
        ? boxData.code.trim()
        : await generateNextBoxCode();
    const newBox = {
        id: newBoxRef.key,
        code,
        name: boxData.name,
        description: boxData.description,
        imageUrl: boxData.imageUrl || "",
        products: {}
    };

    await set(newBoxRef, newBox);
    return serializeBox(newBoxRef.key, newBox);
}

async function update(id, boxData) {
    const existingBox = await getRawBox(id);

    if (!existingBox) {
        return null;
    }

    const updatedBox = {
        ...existingBox,
        id,
        code: boxData.code,
        name: boxData.name,
        description: boxData.description,
        imageUrl: boxData.imageUrl ?? existingBox.imageUrl ?? ""
    };

    const database = getDatabaseInstance();
    await set(ref(database, `storageBoxes/${id}`), updatedBox);
    return serializeBox(id, updatedBox);
}

async function remove(id) {
    const existingBox = await getRawBox(id);

    if (!existingBox) {
        return false;
    }

    const database = getDatabaseInstance();
    await removeValue(ref(database, `storageBoxes/${id}`));
    await deleteImageByUrl(existingBox.imageUrl);

    const productImages = Object.values(existingBox.products || {})
        .map((product) => product.imageUrl)
        .filter(Boolean);

    await Promise.all(productImages.map((imageUrl) => deleteImageByUrl(imageUrl)));
    return true;
}

async function createProduct(boxId, productData) {
    const existingBox = await getRawBox(boxId);

    if (!existingBox) {
        return null;
    }

    const database = getDatabaseInstance();
    const productsRef = ref(database, `storageBoxes/${boxId}/products`);
    const newProductRef = push(productsRef);
    const product = {
        id: newProductRef.key,
        ...productData
    };

    await set(newProductRef, product);
    return normalizeProductEntity(newProductRef.key, product);
}

async function findProductById(boxId, productId) {
    if (!boxId || !productId) {
        return null;
    }

    const database = getDatabaseInstance();
    const snapshot = await get(ref(database, `storageBoxes/${boxId}/products/${productId}`));

    if (!snapshot.exists()) {
        return null;
    }

    return normalizeProductEntity(productId, snapshot.val());
}

async function updateProduct(boxId, productId, productData) {
    const existingProduct = await findProductById(boxId, productId);

    if (!existingProduct) {
        return null;
    }

    const database = getDatabaseInstance();
    const updatedProduct = {
        id: productId,
        ...productData
    };

    await set(ref(database, `storageBoxes/${boxId}/products/${productId}`), updatedProduct);
    return normalizeProductEntity(productId, updatedProduct);
}

async function removeProduct(boxId, productId) {
    const existingProduct = await findProductById(boxId, productId);

    if (!existingProduct) {
        return false;
    }

    const database = getDatabaseInstance();
    await removeValue(ref(database, `storageBoxes/${boxId}/products/${productId}`));
    await deleteImageByUrl(existingProduct.imageUrl);
    return true;
}

async function updateImageUrl(boxId, imageUrl) {
    const existingBox = await getRawBox(boxId);

    if (!existingBox) {
        return null;
    }

    const updatedBox = {
        ...existingBox,
        imageUrl
    };

    const database = getDatabaseInstance();
    await set(ref(database, `storageBoxes/${boxId}`), updatedBox);
    return serializeBox(boxId, updatedBox);
}

async function updateProductImageUrl(boxId, productId, imageUrl) {
    const existingProduct = await findProductById(boxId, productId);

    if (!existingProduct) {
        return null;
    }

    const updatedProduct = {
        ...existingProduct,
        imageUrl
    };

    const database = getDatabaseInstance();
    await set(ref(database, `storageBoxes/${boxId}/products/${productId}`), updatedProduct);
    return normalizeProductEntity(productId, updatedProduct);
}

module.exports = {
    findAll,
    findById,
    create,
    update,
    remove,
    createProduct,
    updateProduct,
    removeProduct,
    findProductById,
    updateImageUrl,
    updateProductImageUrl
};
