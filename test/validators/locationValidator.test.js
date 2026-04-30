const test = require("node:test");
const assert = require("node:assert/strict");
const { validateLocationPayload } = require("../../src/validators/locationValidator");

test("validateLocationPayload accepts a valid location", () => {
    const result = validateLocationPayload({
        name: "Almacen Central",
        description: "Zona principal"
    });

    assert.equal(result.isValid, true);
    assert.deepEqual(result.errors, []);
    assert.equal(result.data.name, "Almacen Central");
});

test("validateLocationPayload rejects missing name", () => {
    const result = validateLocationPayload({
        name: "",
        description: ""
    });

    assert.equal(result.isValid, false);
    assert.deepEqual(result.errors, [
        "name is required and must be a non-empty string"
    ]);
});
