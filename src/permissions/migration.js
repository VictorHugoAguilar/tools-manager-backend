const { MODULES } = require("./moduleCatalog");
const { isPermissionManager } = require("./authorizationChecks");

function planRolePermissionMigration(roles) {
    if (!roles || typeof roles !== "object" || Array.isArray(roles)) {
        throw new TypeError("El catálogo de roles no es válido.");
    }

    const plan = {};
    for (const [id, role] of Object.entries(roles)) {
        if (!role || typeof role !== "object" || Array.isArray(role) ||
            (role.permissions !== undefined &&
                (!role.permissions || typeof role.permissions !== "object" || Array.isArray(role.permissions)))) {
            throw new TypeError(`El rol ${id} no es válido.`);
        }
        const permissions = role.permissions || {};
        if (permissions["app:access"] !== true || role.modulePermissionsConfigured === true) continue;
        const additions = {};
        for (const module of MODULES) {
            if (module.permission.startsWith("module:") && !Object.hasOwn(permissions, module.permission)) {
                additions[module.permission] = true;
            }
        }
        if (Object.keys(additions).length) {
            Object.defineProperty(plan, id, { value: additions, enumerable: true, configurable: true, writable: true });
        }
    }
    return plan;
}

function inspectRolePermissionMigration(roles, profiles) {
    const plan = planRolePermissionMigration(roles);
    if (!profiles || typeof profiles !== "object" || Array.isArray(profiles)) {
        throw new TypeError("El catálogo de usuarios no es válido.");
    }
    const assigned = Object.fromEntries(Object.keys(roles).map((id) => [id, 0]));
    let activeUsers = 0;
    let missingRoles = 0;
    let activeManagers = 0;
    for (const profile of Object.values(profiles)) {
        if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
            throw new TypeError("Hay un usuario con datos no válidos.");
        }
        const roleId = profile.roleId || "user";
        if (typeof roleId !== "string") throw new TypeError("Hay un usuario con un rol no válido.");
        if (profile.isActive !== false) activeUsers++;
        const role = Object.hasOwn(roles, roleId) ? roles[roleId] : null;
        if (!role) {
            missingRoles++;
            continue;
        }
        assigned[roleId]++;
        if (profile.isActive === false) continue;
        if (isPermissionManager(profile, roles)) activeManagers++;
    }
    return {
        users: Object.keys(profiles).length,
        activeUsers,
        missingRoles,
        activeManagers,
        roles: Object.keys(roles).map((id) => ({
            id, assignedUsers: assigned[id], addedPermissions: Object.keys(plan[id] || {}).sort()
        }))
    };
}

module.exports = { planRolePermissionMigration, inspectRolePermissionMigration };
