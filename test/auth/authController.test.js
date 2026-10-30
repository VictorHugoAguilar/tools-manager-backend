const test = require("node:test");
const assert = require("node:assert/strict");
const {
    controller,
    getPublicUser,
    validateCredentials,
    validateNewPassword,
    validateProfileInput
} = require("../../src/controllers/authController");
const { CSRF_COOKIE } = require("../../src/middleware/authMiddleware");
const { hashPassword, verifyPassword } = require("../../src/services/passwordService");

test("login validation normalizes email without applying new-password policy", () => {
    assert.equal(validateCredentials("  PERSON@EXAMPLE.COM ", "old"), "person@example.com");
});

test("new passwords require a minimum length and letters and numbers", () => {
    assert.equal(validateNewPassword("Workshop1234"), "Workshop1234");
    assert.throws(() => validateNewPassword("short"), { statusCode: 400 });
    assert.throws(() => validateNewPassword("letters-only"), { statusCode: 400 });
});

test("profile validation strips untrusted role assignment fields", () => {
    const profile = validateProfileInput({
        firstName: "Ada",
        lastName: "Lovelace",
        email: "ada@example.com",
        roleId: "admin"
    });
    assert.equal(Object.hasOwn(profile, "roleId"), false);
});

test("profile validation normalizes email and rejects missing names", () => {
    assert.deepEqual(validateProfileInput({
        firstName: " Ada ",
        lastName: " Lovelace ",
        email: " ADA@EXAMPLE.COM "
    }), {
        firstName: "Ada",
        lastName: "Lovelace",
        email: "ada@example.com"
    });
    assert.throws(() => validateProfileInput({ firstName: "", lastName: "Lovelace", email: "a@b.com" }), {
        statusCode: 400
    });
});

test("public user response omits unrecognized sensitive fields", () => {
    const user = getPublicUser({
        id: "uid",
        firstName: "Ada",
        lastName: "Lovelace",
        email: "ada@example.com",
        profileImage: "",
        roleId: "user",
        roleName: "Usuario",
        isActive: true,
        permissions: ["app:access"],
        passwordHash: "must-not-be-returned"
    });

    assert.equal(Object.hasOwn(user, "passwordHash"), false);
    assert.equal(user.email, "ada@example.com");
});

test("CSRF endpoint returns the session token and sets a cross-origin cookie in production", () => {
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    const headers = {};
    const cookies = [];
    let responseBody;
    const response = {
        append: (name, value) => cookies.push([name, value]),
        set: (name, value) => headers[name] = value,
        json: (body) => responseBody = body
    };

    try {
        controller.csrf({ headers: {} }, response);
    } finally {
        if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = previousNodeEnv;
    }

    assert.equal(typeof responseBody.csrfToken, "string");
    assert.equal(responseBody.csrfToken.length, 43);
    assert.equal(headers["Cache-Control"], "no-store");
    assert.equal(cookies[0][0], "Set-Cookie");
    assert.match(cookies[0][1], new RegExp(`^${CSRF_COOKIE}=${responseBody.csrfToken};`));
    assert.match(cookies[0][1], /SameSite=None; Secure/);
});

test("password hashes are salted, verifiable, and never stored as plaintext", async () => {
    const firstHash = await hashPassword("Workshop1234");
    const secondHash = await hashPassword("Workshop1234");
    assert.notEqual(firstHash, "Workshop1234");
    assert.notEqual(firstHash, secondHash);
    assert.equal(await verifyPassword("Workshop1234", firstHash), true);
    assert.equal(await verifyPassword("WrongPassword123", firstHash), false);
    assert.equal(await verifyPassword("Workshop1234", "invalid"), false);
});
