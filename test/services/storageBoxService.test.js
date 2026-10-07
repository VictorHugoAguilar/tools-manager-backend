const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { loadModuleWithMocks } = require("../helpers/loadModuleWithMocks");

function createSnapshot(value) {
    return {
        val() {
            return value;
        },
        exists() {
            return value !== null && value !== undefined;
        }
    };
}

function getPathSegments(referencePath) {
    return referencePath.split("/").filter(Boolean);
}

function createStorageBoxServiceHarness(initialBoxes = {}) {
    const store = {
        storageBoxes: structuredClone(initialBoxes)
    };
    let boxCounter = 1;
    let productCounter = 1;
    const deletedImages = [];

    const firebaseDatabaseMock = {
        ref(_database, dbPath) {
            return { path: dbPath };
        },
        async get(reference) {
            const segments = getPathSegments(reference.path);

            if (segments.length === 1) {
                return createSnapshot(store.storageBoxes);
            }

            if (segments.length === 2) {
                const [, boxId] = segments;
                return createSnapshot(store.storageBoxes[boxId]);
            }

            const [, boxId, , productId] = segments;
            return createSnapshot(store.storageBoxes[boxId]?.products?.[productId]);
        },
        push(reference) {
            const segments = getPathSegments(reference.path);
            const key = segments.includes("products")
                ? `product-${productCounter++}`
                : `box-${boxCounter++}`;

            return {
                key,
                path: `${reference.path}/${key}`
            };
        },
        async set(reference, value) {
            const segments = getPathSegments(reference.path);

            if (segments.length === 2) {
                const [, boxId] = segments;
                store.storageBoxes[boxId] = value;
                return;
            }

            const [, boxId, , productId] = segments;
            store.storageBoxes[boxId] = store.storageBoxes[boxId] || {
                id: boxId,
                products: {}
            };
            store.storageBoxes[boxId].products = store.storageBoxes[boxId].products || {};
            store.storageBoxes[boxId].products[productId] = value;
        },
        async remove(reference) {
            const segments = getPathSegments(reference.path);

            if (segments.length === 2) {
                const [, boxId] = segments;
                delete store.storageBoxes[boxId];
                return;
            }

            const [, boxId, , productId] = segments;
            delete store.storageBoxes[boxId]?.products?.[productId];
        }
    };

    const storageBoxService = loadModuleWithMocks(
        path.resolve(__dirname, "../../src/services/storageBoxService.js"),
        {
            "firebase/database": firebaseDatabaseMock,
            "../config/database": {
                getDatabaseInstance() {
                    return {};
                }
            },
            "./toolImageStorageService": {
                async deleteImageByUrl(imageUrl) {
                    deletedImages.push(imageUrl);
                    return true;
                }
            }
        }
    );

    return {
        storageBoxService,
        store,
        deletedImages
    };
}

test("findAll returns storage boxes sorted by code", async () => {
    const { storageBoxService } = createStorageBoxServiceHarness({
        b1: { id: "b1", code: "BOX-0002", name: "Caja dos", description: "", products: {} },
        a1: { id: "a1", code: "BOX-0001", name: "Caja uno", description: "", products: {} }
    });

    const result = await storageBoxService.findAll();

    assert.deepEqual(result.map((box) => box.code), ["BOX-0001", "BOX-0002"]);
});

test("create assigns a generated code when code is omitted", async () => {
    const { storageBoxService } = createStorageBoxServiceHarness({
        a1: { id: "a1", code: "BOX-0004", name: "Caja", description: "", products: {} }
    });

    const created = await storageBoxService.create({
        name: "Herramienta fina",
        description: "Tornilleria"
    });

    assert.equal(created.code, "BOX-0005");
});

test("createProduct stores a product inside an existing box", async () => {
    const { storageBoxService, store } = createStorageBoxServiceHarness({
        a1: { id: "a1", code: "BOX-0001", name: "Caja uno", description: "", products: {} }
    });

    const product = await storageBoxService.createProduct("a1", {
        name: "Tornillo M8",
        description: "Acero zincado",
        imageUrl: "",
        quantity: 24,
        state: "Nuevo",
        tags: ["fijacion", "acero"]
    });

    assert.equal(product.id, "product-1");
    assert.deepEqual(store.storageBoxes.a1.products["product-1"], product);
});

test("findAll normalizes missing product tags to an empty array", async () => {
    const { storageBoxService } = createStorageBoxServiceHarness({
        a1: {
            id: "a1",
            code: "BOX-0001",
            name: "Caja uno",
            description: "",
            products: {
                p1: {
                    id: "p1",
                    name: "Tornillo M8",
                    description: "Acero",
                    imageUrl: "",
                    quantity: 4,
                    state: "Nuevo"
                }
            }
        }
    });

    const [box] = await storageBoxService.findAll();

    assert.deepEqual(box.products[0].tags, []);
});

test("searchProducts returns boxes with products matching name, properties or tags", async () => {
    const { storageBoxService } = createStorageBoxServiceHarness({
        a1: {
            id: "a1",
            code: "BOX-0001",
            name: "Caja tornilleria",
            description: "",
            imageUrl: "",
            products: {
                p1: {
                    id: "p1",
                    name: "Tornillo M8",
                    description: "Acero inoxidable",
                    imageUrl: "",
                    quantity: 10,
                    state: "Nuevo",
                    tags: ["fijacion", "inox"]
                },
                p2: {
                    id: "p2",
                    name: "Arandela",
                    description: "Metal",
                    imageUrl: "",
                    quantity: 2,
                    state: "Usado",
                    tags: ["recambio"]
                }
            }
        },
        b1: {
            id: "b1",
            code: "BOX-0002",
            name: "Caja electricidad",
            description: "",
            imageUrl: "",
            products: {
                p3: {
                    id: "p3",
                    name: "Cable",
                    description: "Flexible",
                    imageUrl: "",
                    quantity: 5,
                    state: "Nuevo",
                    tags: ["electricidad"]
                }
            }
        }
    });

    const result = await storageBoxService.searchProducts("inox");

    assert.equal(result.query, "inox");
    assert.equal(result.totalBoxes, 1);
    assert.equal(result.totalProducts, 1);
    assert.equal(result.boxes[0].box.code, "BOX-0001");
    assert.deepEqual(result.boxes[0].matchingProducts.map((product) => product.name), ["Tornillo M8"]);
});

test("searchProducts matches multiple terms across product fields", async () => {
    const { storageBoxService } = createStorageBoxServiceHarness({
        a1: {
            id: "a1",
            code: "BOX-0001",
            name: "Caja uno",
            description: "",
            imageUrl: "",
            products: {
                p1: {
                    id: "p1",
                    name: "Tornillo M8",
                    description: "Acero inoxidable",
                    imageUrl: "",
                    quantity: 10,
                    state: "Nuevo",
                    tags: ["fijacion"]
                }
            }
        }
    });

    const result = await storageBoxService.searchProducts("tornillo acero");

    assert.equal(result.totalProducts, 1);
    assert.equal(result.boxes[0].matchingProducts[0].id, "p1");
});

test("searchProducts orders results by relevance", async () => {
    const { storageBoxService } = createStorageBoxServiceHarness({
        a1: {
            id: "a1",
            code: "BOX-0001",
            name: "Caja descripcion",
            description: "",
            imageUrl: "",
            products: {
                p1: {
                    id: "p1",
                    name: "Pack generico",
                    description: "Incluye tornillo de repuesto",
                    imageUrl: "",
                    quantity: 1,
                    state: "Nuevo",
                    tags: []
                }
            }
        },
        b1: {
            id: "b1",
            code: "BOX-0002",
            name: "Caja nombre",
            description: "",
            imageUrl: "",
            products: {
                p2: {
                    id: "p2",
                    name: "Tornillo M8",
                    description: "Acero",
                    imageUrl: "",
                    quantity: 4,
                    state: "Nuevo",
                    tags: []
                }
            }
        }
    });

    const result = await storageBoxService.searchProducts("tornillo");

    assert.deepEqual(result.boxes.map((boxResult) => boxResult.box.code), ["BOX-0002", "BOX-0001"]);
    assert.deepEqual(result.boxes[0].matchingProducts.map((product) => product.name), ["Tornillo M8"]);
});

test("removeProduct deletes a stored product", async () => {
    const { storageBoxService, store, deletedImages } = createStorageBoxServiceHarness({
        a1: {
            id: "a1",
            code: "BOX-0001",
            name: "Caja uno",
            description: "",
            imageUrl: "",
            products: {
                p1: {
                    id: "p1",
                    name: "Tornillo M8",
                    description: "Acero",
                    imageUrl: "https://example.com/product.png",
                    quantity: 2,
                    state: "Nuevo"
                }
            }
        }
    });

    const removed = await storageBoxService.removeProduct("a1", "p1");

    assert.equal(removed, true);
    assert.equal(store.storageBoxes.a1.products.p1, undefined);
    assert.deepEqual(deletedImages, ["https://example.com/product.png"]);
});

test("remove deletes box image and nested product images", async () => {
    const { storageBoxService, deletedImages } = createStorageBoxServiceHarness({
        a1: {
            id: "a1",
            code: "BOX-0001",
            name: "Caja uno",
            description: "",
            imageUrl: "https://example.com/box.png",
            products: {
                p1: {
                    id: "p1",
                    name: "Tornillo M8",
                    description: "Acero",
                    imageUrl: "https://example.com/product.png",
                    quantity: 2,
                    state: "Nuevo"
                }
            }
        }
    });

    const removed = await storageBoxService.remove("a1");

    assert.equal(removed, true);
    assert.deepEqual(deletedImages, [
        "https://example.com/box.png",
        "https://example.com/product.png"
    ]);
});
