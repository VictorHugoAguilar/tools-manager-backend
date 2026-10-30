const test = require("node:test");
const assert = require("node:assert/strict");
const firebaseAdmin = require("../../src/config/firebaseAdmin");

const originalGetAdminDatabase = firebaseAdmin.getAdminDatabase;
const uid = "user-123";
let profiles;
let profileWrites = 0;

const database = {
    ref(path = "") {
        return {
            child(childPath) {
                return database.ref([path, childPath].filter(Boolean).join("/"));
            },
            async get() {
                const value = path === "authUsers"
                    ? profiles
                    : path.startsWith("authUsers/")
                        ? profiles[path.slice("authUsers/".length)] ?? null
                        : null;
                return {
                    exists: () => value !== null,
                    val: () => value
                };
            },
            async update(changes) {
                profileWrites += 1;
                const profileId = path.slice("authUsers/".length);
                profiles[profileId] = { ...profiles[profileId], ...changes };
            },
            async transaction(update) {
                const proposed = update(structuredClone(profiles));
                if (!proposed) return { committed: false };
                profiles = proposed;
                return {
                    committed: true,
                    snapshot: {
                        child: (childUid) => ({ val: () => profiles[childUid] })
                    }
                };
            }
        };
    }
};

firebaseAdmin.getAdminDatabase = () => database;
const { updateProfileGuarded } = require("../../src/services/userService");

test.after(() => {
    firebaseAdmin.getAdminDatabase = originalGetAdminDatabase;
});

test.beforeEach(() => {
    profiles = {
        [uid]: {
            firstName: "Ada",
            lastName: "Lovelace",
            email: "ada@example.com",
            roleId: "user",
            isActive: true
        },
        admin: {
            firstName: "Grace",
            lastName: "Hopper",
            email: "grace@example.com",
            roleId: "admin",
            isActive: true
        }
    };
    profileWrites = 0;
});

for (const [description, changes] of [
    ["role", { roleId: "admin" }],
    ["status", { isActive: false }]
]) {
    test(`a ${description} update changes only the target user profile`, async () => {
        const updated = await updateProfileGuarded(uid, changes);

        assert.equal(updated.roleId, changes.roleId ?? "user");
        assert.equal(updated.isActive, changes.isActive ?? true);
        assert.equal(profiles.admin.roleId, "admin");
        assert.equal(profileWrites, 1);
    });

    test(`a missing user returns not found for a ${description} update`, async () => {
        delete profiles[uid];
        const updated = await updateProfileGuarded(uid, changes);

        assert.equal(updated, null);
    });
}

test("admin demotion is rejected when it would remove the last active administrator", async () => {
    await assert.rejects(
        updateProfileGuarded("admin", { roleId: "user" }),
        { statusCode: 409, message: "No se puede dejar el sistema sin administradores activos." }
    );
    assert.equal(profiles.admin.roleId, "admin");
    assert.equal(profileWrites, 0);
});

test("admin demotion can proceed while another active administrator remains", async () => {
    profiles.secondAdmin = {
        firstName: "Katherine",
        lastName: "Johnson",
        email: "katherine@example.com",
        roleId: "admin",
        isActive: true
    };
    const updated = await updateProfileGuarded("admin", { roleId: "user" });

    assert.equal(updated.roleId, "user");
    assert.equal(profiles.secondAdmin.roleId, "admin");
});

test("the last active administrator cannot be deactivated", async () => {
    await assert.rejects(
        updateProfileGuarded("admin", { isActive: false }),
        { statusCode: 409, message: "No se puede dejar el sistema sin administradores activos." }
    );
    assert.equal(profiles.admin.isActive, true);
});
