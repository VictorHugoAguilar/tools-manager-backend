require("dotenv").config();

const { getAdminApp, getAdminDatabase } = require("../src/config/firebaseAdmin");
const { applyRolePermissionMigration } = require("../src/permissions/applyMigration");

async function main() {
    if (process.argv.length !== 3 || process.argv[2] !== "--apply") {
        throw new Error("Confirma la migración con --apply después de revisar permissions:preview.");
    }
    const app = getAdminApp();
    try {
        const result = await applyRolePermissionMigration(getAdminDatabase());
        console.log(JSON.stringify(result, null, 2));
    } finally {
        await app.delete();
    }
}

main().catch((error) => {
    console.error("No se pudo completar la migración de permisos; se puede reanudar.", error);
    process.exitCode = 1;
});
