const test = require("node:test");
const assert = require("node:assert/strict");
const { buildFirebaseConfig } = require("../../src/config/database");

test("Firebase database configuration does not require Firebase Authentication settings", () => {
    const keys = [
        "FIREBASE_API_KEY",
        "FIREBASE_DATABASE_URL",
        "FIREBASE_PROJECT_ID",
        "FIREBASE_STORAGE_BUCKET",
        "FIREBASE_AUTH_DOMAIN",
        "FIREBASE_MESSAGING_SENDER_ID",
        "FIREBASE_APP_ID"
    ];
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    process.env.FIREBASE_API_KEY = "test-api-key";
    process.env.FIREBASE_DATABASE_URL = "https://example-default-rtdb.firebaseio.com";
    process.env.FIREBASE_PROJECT_ID = "example";
    process.env.FIREBASE_STORAGE_BUCKET = "example.firebasestorage.app";
    delete process.env.FIREBASE_AUTH_DOMAIN;
    delete process.env.FIREBASE_MESSAGING_SENDER_ID;
    delete process.env.FIREBASE_APP_ID;

    try {
        assert.deepEqual(buildFirebaseConfig(), {
            apiKey: "test-api-key",
            databaseURL: "https://example-default-rtdb.firebaseio.com",
            projectId: "example",
            storageBucket: "example.firebasestorage.app"
        });
    } finally {
        for (const key of keys) {
            if (previous[key] === undefined) delete process.env[key];
            else process.env[key] = previous[key];
        }
    }
});
