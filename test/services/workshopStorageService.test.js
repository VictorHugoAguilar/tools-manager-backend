const test = require("node:test");
const assert = require("node:assert/strict");
const { organizerFitsLevel } = require("../../src/services/workshopStorageService");

test("workshop organizer fits when its dimensions fit the shelf level", () => {
    assert.equal(
        organizerFitsLevel({ width: 300, depth: 200 }, { width: 400, depth: 250 }),
        true
    );
});

test("workshop organizer can be rotated to fit the shelf level", () => {
    assert.equal(
        organizerFitsLevel({ width: 300, depth: 200 }, { width: 250, depth: 350 }),
        true
    );
});

test("workshop organizer is rejected when it exceeds shelf dimensions", () => {
    assert.equal(
        organizerFitsLevel({ width: 400, depth: 300 }, { width: 350, depth: 250 }),
        false
    );
});

test("workshop organizer fit remains unchecked when physical dimensions are absent", () => {
    assert.equal(
        organizerFitsLevel({ width: 400 }, { width: 350, depth: 250 }),
        true
    );
});
