const test = require("node:test");
const assert = require("node:assert/strict");
const {
    validateStorageBoxPayload,
    validateStorageProductPayload
} = require("../../src/validators/storageBoxValidator");

test("validateStorageBoxPayload accepts a valid storage box", () => {
    const result = validateStorageBoxPayload({
        name: "Caja de brocas",
        description: "Brocas de metal",
        shelfRow: 3,
        shelfColumn: 4
    });

    assert.equal(result.isValid, true);
    assert.deepEqual(result.errors, []);
    assert.equal(result.data.name, "Caja de brocas");
    assert.equal(result.data.shelfRow, 3);
    assert.equal(result.data.shelfColumn, 4);
});

test("validateStorageBoxPayload rejects missing name", () => {
    const result = validateStorageBoxPayload({
        name: "",
        description: "Brocas de metal"
    });

    assert.equal(result.isValid, false);
    assert.deepEqual(result.errors, [
        "name is required and must be a non-empty string"
    ]);
});

test("validateStorageBoxPayload rejects invalid shelf location", () => {
    const result = validateStorageBoxPayload({
        name: "Caja de brocas",
        description: "Brocas de metal",
        shelfRow: 6,
        shelfColumn: 0
    });

    assert.equal(result.isValid, false);
    assert.deepEqual(result.errors, [
        "shelfRow must be an integer between 1 and 5",
        "shelfColumn must be an integer between 1 and 6"
    ]);
});

test("validateStorageProductPayload accepts a valid product", () => {
    const result = validateStorageProductPayload({
        name: "Tornillo M8",
        description: "Acero zincado",
        imageUrl: "",
        quantity: 16,
        state: "Nuevo",
        tags: ["fijacion", "acero", "acero"]
    });

    assert.equal(result.isValid, true);
    assert.deepEqual(result.errors, []);
    assert.equal(result.data.quantity, 16);
    assert.deepEqual(result.data.tags, ["fijacion", "acero"]);
});

test("validateStorageProductPayload rejects invalid state", () => {
    const result = validateStorageProductPayload({
        name: "Tornillo M8",
        description: "Acero zincado",
        imageUrl: "",
        quantity: 16,
        state: "Roto"
    });

    assert.equal(result.isValid, false);
    assert.deepEqual(result.errors, [
        "state must be one of: Nuevo, Usado"
    ]);
});

test("validateStorageProductPayload rejects invalid tags", () => {
    const result = validateStorageProductPayload({
        name: "Tornillo M8",
        description: "Acero zincado",
        imageUrl: "",
        quantity: 16,
        state: "Nuevo",
        tags: "acero"
    });

    assert.equal(result.isValid, false);
    assert.deepEqual(result.errors, [
        "tags must be an array of strings when provided"
    ]);
});
