const test = require("node:test");
const assert = require("node:assert/strict");
const { validateToolTypePayload } = require("../../src/validators/toolTypeValidator");

test("validateToolTypePayload accepts a valid tool type", () => {
    const result = validateToolTypePayload({
        name: "Perforacion",
        description: "Herramientas de broca"
    });

    assert.equal(result.isValid, true);
    assert.deepEqual(result.errors, []);
    assert.equal(result.data.name, "Perforacion");
});

test("validateToolTypePayload rejects missing name", () => {
    const result = validateToolTypePayload({
        name: "",
        description: ""
    });

    assert.equal(result.isValid, false);
    assert.deepEqual(result.errors, [
        "name is required and must be a non-empty string"
    ]);
});
