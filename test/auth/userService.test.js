const test = require("node:test");
const assert = require("node:assert/strict");
const { removesLastActiveAdmin } = require("../../src/services/userService");

const oneAdmin = {
    admin: { roleId: "admin", isActive: true },
    user: { roleId: "user", isActive: true }
};

test("last active administrator cannot be demoted, disabled or deleted", () => {
    assert.equal(removesLastActiveAdmin(oneAdmin, "admin", { roleId: "user" }), true);
    assert.equal(removesLastActiveAdmin(oneAdmin, "admin", { isActive: false }), true);
    assert.equal(removesLastActiveAdmin(oneAdmin, "admin", {}, { delete: true }), true);
});

test("administrator changes are allowed when another active administrator remains", () => {
    const profiles = {
        ...oneAdmin,
        secondAdmin: { roleId: "admin", isActive: true }
    };
    assert.equal(removesLastActiveAdmin(profiles, "admin", { roleId: "user" }), false);
});

test("inactive administrators do not count as active administrators", () => {
    const profiles = {
        admin: { roleId: "admin", isActive: true },
        inactive: { roleId: "admin", isActive: false }
    };
    assert.equal(removesLastActiveAdmin(profiles, "inactive", { isActive: false }), false);
});
