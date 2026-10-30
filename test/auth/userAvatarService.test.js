const test = require("node:test");
const assert = require("node:assert/strict");
const { validateUserAvatar } = require("../../src/services/userAvatarService");

test("avatar validation accepts a valid PNG signature", () => {
    const file = {
        mimetype: "image/png",
        buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
    };
    assert.doesNotThrow(() => validateUserAvatar(file));
});

test("avatar validation rejects MIME spoofing", () => {
    assert.throws(() => validateUserAvatar({
        mimetype: "image/png",
        buffer: Buffer.from("<svg></svg>")
    }), { statusCode: 400 });
});
