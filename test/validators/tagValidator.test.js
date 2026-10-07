const test = require("node:test");
const assert = require("node:assert/strict");
const { validateTagPayload } = require("../../src/validators/tagValidator");

test("validateTagPayload accepts a valid tag", () => {
    const result = validateTagPayload({
        name: "Tornilleria",
        description: "Productos pequenos de fijacion"
    });

    assert.equal(result.isValid, true);
    assert.deepEqual(result.errors, []);
    assert.equal(result.data.name, "Tornilleria");
});

test("validateTagPayload rejects missing name", () => {
    const result = validateTagPayload({
        name: "",
        description: ""
    });

    assert.equal(result.isValid, false);
    assert.deepEqual(result.errors, [
        "name is required and must be a non-empty string"
    ]);
});
