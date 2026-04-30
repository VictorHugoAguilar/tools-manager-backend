const test = require("node:test");
const assert = require("node:assert/strict");
const { validateTechnicianPayload } = require("../../src/validators/technicianValidator");

test("validateTechnicianPayload accepts a valid technician", () => {
    const result = validateTechnicianPayload({
        name: "Juan Perez",
        specialty: "Electrica",
        phone: "600000000",
        email: "juan@example.com",
        notes: "Turno manana",
        active: true
    });

    assert.equal(result.isValid, true);
    assert.deepEqual(result.errors, []);
    assert.equal(result.data.name, "Juan Perez");
});

test("validateTechnicianPayload reports missing required fields", () => {
    const result = validateTechnicianPayload({
        name: "",
        specialty: ""
    });

    assert.equal(result.isValid, false);
    assert.deepEqual(result.errors, [
        "name is required and must be a non-empty string",
        "specialty is required and must be a non-empty string"
    ]);
});
