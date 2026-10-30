const { applicationDefault, getApps, initializeApp } = require("firebase-admin/app");
const { getDatabase } = require("firebase-admin/database");

let adminApp;

function getAdminApp() {
    if (!adminApp) {
        adminApp = getApps().find((app) => app.name === "tools-manager-admin") ||
            initializeApp({
                credential: applicationDefault(),
                projectId: process.env.FIREBASE_PROJECT_ID,
                databaseURL: process.env.FIREBASE_DATABASE_URL,
                storageBucket: process.env.FIREBASE_STORAGE_BUCKET
            }, "tools-manager-admin");
    }

    return adminApp;
}

function getAdminDatabase() {
    return getDatabase(getAdminApp());
}

module.exports = {
    getAdminDatabase
};
