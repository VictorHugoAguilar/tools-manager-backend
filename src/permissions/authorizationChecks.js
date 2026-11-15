const { calculateEffectivePermissions } = require("./effectivePermissions");

function fail(message, statusCode) {
    throw Object.assign(new Error(message), { statusCode });
}

function isPermissionManager(profile, roles) {
    if (!profile || profile.isActive === false) return false;
    const roleId = profile.roleId || "user";
    const role = Object.hasOwn(roles, roleId) ? roles[roleId] : null;
    if (!role || role.active === false) return false;
    const permissions = calculateEffectivePermissions(role.permissions ?? {}, profile.permissionExceptions ?? {});
    return ["app:access", "users:manage", "roles:manage"].every((permission) => permissions.includes(permission));
}

function validateManagerContext({ actorTokenHash, actorSessionVersion }) {
    if (!Number.isSafeInteger(actorSessionVersion) || actorSessionVersion < 0 ||
        typeof actorTokenHash !== "string" || !/^[0-9a-f]{64}$/.test(actorTokenHash)) {
        fail("La sesión de administración no es válida.", 401);
    }
}

function requirePermissionManager(root, { actorId, actorTokenHash, actorSessionVersion }) {
    const users = root.authUsers || {};
    const roles = root.authRoles || {};
    const actor = Object.hasOwn(users, actorId) ? users[actorId] : null;
    const session = root.authSessions?.[actorTokenHash];
    if (!actor || actor.isActive === false ||
        (Number(actor.sessionVersion) || 0) !== actorSessionVersion ||
        !session || session.uid !== actorId || session.sessionVersion !== actorSessionVersion ||
        !Number.isFinite(session.expiresAt) || session.expiresAt <= Date.now()) {
        fail("La sesión de administración no es válida.", 401);
    }
    if (!isPermissionManager(actor, roles)) fail("No tienes permisos para administrar permisos.", 403);
    return actor;
}

function permissionsForProfile(profile, roles) {
    const roleId = profile.roleId || "user";
    const role = Object.hasOwn(roles, roleId) ? roles[roleId] : null;
    if (!role) fail("El usuario tiene un rol inexistente.", 409);
    return calculateEffectivePermissions(role.permissions ?? {}, profile.permissionExceptions ?? {});
}

function requireDelegablePermissions(actor, roles, permissions) {
    const actorPermissions = new Set(permissionsForProfile(actor, roles));
    if (permissions.some((permission) => !actorPermissions.has(permission))) {
        fail("No puedes administrar permisos que no posees.", 403);
    }
}

function requireManageableProfile(actor, roles, profile) {
    requireDelegablePermissions(actor, roles, permissionsForProfile(profile, roles));
}

module.exports = {
    fail, isPermissionManager, validateManagerContext, requirePermissionManager,
    requireDelegablePermissions, requireManageableProfile
};
