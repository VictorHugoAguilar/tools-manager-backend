require("dotenv").config();

const { getAdminApp, getAdminDatabase } = require("../src/config/firebaseAdmin");
const { inspectRolePermissionMigration } = require("../src/permissions/migration");

async function main() {
    if (process.argv.length !== 2) throw new Error("Este comando no acepta argumentos.");
    const app = getAdminApp();
    try {
        const database = getAdminDatabase();
        const [roles, users] = await Promise.all([
            database.ref("authRoles").get(),
            database.ref("authUsers").get()
        ]);
        const result = inspectRolePermissionMigration(roles.val() || {}, users.val() || {});
        console.log(JSON.stringify({ readOnly: true, snapshotIsAtomic: false, ...result }, null, 2));
    } finally {
        await app.delete();
    }
}

main().catch((error) => {
    console.error("No se pudo inspeccionar la migración de permisos.", error);
    process.exitCode = 1;
});
