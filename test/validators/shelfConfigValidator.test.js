const test = require("node:test");
const assert = require("node:assert/strict");
const {
    DEFAULT_SHELF_CONFIG,
    normalizeStoredShelfConfig,
    validateShelfConfigPayload
} = require("../../src/validators/shelfConfigValidator");

test("validateShelfConfigPayload accepts the 1 to 10 boundaries", () => {
    assert.deepEqual(validateShelfConfigPayload({ rows: 1, columns: 10 }), {
        isValid: true,
        errors: [],
        data: { rows: 1, columns: 10 }
    });
});

test("validateShelfConfigPayload rejects zero and decimal dimensions", () => {
    const result = validateShelfConfigPayload({ rows: 0, columns: 10.5 });

    assert.equal(result.isValid, false);
    assert.ok(result.errors.some((error) => error.includes("rows")));
    assert.ok(result.errors.some((error) => error.includes("columns")));
});

test("validateShelfConfigPayload rejects dimensions over ten", () => {
    const result = validateShelfConfigPayload({ rows: 11, columns: 1 });

    assert.equal(result.isValid, false);
    assert.ok(result.errors.some((error) => error.includes("rows")));
});

test("normalizeStoredShelfConfig falls back for missing and invalid values", () => {
    assert.deepEqual(DEFAULT_SHELF_CONFIG, { rows: 5, columns: 6 });
    assert.deepEqual(normalizeStoredShelfConfig(undefined), { rows: 5, columns: 6 });
    assert.deepEqual(
        normalizeStoredShelfConfig({ rows: 0, columns: 11 }),
        { rows: 5, columns: 6 }
    );
});

