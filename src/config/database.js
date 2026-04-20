const { initializeApp, getApps, getApp } = require("firebase/app");
const { getDatabase } = require("firebase/database");
const { getStorage } = require("firebase/storage");

let databaseInstance;
let storageInstance;

function buildFirebaseConfig() {
    const firebaseConfig = {
        apiKey: process.env.FIREBASE_API_KEY,
        authDomain: process.env.FIREBASE_AUTH_DOMAIN,
        databaseURL: process.env.FIREBASE_DATABASE_URL,
        projectId: process.env.FIREBASE_PROJECT_ID,
        storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
        messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
        appId: process.env.FIREBASE_APP_ID
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
    const storageBucketUrl = firebaseConfig.storageBucket.startsWith("gs://")
        ? firebaseConfig.storageBucket
        : `gs://${firebaseConfig.storageBucket}`;

    databaseInstance = getDatabase(app);
    storageInstance = getStorage(app, storageBucketUrl);
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
    connectToDatabase,
    getDatabaseInstance,
    getStorageInstance
};
