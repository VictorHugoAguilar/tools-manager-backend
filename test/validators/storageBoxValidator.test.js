const test = require("node:test");
const assert = require("node:assert/strict");
const {
    validateStorageBoxPayload,
    validateStorageProductPayload
} = require("../../src/validators/storageBoxValidator");

test("validateStorageBoxPayload accepts a valid storage box", () => {
    const result = validateStorageBoxPayload({
        name: "Caja de brocas",
        description: "Brocas de metal"
    });

    assert.equal(result.isValid, true);
    assert.deepEqual(result.errors, []);
    assert.equal(result.data.name, "Caja de brocas");
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

test("validateStorageProductPayload accepts a valid product", () => {
    const result = validateStorageProductPayload({
        name: "Tornillo M8",
        description: "Acero zincado",
        imageUrl: "",
        quantity: 16,
        state: "Nuevo"
    });

    assert.equal(result.isValid, true);
    assert.deepEqual(result.errors, []);
    assert.equal(result.data.quantity, 16);
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
