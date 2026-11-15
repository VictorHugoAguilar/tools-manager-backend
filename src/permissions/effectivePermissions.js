const { MODULES } = require("./moduleCatalog");

const modulePermissions = new Set(MODULES.map((module) => module.permission));

function calculateEffectivePermissions(rolePermissions, exceptions = {}) {
    if (!rolePermissions || typeof rolePermissions !== "object" || Array.isArray(rolePermissions) ||
        !exceptions || typeof exceptions !== "object" || Array.isArray(exceptions)) {
        throw new TypeError("Permisos o excepciones no válidos.");
    }

    const effective = new Set(
        Object.entries(rolePermissions).filter(([, allowed]) => allowed === true).map(([permission]) => permission)
    );
    for (const [permission, decision] of Object.entries(exceptions)) {
        if (!modulePermissions.has(permission) || !["allow", "deny"].includes(decision)) {
            throw new TypeError("Excepción de permiso no válida.");
        }
        if (decision === "allow") effective.add(permission);
        else effective.delete(permission);
    }
    return [...effective].sort();
}

module.exports = { calculateEffectivePermissions };
