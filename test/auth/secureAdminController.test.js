const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { loadModuleWithMocks } = require("../helpers/loadModuleWithMocks");

function harness(overrides = {}) {
    const calls = [];
    const user = { id: "target", permissions: ["app:access"], roleId: "user" };
    const operation = (name, value = { userId: "target" }) => async (input) => {
        calls.push([name, input]);
        return value;
    };
    const controller = loadModuleWithMocks(path.resolve(__dirname, "../../src/controllers/secureAdminController.js"), {
        "./authController": { getPublicUser: (profile) => profile },
        "../services/userService": { getProfileWithPermissions: async () => user },
        "../services/userAvatarService": { validateUserAvatar: () => {} },
        "../services/toolImageStorageService": {
            uploadImageForUser: operation("upload", { downloadUrl: "https://storage/new" }),
            deleteImageByUrl: operation("deleteImage", true)
        },
        "../permissions/permissionManagement": {
            createManagedUser: operation("create"),
            updateManagedUser: operation("update"),
            assignUserRole: operation("role"),
            setManagedUserStatus: operation("status"),
            resetManagedUserPassword: operation("password"),
            deleteManagedUser: operation("delete", { userId: "target", profileImage: "" }),
            setManagedUserAvatar: operation("avatar", { userId: "target", previousImage: "https://storage/old" }),
            ...overrides
        },
        "../permissions/roleManagement": { updateLegacyRolePermissions: operation("permissions", { id: "user" }) }
    }).secureAdminController;
    const req = {
        authUser: { id: "actor", sessionVersion: 3, permissions: ["app:access", "users:manage", "roles:manage"] },
        authSession: { tokenHash: "a".repeat(64) }, params: { id: "target", roleId: "user" }, body: {}
    };
    const res = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(value) { this.body = value; return this; },
        send() { return this; }
    };
    return { controller, req, res, calls, user };
}

test("administrative writes forward the authenticated session to transactional services", async () => {
    const h = harness();
    for (const [action, body] of [
        ["create", { firstName: "Ada", lastName: "Lovelace", email: "a@example.test", password: "password" }],
        ["update", { firstName: "Ada" }],
        ["updateRole", { roleId: "user" }],
        ["updateStatus", { isActive: false }],
        ["resetPassword", { newPassword: "password" }],
        ["updatePermissions", { permissions: ["app:access"] }]
    ]) {
        await h.controller[action]({ ...h.req, body }, h.res, assert.fail);
    }
    await h.controller.delete(h.req, h.res, assert.fail);
    for (const [, input] of h.calls) {
        assert.equal(input.actorId, "actor");
        assert.equal(input.actorSessionVersion, 3);
        assert.equal(input.actorTokenHash, "a".repeat(64));
    }
});

test("avatar upload checks delegation before uploading and deletes only the transaction's previous image", async () => {
    const h = harness();
    await h.controller.uploadAvatar({ ...h.req, file: {} }, h.res, assert.fail);
    assert.deepEqual(h.calls.map(([name]) => name), ["upload", "avatar", "deleteImage"]);
    assert.equal(h.calls[2][1], "https://storage/old");
    h.calls.length = 0;
    h.user.permissions.push("module:inventory");
    let error;
    await h.controller.uploadAvatar({ ...h.req, file: {} }, h.res, (value) => { error = value; });
    assert.equal(error.statusCode, 403);
    assert.deepEqual(h.calls, []);
});

test("avatar upload preserves the new image on ambiguous transaction failure", async (t) => {
    const error = new Error("response lost");
    const h = harness({ setManagedUserAvatar: async () => { throw error; } });
    t.mock.method(console, "error", () => {});
    let received;
    await h.controller.uploadAvatar({ ...h.req, file: {} }, h.res, (value) => { received = value; });
    assert.equal(received, error);
    assert.deepEqual(h.calls.map(([name]) => name), ["upload"]);
});
