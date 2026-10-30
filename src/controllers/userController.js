const { randomUUID } = require("node:crypto");
const { getPublicUser, issueSession, validateNewPassword } = require("./authController");
const { hashPassword, verifyPassword } = require("../services/passwordService");
const {
    createProfile,
    getProfile,
    getPasswordHash,
    getProfileWithPermissions,
    getRole,
    listPermissions,
    listProfiles,
    listRoles,
    updateProfile,
    updateProfileGuarded,
    updatePasswordHash,
    updateRolePermissions
} = require("../services/userService");
const { deleteImageByUrl } = require("../services/toolImageStorageService");
const { updateUserAvatar } = require("../services/userAvatarService");
function httpError(message, statusCode) {
    return Object.assign(new Error(message), { statusCode });
}

function handle(handler) {
    return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function validateName(value, label) {
    if (typeof value !== "string" || !value.trim() || value.trim().length > 80) {
        throw httpError(`${label} es obligatorio y no puede superar 80 caracteres.`, 400);
    }
    return value.trim();
}

function validateEmail(value) {
    const email = typeof value === "string" ? value.trim().toLowerCase() : "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
        throw httpError("Introduce un correo electrónico válido.", 400);
    }
    return email;
}

function validateRoleId(value) {
    if (typeof value !== "string" || !/^[a-z][a-z0-9_-]{0,40}$/.test(value)) {
        throw httpError("El rol indicado no es válido.", 400);
    }
    return value;
}

const userController = {
    getMe: (req, res) => res.json({ user: getPublicUser(req.authUser) }),

    updateMe: handle(async (req, res) => {
        const allowed = new Set(["firstName", "lastName"]);
        if (Object.keys(req.body || {}).some((key) => !allowed.has(key))) {
            throw httpError("Solo se pueden modificar el nombre y el apellido desde el perfil.", 400);
        }
        const changes = {};
        if (Object.hasOwn(req.body || {}, "firstName")) changes.firstName = validateName(req.body.firstName, "El nombre");
        if (Object.hasOwn(req.body || {}, "lastName")) changes.lastName = validateName(req.body.lastName, "El apellido");
        if (!Object.keys(changes).length) throw httpError("No hay cambios para guardar.", 400);
        const profile = await updateProfile(req.authUser.id, changes);
        if (!profile) throw httpError("Usuario no encontrado.", 404);
        return res.json({ user: getPublicUser(await getProfileWithPermissions(req.authUser.id)) });
    }),

    changeMyPassword: handle(async (req, res) => {
        const currentPassword = req.body?.currentPassword;
        const newPassword = validateNewPassword(req.body?.newPassword);
        if (typeof currentPassword !== "string" || !currentPassword) {
            throw httpError("Introduce tu contraseña actual.", 400);
        }
        const currentHash = await getPasswordHash(req.authUser.id);
        if (!currentHash || !await verifyPassword(currentPassword, currentHash)) {
            throw httpError("La contraseña actual no es correcta.", 401);
        }
        const updated = await updatePasswordHash(req.authUser.id, await hashPassword(newPassword));
        if (!updated) throw httpError("Usuario no encontrado.", 404);
        await issueSession(res, req.authUser.id);
        return res.json({ message: "La contraseña se ha actualizado correctamente." });
    }),

    uploadMyAvatar: handle(async (req, res) => {
        const profile = await updateUserAvatar(req.authUser.id, req.file);
        return res.json({ user: getPublicUser(await getProfileWithPermissions(profile.id)) });
    }),

    list: handle(async (req, res) => {
        const page = await listProfiles({
            search: req.query.search,
            role: req.query.role,
            status: req.query.status,
            sort: req.query.sort,
            order: req.query.order,
            page: req.query.page,
            limit: req.query.limit
        });
        const roles = Object.fromEntries((await listRoles()).map((role) => [role.id, role.name]));
        return res.json({
            ...page,
            users: page.users.map((user) => ({ ...user, roleName: roles[user.roleId] || user.roleId }))
        });
    }),

    getById: handle(async (req, res) => {
        const user = await getProfileWithPermissions(req.params.id);
        return user ? res.json({ user: getPublicUser(user) }) : res.status(404).json({ message: "Usuario no encontrado." });
    }),

    create: handle(async (req, res) => {
        const firstName = validateName(req.body?.firstName, "El nombre");
        const lastName = validateName(req.body?.lastName, "El apellido");
        const email = validateEmail(req.body?.email);
        const password = validateNewPassword(req.body?.password);
        const roleId = validateRoleId(req.body?.roleId || "user");
        const role = await getRole(roleId);
        if (!role) throw httpError("El rol indicado no existe.", 400);
        const allowed = new Set(["firstName", "lastName", "email", "password", "roleId", "isActive"]);
        if (Object.keys(req.body || {}).some((key) => !allowed.has(key))) {
            throw httpError("La solicitud contiene campos no permitidos.", 400);
        }
        if (req.body?.isActive !== undefined && typeof req.body.isActive !== "boolean") {
            throw httpError("El estado debe ser activo o inactivo.", 400);
        }
        const isActive = req.body?.isActive !== false;
        const uid = randomUUID();
        await createProfile(
            uid,
            { firstName, lastName, email, isActive },
            roleId,
            await hashPassword(password)
        );
        const user = await getProfileWithPermissions(uid);
        return res.status(201).json({ user: getPublicUser(user) });
    }),

    update: handle(async (req, res) => {
        const allowed = new Set(["firstName", "lastName", "email"]);
        if (Object.keys(req.body || {}).some((key) => !allowed.has(key))) {
            throw httpError("El rol, el estado y la contraseña se modifican mediante acciones específicas.", 400);
        }
        const existing = await getProfile(req.params.id);
        if (!existing) return res.status(404).json({ message: "Usuario no encontrado." });
        const changes = {};
        if (Object.hasOwn(req.body || {}, "firstName")) changes.firstName = validateName(req.body.firstName, "El nombre");
        if (Object.hasOwn(req.body || {}, "lastName")) changes.lastName = validateName(req.body.lastName, "El apellido");
        if (Object.hasOwn(req.body || {}, "email")) changes.email = validateEmail(req.body.email);
        if (!Object.keys(changes).length) throw httpError("No hay cambios para guardar.", 400);

        const updated = await updateProfileGuarded(req.params.id, changes);
        if (!updated) throw httpError("Usuario no encontrado.", 404);
        return res.json({ user: getPublicUser(await getProfileWithPermissions(req.params.id)) });
    }),

    delete: handle(async (req, res) => {
        if (req.params.id === req.authUser.id) {
            throw httpError("No puedes eliminar la cuenta con la que has iniciado sesión.", 409);
        }
        const existing = await getProfile(req.params.id);
        if (!existing) return res.status(404).json({ message: "Usuario no encontrado." });
        const removed = await updateProfileGuarded(req.params.id, {}, { delete: true });
        if (!removed) return res.status(404).json({ message: "Usuario no encontrado." });
        if (existing.profileImage) await deleteImageByUrl(existing.profileImage);
        return res.status(204).send();
    }),

    updateRole: handle(async (req, res) => {
        const roleId = validateRoleId(req.body?.roleId);
        if (!await getRole(roleId)) {
            throw httpError("El rol indicado no existe.", 400);
        }
        if (req.params.id === req.authUser.id && roleId !== "admin") {
            throw httpError("No puedes retirar tu propio rol de administrador.", 409);
        }
        const existing = await getProfile(req.params.id);
        if (!existing) return res.status(404).json({ message: "Usuario no encontrado." });
        const updated = await updateProfileGuarded(req.params.id, { roleId });
        if (!updated) return res.status(404).json({ message: "Usuario no encontrado." });
        return res.json({ user: getPublicUser(await getProfileWithPermissions(req.params.id)) });
    }),

    updateStatus: handle(async (req, res) => {
        if (typeof req.body?.isActive !== "boolean") {
            throw httpError("El estado debe ser activo o inactivo.", 400);
        }
        if (req.params.id === req.authUser.id && !req.body.isActive) {
            throw httpError("No puedes desactivar tu propia cuenta.", 409);
        }
        const updated = await updateProfileGuarded(req.params.id, { isActive: req.body.isActive });
        if (!updated) return res.status(404).json({ message: "Usuario no encontrado." });
        return res.json({ user: getPublicUser(await getProfileWithPermissions(req.params.id)) });
    }),

    resetPassword: handle(async (req, res) => {
        const newPassword = validateNewPassword(req.body?.newPassword);
        const existing = await getProfile(req.params.id);
        if (!existing) return res.status(404).json({ message: "Usuario no encontrado." });
        const updated = await updatePasswordHash(req.params.id, await hashPassword(newPassword));
        if (!updated) throw httpError("Usuario no encontrado.", 404);
        return res.status(204).send();
    }),

    uploadAvatar: handle(async (req, res) => {
        const profile = await updateUserAvatar(req.params.id, req.file);
        return res.json({ user: getPublicUser(await getProfileWithPermissions(profile.id)) });
    }),

    roles: handle(async (_req, res) => res.json({ roles: await listRoles() })),
    permissions: handle(async (_req, res) => res.json({ permissions: await listPermissions() })),
    updatePermissions: handle(async (req, res) => {
        const role = await updateRolePermissions(req.params.roleId, req.body?.permissions);
        return role ? res.json({ role }) : res.status(404).json({ message: "Rol no encontrado." });
    })
};

module.exports = {
    userController,
    validateEmail,
    validateName
};
