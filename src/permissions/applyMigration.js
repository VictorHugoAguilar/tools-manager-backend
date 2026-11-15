const { MAX_ROOT_BYTES, transactPermissionRole } = require("../audit/businessOutbox");
const { inspectRolePermissionMigration, planRolePermissionMigration } = require("./migration");

function validateRoot(root) {
    if (!root || typeof root !== "object" || Array.isArray(root)) {
        throw new Error("La base de datos no contiene datos de autenticación válidos.");
    }
    if (Buffer.byteLength(JSON.stringify(root), "utf8") > MAX_ROOT_BYTES) {
        throw new Error("La base supera el límite seguro para la auditoría de negocio.");
    }
    const inspection = inspectRolePermissionMigration(root.authRoles ?? {}, root.authUsers ?? {});
    if (inspection.missingRoles) throw new Error("Hay usuarios con roles inexistentes; corrígelos antes de migrar.");
    if (!inspection.activeManagers) throw new Error("No hay ningún administrador de permisos activo.");
    return inspection;
}

async function applyRolePermissionMigration(database) {
    const snapshot = await database.ref().get();
    const root = snapshot.val();
    validateRoot(root);
    const roleIds = Object.keys(planRolePermissionMigration(root.authRoles ?? {})).sort();
    const updatedRoles = [];
    for (const id of roleIds) {
        const result = await transactPermissionRole({
            id, database, actorId: "system:module-permissions-migration", action: "role.profile.updated",
            change: (current, roles, latestRoot) => {
                validateRoot(latestRoot);
                const plan = planRolePermissionMigration(roles);
                const additions = Object.hasOwn(plan, id) ? plan[id] : null;
                if (!current || !additions) return { unchanged: true, result: false };
                const before = Object.keys(current.permissions || {}).filter((key) => current.permissions[key] === true).sort();
                const permissions = { ...current.permissions, ...additions };
                const after = Object.keys(permissions).filter((key) => permissions[key] === true).sort();
                return {
                    value: { ...current, permissions },
                    result: true,
                    auditDetails: {
                        permissionsBefore: JSON.stringify(before), permissionsAfter: JSON.stringify(after),
                        activeBefore: current.active !== false, activeAfter: current.active !== false
                    }
                };
            }
        });
        if (result === null) throw new Error("No se pudo confirmar la migración del perfil.");
        if (result) updatedRoles.push(id);
    }
    return { updatedRoles };
}

module.exports = { applyRolePermissionMigration };
