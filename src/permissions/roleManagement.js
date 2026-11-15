const { transactPermissionRole, transactRolePermissions } = require("../audit/businessOutbox");
const { clearAuthenticationCache } = require("../services/authSessionService");
const { ALL_PERMISSIONS, LEGACY_PERMISSIONS } = require("./permissionCatalog");
const {
    fail, isPermissionManager, validateManagerContext, requirePermissionManager,
    requireDelegablePermissions, requireManageableProfile
} = require("./authorizationChecks");

function validateId(id) {
    if (typeof id !== "string" || !/^[a-z][a-z0-9_-]{0,40}$/.test(id)) {
        fail("El identificador del perfil no es válido.", 400);
    }
}

function validateDetails(name, description) {
    if (typeof name !== "string" || !name.trim() || name.trim().length > 80 ||
        typeof description !== "string" || description.trim().length > 500) {
        fail("El nombre o la descripción del perfil no son válidos.", 400);
    }
    return { name: name.trim(), description: description.trim() };
}

function validatePermissions(permissions) {
    if (!Array.isArray(permissions) ||
        permissions.some((permission) => typeof permission !== "string" || !Object.hasOwn(ALL_PERMISSIONS, permission)) ||
        new Set(permissions).size !== permissions.length) {
        fail("La lista de permisos del perfil no es válida.", 400);
    }
    return [...permissions].sort();
}

function rolePermissions(role) {
    const permissions = role.permissions === undefined || role.permissions === null ? {} : role.permissions;
    if (typeof permissions !== "object" || Array.isArray(permissions) ||
        Object.entries(permissions).some(([permission, allowed]) =>
            !Object.hasOwn(ALL_PERMISSIONS, permission) || typeof allowed !== "boolean")) {
        fail("El perfil contiene permisos desconocidos.", 409);
    }
    return Object.keys(permissions).filter((permission) => permissions[permission] === true).sort();
}

function auditDetails(before, after) {
    return {
        permissionsBefore: JSON.stringify(before ? rolePermissions(before) : []),
        permissionsAfter: JSON.stringify(rolePermissions(after)),
        activeBefore: before ? before.active !== false : false,
        activeAfter: after.active !== false
    };
}

function requireManageableAssignments(actor, roles, root, roleId, updated) {
    const nextRoles = { ...roles, [roleId]: updated };
    for (const profile of Object.values(root.authUsers || {})) {
        if ((profile?.roleId || "user") !== roleId) continue;
        requireManageableProfile(actor, roles, profile);
        requireManageableProfile(actor, nextRoles, profile);
    }
    if (!Object.values(root.authUsers || {}).some((profile) => isPermissionManager(profile, nextRoles))) {
        fail("No se puede dejar el sistema sin administradores de permisos.", 409);
    }
}

async function transactRole(context, action, change) {
    const { actorId, actorTokenHash, actorSessionVersion, roleId, database } = context;
    validateId(roleId);
    validateManagerContext({ actorTokenHash, actorSessionVersion });
    try {
        const transaction = action === "role.permissions.updated" ? transactRolePermissions : transactPermissionRole;
        return await transaction({
            id: roleId, actorId, action,
            ...(database ? { database } : {}),
            change: (current, roles, root) => {
                const actor = requirePermissionManager(root, { actorId, actorTokenHash, actorSessionVersion });
                return change(current, roles, root, actor);
            }
        });
    } finally {
        clearAuthenticationCache();
    }
}

async function createPermissionRole(context) {
    const { name, description = "", permissions, sourceRoleId } = context;
    const details = validateDetails(name, description);
    if (sourceRoleId !== undefined) validateId(sourceRoleId);
    if (sourceRoleId !== undefined && permissions !== undefined) {
        fail("La duplicación no admite permisos adicionales.", 400);
    }
    const explicit = sourceRoleId === undefined ? validatePermissions(permissions) : null;
    return transactRole(context, "role.profile.created", (current, roles, _root, actor) => {
        if (current) fail("El perfil ya existe.", 409);
        const source = sourceRoleId === undefined ? null : Object.hasOwn(roles, sourceRoleId) ? roles[sourceRoleId] : null;
        if (sourceRoleId !== undefined && !source) fail("El perfil de origen no existe.", 404);
        const selected = source ? rolePermissions(source) : explicit;
        requireDelegablePermissions(actor, roles, selected);
        const now = new Date().toISOString();
        const role = {
            ...details, permissions: Object.fromEntries(selected.map((id) => [id, true])),
            active: true, modulePermissionsConfigured: true,
            createdAt: now, updatedAt: now, createdBy: context.actorId, updatedBy: context.actorId
        };
        return { value: role, result: { id: context.roleId, ...role }, auditDetails: auditDetails(null, role) };
    });
}

async function updatePermissionRole(context) {
    const details = validateDetails(context.name, context.description);
    const selected = validatePermissions(context.permissions);
    return transactRole(context, "role.profile.updated", (current, roles, root, actor) => {
        if (!current) return null;
        if ((actor.roleId || "user") === context.roleId) fail("No puedes modificar tu propio perfil de permisos.", 409);
        const before = rolePermissions(current);
        requireDelegablePermissions(actor, roles, before);
        requireDelegablePermissions(actor, roles, selected);
        if (context.roleId === "admin" &&
            ["app:access", "users:manage", "roles:manage"].some((permission) => !selected.includes(permission))) {
            fail("El perfil administrador debe conservar sus permisos de gestión.", 409);
        }
        if (current.modulePermissionsConfigured === true &&
            current.name === details.name && (current.description || "") === details.description &&
            JSON.stringify(before) === JSON.stringify(selected)) {
            return { unchanged: true, result: { id: context.roleId, ...current } };
        }
        const updated = {
            ...current, ...details,
            permissions: {
                ...Object.fromEntries(Object.entries(current.permissions || {}).filter(([, allowed]) => allowed === false)),
                ...Object.fromEntries(selected.map((id) => [id, true]))
            },
            modulePermissionsConfigured: true,
            updatedAt: new Date().toISOString(), updatedBy: context.actorId
        };
        requireManageableAssignments(actor, roles, root, context.roleId, updated);
        return { value: updated, result: { id: context.roleId, ...updated }, auditDetails: auditDetails(current, updated) };
    });
}

async function updateLegacyRolePermissions(context) {
    const { permissions } = context;
    if (!Array.isArray(permissions) ||
        permissions.some((permission) => typeof permission !== "string" || !Object.hasOwn(LEGACY_PERMISSIONS, permission)) ||
        new Set(permissions).size !== permissions.length) {
        fail("La lista de permisos del rol no es válida.", 400);
    }
    return transactRole(context, "role.permissions.updated", (current, roles, root, actor) => {
        if (!current) return null;
        if ((actor.roleId || "user") === context.roleId) fail("No puedes modificar tu propio perfil de permisos.", 409);
        const before = rolePermissions(current);
        const nextPermissions = {
            ...Object.fromEntries(Object.entries(current.permissions || {}).filter(([id]) => !Object.hasOwn(LEGACY_PERMISSIONS, id))),
            ...Object.fromEntries(permissions.map((id) => [id, true]))
        };
        const updated = { ...current, permissions: nextPermissions };
        const after = rolePermissions(updated);
        requireDelegablePermissions(actor, roles, before);
        requireDelegablePermissions(actor, roles, after);
        if (context.roleId === "admin" &&
            ["app:access", "users:manage", "roles:manage"].some((permission) => !after.includes(permission))) {
            fail("El perfil administrador debe conservar sus permisos de gestión.", 409);
        }
        requireManageableAssignments(actor, roles, root, context.roleId, updated);
        return {
            value: updated, result: { id: context.roleId, name: current.name, permissions: after },
            auditDetails: { permissionsBefore: JSON.stringify(before), permissionsAfter: JSON.stringify(after) }
        };
    });
}

async function deactivatePermissionRole(context) {
    return transactRole(context, "role.profile.deactivated", (current, roles, root, actor) => {
        if (!current) return null;
        if ((actor.roleId || "user") === context.roleId) fail("No puedes desactivar tu propio perfil.", 409);
        requireDelegablePermissions(actor, roles, rolePermissions(current));
        if (["admin", "user"].includes(context.roleId)) fail("No se puede desactivar un perfil predeterminado.", 409);
        if (current.active === false) return { unchanged: true, result: { id: context.roleId, ...current } };
        if (Object.values(root.authUsers || {}).some((profile) => (profile?.roleId || "user") === context.roleId)) {
            fail("El perfil está asignado a usuarios.", 409);
        }
        const updated = { ...current, active: false, updatedAt: new Date().toISOString(), updatedBy: context.actorId };
        return { value: updated, result: { id: context.roleId, ...updated }, auditDetails: auditDetails(current, updated) };
    });
}

module.exports = { createPermissionRole, updatePermissionRole, updateLegacyRolePermissions, deactivatePermissionRole };
