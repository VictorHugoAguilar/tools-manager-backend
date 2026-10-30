const test = require("node:test");
const assert = require("node:assert/strict");
const {
    parseCookies,
    requireAuthenticated,
    requireCsrf,
    requirePermission
} = require("../../src/middleware/authMiddleware");

test("cookie parser safely reads encoded cookies", () => {
    assert.deepEqual(parseCookies("a=1; tm_csrf=token%2Bvalue; broken"), {
        a: "1",
        tm_csrf: "token+value"
    });
});

test("authenticated API requests without a session are rejected", async () => {
    let status;
    let response;
    const res = {
        status(code) {
            status = code;
            return this;
        },
        json(body) {
            response = body;
            return this;
        }
    };

    await requireAuthenticated({ headers: {} }, res, assert.fail);
    assert.equal(status, 401);
    assert.match(response.message, /sesión/);
});

test("CSRF middleware rejects missing and mismatched tokens", () => {
    let status;
    const res = {
        status(code) {
            status = code;
            return this;
        },
        json() {
            return this;
        }
    };
    const req = { headers: { cookie: "tm_csrf=one" }, get: () => "two" };

    requireCsrf(req, res, assert.fail);
    assert.equal(status, 403);
});

test("permission middleware denies users without the requested permission", () => {
    let status;
    const res = {
        status(code) {
            status = code;
            return this;
        },
        json() {
            return this;
        }
    };

    requirePermission("users:manage")({ authUser: { permissions: ["app:access"] } }, res, assert.fail);
    assert.equal(status, 403);
});
