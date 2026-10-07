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

function normalizeSearchText(value) {
    return normalizeText(value)
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "");
}

function sortByText(items, selector) {
    return [...items].sort((left, right) =>
        selector(left).localeCompare(selector(right), "es", {
            sensitivity: "base",
            numeric: true
        })
    );
}

function buildProductSearchText(product) {
    return normalizeSearchText([
        product.name,
        product.description,
        product.state,
        product.quantity,
        ...(Array.isArray(product.tags) ? product.tags : [])
    ].join(" "));
}

function getSearchTerms(query) {
    return normalizeSearchText(query)
        .split(/\s+/)
        .filter(Boolean);
}

function calculateFieldScore(value, terms, weight) {
    const normalizedValue = normalizeSearchText(value);

    if (!normalizedValue) {
        return 0;
    }

    return terms.reduce((score, term) => {
        if (normalizedValue === term) {
            return score + (weight * 2);
        }

        if (normalizedValue.startsWith(term)) {
            return score + Math.round(weight * 1.5);
        }

        if (normalizedValue.includes(term)) {
            return score + weight;
        }

        return score;
    }, 0);
}

function calculateProductSearchScore(product, terms) {
    const tagScore = Array.isArray(product.tags)
        ? product.tags.reduce((score, tag) => score + calculateFieldScore(tag, terms, 35), 0)
        : 0;

    return [
        calculateFieldScore(product.name, terms, 60),
        tagScore,
        calculateFieldScore(product.state, terms, 20),
        calculateFieldScore(product.quantity, terms, 14),
        calculateFieldScore(product.description, terms, 12)
    ].reduce((total, score) => total + score, 0);
}

function matchesProductSearch(product, terms) {
    if (terms.length === 0) {
        return false;
    }

    const searchText = buildProductSearchText(product);
    return terms.every((term) => searchText.includes(term));
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
        shelfRow: Number.isInteger(box.shelfRow) ? box.shelfRow : 1,
        shelfColumn: Number.isInteger(box.shelfColumn) ? box.shelfColumn : 1,
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

async function searchProducts(query) {
    const normalizedQuery = String(query ?? "").trim();
    const terms = getSearchTerms(normalizedQuery);

    if (terms.length === 0) {
        return {
            query: "",
            totalBoxes: 0,
            totalProducts: 0,
            boxes: []
        };
    }

    const boxes = await findAll();
    const results = boxes
        .map((box) => {
            const scoredProducts = box.products
                .filter((product) => matchesProductSearch(product, terms))
                .map((product) => ({
                    product,
                    score: calculateProductSearchScore(product, terms)
                }))
                .sort((left, right) =>
                    right.score - left.score ||
                    left.product.name.localeCompare(right.product.name, "es", {
                        sensitivity: "base",
                        numeric: true
                    })
                );
            const matchingProducts = scoredProducts.map((result) => result.product);
            const relevanceScore = scoredProducts.reduce((total, result) => total + result.score, 0);
            const topScore = scoredProducts[0]?.score ?? 0;

            return {
                box,
                matchingProducts,
                matchCount: matchingProducts.length,
                relevanceScore,
                topScore
            };
        })
        .filter((result) => result.matchCount > 0)
        .sort((left, right) =>
            right.topScore - left.topScore ||
            right.matchCount - left.matchCount ||
            right.relevanceScore - left.relevanceScore ||
            left.box.code.localeCompare(right.box.code, "es", {
                sensitivity: "base",
                numeric: true
            })
        )
        .map(({ relevanceScore, topScore, ...result }) => result);

    return {
        query: normalizedQuery,
        totalBoxes: results.length,
        totalProducts: results.reduce((total, result) => total + result.matchCount, 0),
        boxes: results
    };
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
        shelfRow: boxData.shelfRow || 1,
        shelfColumn: boxData.shelfColumn || 1,
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
        imageUrl: boxData.imageUrl ?? existingBox.imageUrl ?? "",
        shelfRow: boxData.shelfRow ?? existingBox.shelfRow ?? 1,
        shelfColumn: boxData.shelfColumn ?? existingBox.shelfColumn ?? 1
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
    searchProducts,
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
