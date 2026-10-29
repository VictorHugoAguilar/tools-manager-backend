const test = require("node:test");
const assert = require("node:assert/strict");
const { validateWorkshopStoragePayload } = require("../../src/validators/workshopStorageValidator");

test("workshop storage material accepts independent technical dimensions", () => {
    const result = validateWorkshopStoragePayload("materials", {
        compartmentId: "compartment-1",
        name: "Arandela plana",
        category: "Arandelas",
        innerDiameter: "8",
        outerDiameter: "16",
        quantity: "50",
        notes: "Acero zincado"
    });

    assert.equal(result.isValid, true);
    assert.equal(result.data.innerDiameter, 8);
    assert.equal(result.data.outerDiameter, 16);
    assert.equal(result.data.quantity, 50);
});

test("workshop storage organizer requires a positive column count", () => {
    const result = validateWorkshopStoragePayload("organizers", {
        levelId: "level-1",
        name: "Organizador A",
        type: "compact",
        columns: 0
    });

    assert.equal(result.isValid, false);
    assert.ok(result.errors.includes("columns must be a positive integer"));
});

test("workshop storage compartment requires positive grid positions", () => {
    const result = validateWorkshopStoragePayload("compartments", {
        organizerId: "organizer-1",
        name: "Compartimento 1",
        position: 0,
        row: 0,
        column: 0
    });

    assert.equal(result.isValid, false);
    assert.ok(result.errors.includes("position must be a positive integer"));
    assert.ok(result.errors.includes("row must be a positive integer"));
    assert.ok(result.errors.includes("column must be a positive integer"));
});

test("workshop storage dimensions must be greater than zero when provided", () => {
    const result = validateWorkshopStoragePayload("levels", {
        shelfId: "shelf-1",
        name: "Balda 1",
        position: 1,
        width: 0,
        depth: 250
    });

    assert.equal(result.isValid, false);
    assert.ok(result.errors.includes("width must be greater than zero"));
});
