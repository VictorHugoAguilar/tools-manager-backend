const { initializeApp, getApps, getApp } = require("firebase/app");
const { getDatabase } = require("firebase/database");
const { getStorage } = require("firebase/storage");

let databaseInstance;
let storageInstance;

function normalizeStorageBucket(value) {
    return String(value || "").replace(/^gs:\/\//, "");
}

function buildFirebaseConfig() {
    const firebaseConfig = {
        apiKey: process.env.FIREBASE_API_KEY,
        databaseURL: process.env.FIREBASE_DATABASE_URL,
        projectId: process.env.FIREBASE_PROJECT_ID,
        storageBucket: normalizeStorageBucket(process.env.FIREBASE_STORAGE_BUCKET)
    };

    const missingKeys = Object.entries(firebaseConfig)
        .filter(([, value]) => !value)
        .map(([key]) => key);

    if (missingKeys.length > 0) {
        throw new Error(
            `Firebase configuration is incomplete: ${missingKeys.join(", ")}`
        );
    }

    return firebaseConfig;
}

async function connectToDatabase() {
    if (databaseInstance && storageInstance) {
        return databaseInstance;
    }

    const firebaseConfig = buildFirebaseConfig();
    const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);

    databaseInstance = getDatabase(app);
    storageInstance = getStorage(app);
    return databaseInstance;
}

function getDatabaseInstance() {
    if (!databaseInstance) {
        throw new Error("Firebase database has not been initialized");
    }

    return databaseInstance;
}

function getStorageInstance() {
    if (!storageInstance) {
        throw new Error("Firebase storage has not been initialized");
    }

    return storageInstance;
}

module.exports = {
    buildFirebaseConfig,
    connectToDatabase,
    getDatabaseInstance,
    getStorageInstance
};
