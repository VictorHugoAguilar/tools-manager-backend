const test = require("node:test");
const assert = require("node:assert/strict");
const { validateRepairPayload } = require("../../src/validators/repairHistoryValidator");

test("validateRepairPayload accepts a valid repair payload", () => {
    const result = validateRepairPayload({
        entryDate: "2026-04-10",
        exitDate: "2026-04-12",
        status: "Reparado",
        priority: "Normal",
        issue: "No enciende",
        description: "Se reemplaza componente y se valida funcionamiento.",
        technicianId: "tech-1",
        cost: "250",
        observations: "Entrega prevista hoy"
    });

    assert.equal(result.isValid, true);
    assert.equal(result.data.cost, 250);
    assert.equal(result.data.technicianId, "tech-1");
});

test("validateRepairPayload accepts numeric and comma-decimal costs", () => {
    const numericCost = validateRepairPayload({
        entryDate: "2026-04-10",
        exitDate: "2026-04-12",
        status: "Reparado",
        priority: "Normal",
        issue: "No enciende",
        description: "Se reemplaza componente y se valida funcionamiento.",
        technicianId: "tech-1",
        cost: 250.5,
        observations: ""
    });
    const commaDecimalCost = validateRepairPayload({
        entryDate: "2026-04-10",
        exitDate: "2026-04-12",
        status: "Reparado",
        priority: "Normal",
        issue: "No enciende",
        description: "Se reemplaza componente y se valida funcionamiento.",
        technicianId: "tech-1",
        cost: "250,5",
        observations: ""
    });

    assert.equal(numericCost.isValid, true);
    assert.equal(numericCost.data.cost, 250.5);
    assert.equal(commaDecimalCost.isValid, true);
    assert.equal(commaDecimalCost.data.cost, 250.5);
});

test("validateRepairPayload keeps cost optional when omitted or empty", () => {
    const withoutCost = validateRepairPayload({
        entryDate: "2026-04-10",
        exitDate: "2026-04-12",
        status: "Reparado",
        priority: "Normal",
        issue: "No enciende",
        description: "Se reemplaza componente y se valida funcionamiento.",
        technicianId: "tech-1",
        observations: ""
    });
    const emptyCost = validateRepairPayload({
        entryDate: "2026-04-10",
        exitDate: "2026-04-12",
        status: "Reparado",
        priority: "Normal",
        issue: "No enciende",
        description: "Se reemplaza componente y se valida funcionamiento.",
        technicianId: "tech-1",
        cost: "",
        observations: ""
    });

    assert.equal(withoutCost.isValid, true);
    assert.equal(withoutCost.data.cost, null);
    assert.equal(emptyCost.isValid, true);
    assert.equal(emptyCost.data.cost, null);
});

test("validateRepairPayload rejects missing fields and invalid cost", () => {
    const result = validateRepairPayload({
        entryDate: "",
        exitDate: "",
        status: "",
        priority: "",
        issue: "",
        description: "",
        technicianId: "",
        cost: -10
    });

    assert.equal(result.isValid, false);
    assert.ok(result.errors.includes("entryDate is required and must be a non-empty string"));
    assert.ok(result.errors.includes("cost must be a valid non-negative number"));
});
