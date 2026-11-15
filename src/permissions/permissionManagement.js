const { transactAdminUser } = require("../audit/businessOutbox");
const { clearAuthenticationCache } = require("../services/authSessionService");
const { removesLastActiveAdmin } = require("../services/userService");
const { hashPassword } = require("../services/passwordService");
const { validateName, validateEmail, validateNewPassword } = require("../services/userInputValidation");
const { calculateEffectivePermissions } = require("./effectivePermissions");
const {
    fail, isPermissionManager, validateManagerContext, requirePermissionManager, requireManageableProfile
} = require("./authorizationChecks");

function validateRoleId(roleId) {
    if (typeof roleId !== "string" || !/^[a-z][a-z0-9_-]{0,40}$/.test(roleId)) {
        fail("El rol indicado no es válido.", 400);
    }
}

async function updateUserModuleExceptions({ actorId, actorTokenHash, actorSessionVersion, userId, exceptions, database }) {
    if (actorId === userId) fail("No puedes modificar tus propios permisos.", 409);
    validateManagerContext({ actorTokenHash, actorSessionVersion });
    if (!exceptions || typeof exceptions !== "object" || Array.isArray(exceptions)) {
        fail("Las excepciones de permisos no son válidas.", 400);
    }
    try {
        calculateEffectivePermissions({}, exceptions);
    } catch (error) {
        if (!(error instanceof TypeError)) throw error;
        fail("Las excepciones de permisos no son válidas.", 400);
    }
    const normalized = Object.fromEntries(Object.entries(exceptions).sort(([a], [b]) => a.localeCompare(b)));
    let result;
    try {
        result = await transactAdminUser({
            id: userId, actorId, action: "user.permissions.updated",
            ...(database ? { database } : {}),
            change: (current, users, root) => {
                const roles = root.authRoles || {};
                const actor = requirePermissionManager(root, { actorId, actorTokenHash, actorSessionVersion });
                if (!current) return null;
                requireManageableProfile(actor, roles, current);
                const before = current.permissionExceptions || {};
                calculateEffectivePermissions({}, before);
                const beforeJson = JSON.stringify(Object.fromEntries(Object.entries(before).sort(([a], [b]) => a.localeCompare(b))));
                const afterJson = JSON.stringify(normalized);
                if (beforeJson === afterJson) return { unchanged: true, result: { userId, exceptions: normalized } };
                const updated = { ...current, permissionExceptions: normalized, updatedAt: new Date().toISOString() };
                requireManageableProfile(actor, roles, updated);
                const stillHasManager = Object.entries(users).some(([id, profile]) =>
                    isPermissionManager(id === userId ? updated : profile, roles)
                );
                if (!stillHasManager) fail("No se puede dejar el sistema sin administradores de permisos.", 409);
                return {
                    value: updated,
                    result: { userId, exceptions: normalized },
                    auditDetails: { permissionsBefore: beforeJson, permissionsAfter: afterJson }
                };
            }
        });
    } finally {
        clearAuthenticationCache();
    }
    return result;
}

async function assignUserRole({ actorId, actorTokenHash, actorSessionVersion, userId, roleId, database }) {
    if (actorId === userId) fail("No puedes modificar tu propio rol.", 409);
    validateRoleId(roleId);
    validateManagerContext({ actorTokenHash, actorSessionVersion });
    try {
        return await transactAdminUser({
            id: userId, actorId, action: "user.role.updated",
            ...(database ? { database } : {}),
            change: (current, users, root) => {
                const actor = requirePermissionManager(root, { actorId, actorTokenHash, actorSessionVersion });
                if (!current) return null;
                const roles = root.authRoles || {};
                const role = Object.hasOwn(roles, roleId) ? roles[roleId] : null;
                if (!role || role.active === false) fail("El rol indicado no existe o está inactivo.", 400);
                requireManageableProfile(actor, roles, current);
                requireManageableProfile(actor, roles, { ...current, roleId });
                const previousRole = current.roleId || "user";
                if (previousRole === roleId) return { unchanged: true, result: { userId, roleId } };
                if (removesLastActiveAdmin(users, userId, { roleId })) {
                    fail("No se puede dejar el sistema sin administradores activos.", 409);
                }
                const updated = { ...current, roleId, updatedAt: new Date().toISOString() };
                if (!Object.entries(users).some(([id, profile]) =>
                    isPermissionManager(id === userId ? updated : profile, roles))) {
                    fail("No se puede dejar el sistema sin administradores de permisos.", 409);
                }
                return {
                    value: updated, result: { userId, roleId },
                    auditDetails: { roleBefore: previousRole, roleAfter: roleId }
                };
            }
        });
    } finally {
        clearAuthenticationCache();
    }
}

async function createManagedUser({
    actorId, actorTokenHash, actorSessionVersion, userId, firstName, lastName, email,
    password, roleId = "user", isActive = true, database
}) {
    validateManagerContext({ actorTokenHash, actorSessionVersion });
    validateRoleId(roleId);
    const name = validateName(firstName, "El nombre");
    const surname = validateName(lastName, "El apellido");
    const normalizedEmail = validateEmail(email);
    validateNewPassword(password);
    if (typeof isActive !== "boolean") fail("El estado debe ser activo o inactivo.", 400);
    const passwordHash = await hashPassword(password);
    try {
        const result = await transactAdminUser({
            id: userId, actorId, action: "user.created",
            ...(database ? { database } : {}),
            change: (current, users, root) => {
                const actor = requirePermissionManager(root, { actorId, actorTokenHash, actorSessionVersion });
                if (current) fail("La cuenta ya existe.", 409);
                const roles = root.authRoles || {};
                const role = Object.hasOwn(roles, roleId) ? roles[roleId] : null;
                if (!role || role.active === false) fail("El rol indicado no existe o está inactivo.", 400);
                requireManageableProfile(actor, roles, { roleId });
                if (Object.values(users).some((user) => user?.email?.trim().toLowerCase() === normalizedEmail)) {
                    fail("Ya existe una cuenta con ese correo.", 409);
                }
                const now = new Date().toISOString();
                return {
                    value: {
                        firstName: name, lastName: surname, email: normalizedEmail, profileImage: "",
                        roleId, isActive, passwordHash, sessionVersion: 0, createdAt: now, updatedAt: now
                    },
                    result: { userId }
                };
            }
        });
        if (!result) fail("No se pudo confirmar la creación del usuario.", 503);
        return result;
    } finally {
        clearAuthenticationCache();
    }
}

async function resetManagedUserPassword({
    actorId, actorTokenHash, actorSessionVersion, userId, password, database
}) {
    if (actorId === userId) fail("Usa el cambio de contraseña de tu perfil.", 409);
    validateManagerContext({ actorTokenHash, actorSessionVersion });
    validateNewPassword(password);
    const passwordHash = await hashPassword(password);
    try {
        return await transactAdminUser({
            id: userId, actorId, action: "user.password.reset",
            ...(database ? { database } : {}),
            change: (current, _users, root) => {
                const actor = requirePermissionManager(root, { actorId, actorTokenHash, actorSessionVersion });
                if (!current) return null;
                requireManageableProfile(actor, root.authRoles || {}, current);
                const updated = {
                    ...current, passwordHash, sessionVersion: (Number(current.sessionVersion) || 0) + 1,
                    updatedAt: new Date().toISOString()
                };
                return { value: updated, result: { userId } };
            }
        });
    } finally {
        clearAuthenticationCache();
    }
}

async function transactManagedUser({ actorId, actorTokenHash, actorSessionVersion, userId, database }, action, change) {
    if (actorId === userId) fail("No puedes administrar tu propia cuenta mediante esta operación.", 409);
    validateManagerContext({ actorTokenHash, actorSessionVersion });
    try {
        return await transactAdminUser({
            id: userId, actorId, action,
            ...(database ? { database } : {}),
            change: (current, users, root) => {
                const actor = requirePermissionManager(root, { actorId, actorTokenHash, actorSessionVersion });
                if (!current) return null;
                requireManageableProfile(actor, root.authRoles || {}, current);
                return change(current, users, root);
            }
        });
    } finally {
        clearAuthenticationCache();
    }
}

async function updateManagedUser(context) {
    const { userId, changes } = context;
    if (!changes || typeof changes !== "object" || Array.isArray(changes) ||
        !Object.keys(changes).length ||
        Object.keys(changes).some((key) => !["firstName", "lastName", "email"].includes(key))) {
        fail("Los datos del usuario no son válidos.", 400);
    }
    const normalized = {};
    if (Object.hasOwn(changes, "firstName")) normalized.firstName = validateName(changes.firstName, "El nombre");
    if (Object.hasOwn(changes, "lastName")) normalized.lastName = validateName(changes.lastName, "El apellido");
    if (Object.hasOwn(changes, "email")) normalized.email = validateEmail(changes.email);
    return transactManagedUser(context, "user.updated", (current, users) => {
        if (normalized.email && Object.entries(users).some(([id, profile]) =>
            id !== userId && profile?.email?.trim().toLowerCase() === normalized.email)) {
            fail("Ya existe una cuenta con ese correo.", 409);
        }
        if (Object.entries(normalized).every(([key, value]) => current[key] === value)) {
            return { unchanged: true, result: { userId } };
        }
        return {
            value: { ...current, ...normalized, updatedAt: new Date().toISOString() },
            result: { userId }
        };
    });
}

async function setManagedUserStatus(context) {
    const { userId, isActive } = context;
    if (typeof isActive !== "boolean") fail("El estado debe ser activo o inactivo.", 400);
    return transactManagedUser(context, "user.status.updated", (current, users, root) => {
        const activeBefore = current.isActive !== false;
        if (activeBefore === isActive) return { unchanged: true, result: { userId } };
        if (removesLastActiveAdmin(users, userId, { isActive })) {
            fail("No se puede dejar el sistema sin administradores activos.", 409);
        }
        const updated = {
            ...current, isActive, sessionVersion: (Number(current.sessionVersion) || 0) + 1,
            updatedAt: new Date().toISOString()
        };
        if (!Object.entries(users).some(([id, profile]) =>
            isPermissionManager(id === userId ? updated : profile, root.authRoles || {}))) {
            fail("No se puede dejar el sistema sin administradores de permisos.", 409);
        }
        return {
            value: updated, result: { userId },
            auditDetails: { activeBefore, activeAfter: isActive }
        };
    });
}

async function deleteManagedUser(context) {
    const { userId } = context;
    return transactManagedUser(context, "user.deleted", (current, users, root) => {
        if (removesLastActiveAdmin(users, userId, {}, { delete: true })) {
            fail("No se puede dejar el sistema sin administradores activos.", 409);
        }
        if (!Object.entries(users).some(([id, profile]) =>
            id !== userId && isPermissionManager(profile, root.authRoles || {}))) {
            fail("No se puede dejar el sistema sin administradores de permisos.", 409);
        }
        if (current.profileImage != null && typeof current.profileImage !== "string") {
            fail("La imagen del usuario no es válida.", 409);
        }
        return { value: null, result: { userId, profileImage: current.profileImage || "" } };
    });
}

async function setManagedUserAvatar(context) {
    const { userId, profileImage } = context;
    if (typeof profileImage !== "string" || !profileImage) fail("La imagen del usuario no es válida.", 400);
    return transactManagedUser(context, "user.avatar.updated", (current) => {
        if (current.profileImage != null && typeof current.profileImage !== "string") {
            fail("La imagen del usuario no es válida.", 409);
        }
        return {
            value: { ...current, profileImage, updatedAt: new Date().toISOString() },
            result: { userId, previousImage: current.profileImage || "" }
        };
    });
}

module.exports = {
    updateUserModuleExceptions, assignUserRole, createManagedUser, resetManagedUserPassword,
    updateManagedUser, setManagedUserStatus, deleteManagedUser, setManagedUserAvatar
};
