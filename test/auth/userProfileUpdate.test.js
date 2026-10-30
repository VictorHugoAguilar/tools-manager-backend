const test = require("node:test");
const assert = require("node:assert/strict");
const firebaseAdmin = require("../../src/config/firebaseAdmin");

const originalGetAdminDatabase = firebaseAdmin.getAdminDatabase;
let profilePath;
let savedProfile = {
    firstName: "Ada",
    lastName: "Lovelace",
    email: "ada@example.com",
    profileImage: "",
    roleId: "user"
};
let updateCount = 0;
const profileRef = {
    update: async (changes) => {
        updateCount += 1;
        if (!savedProfile) throw new Error("Cannot update missing test profile");
        savedProfile = { ...savedProfile, ...changes };
    },
    get: async () => ({
        exists: () => Boolean(savedProfile),
        val: () => savedProfile
    })
};
const database = {
    ref: (path) => {
        if (path === "authUsers") return {
            get: async () => ({
                val: () => savedProfile ? { "user-123": savedProfile } : {}
            }),
            child: (uid) => {
                profilePath = `${path}/${uid}`;
                return profileRef;
            }
        };
        throw new Error(`Unexpected database path: ${path}`);
    }
};

firebaseAdmin.getAdminDatabase = () => database;
const userServicePath = require.resolve("../../src/services/userService");
delete require.cache[userServicePath];
const { updateProfile, updateProfileGuarded } = require(userServicePath);

test.after(() => {
    firebaseAdmin.getAdminDatabase = originalGetAdminDatabase;
    delete require.cache[userServicePath];
});

test("profile updates only the individual user record", async () => {
    savedProfile = {
        firstName: "Ada",
        lastName: "Lovelace",
        email: "ada@example.com",
        profileImage: "",
        roleId: "user"
    };
    updateCount = 0;
    const updated = await updateProfile("user-123", {
        profileImage: "https://example.com/avatar.png"
    });

    assert.equal(profilePath, "authUsers/user-123");
    assert.equal(updateCount, 1);
    assert.equal(updated.profileImage, "https://example.com/avatar.png");
    assert.equal(updated.firstName, "Ada");
});

test("profile update returns null when the user record is missing", async () => {
    savedProfile = null;
    updateCount = 0;
    const updated = await updateProfile("missing-user", {
        profileImage: "https://example.com/avatar.png"
    });

    assert.equal(updated, null);
    assert.equal(updateCount, 0);
});

test("profile update preserves fields that were not changed", async () => {
    savedProfile = {
        firstName: "Ada",
        lastName: "Lovelace",
        email: "ada@example.com",
        profileImage: "",
        roleId: "user"
    };

    const updated = await updateProfile("user-123", { firstName: "Augusta" });

    assert.equal(updated.firstName, "Augusta");
    assert.equal(updated.lastName, "Lovelace");
    assert.equal(updated.email, "ada@example.com");
});

test("profile update propagates database write errors", async () => {
    savedProfile = {
        firstName: "Ada",
        lastName: "Lovelace",
        email: "ada@example.com",
        profileImage: "",
        roleId: "user"
    };
    profileRef.update = async () => {
        throw Object.assign(new Error("Firebase write failed"), { code: "permission_denied" });
    };

    await assert.rejects(
        updateProfile("user-123", { firstName: "Augusta" }),
        { code: "permission_denied" }
    );
    profileRef.update = async (changes) => {
        updateCount += 1;
        savedProfile = { ...savedProfile, ...changes };
    };
});

test("admin profile edits update only the user's record", async () => {
    savedProfile = {
        firstName: "Ada",
        lastName: "Lovelace",
        email: "ada@example.com",
        profileImage: "",
        roleId: "user"
    };
    updateCount = 0;

    const updated = await updateProfileGuarded("user-123", { firstName: "Augusta" });

    assert.equal(updated.firstName, "Augusta");
    assert.equal(updateCount, 1);
});

test("admin profile edit rejects an email already used by another profile", async () => {
    const secondProfile = {
        firstName: "Grace",
        lastName: "Hopper",
        email: "grace@example.com",
        roleId: "user"
    };
    savedProfile = {
        firstName: "Ada",
        lastName: "Lovelace",
        email: "ada@example.com",
        profileImage: "",
        roleId: "user"
    };
    database.ref = (path) => {
        if (path === "authUsers") return {
            get: async () => ({
                val: () => ({ "user-123": savedProfile, "user-456": secondProfile })
            }),
            child: () => profileRef
        };
        throw new Error(`Unexpected database path: ${path}`);
    };

    await assert.rejects(
        updateProfileGuarded("user-123", { email: "grace@example.com" }),
        { statusCode: 409 }
    );
    assert.equal(savedProfile.email, "ada@example.com");
    database.ref = (path) => {
        if (path === "authUsers") return {
            get: async () => ({
                val: () => savedProfile ? { "user-123": savedProfile } : {}
            }),
            child: (uid) => {
                profilePath = `${path}/${uid}`;
                return profileRef;
            }
        };
        throw new Error(`Unexpected database path: ${path}`);
    };
});
