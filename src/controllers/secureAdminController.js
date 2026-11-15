const { randomUUID } = require("node:crypto");
const { getAdminDatabase } = require("../config/firebaseAdmin");
const { getPublicUser } = require("./authController");
const { getProfileWithPermissions } = require("../services/userService");
const { validateUserAvatar } = require("../services/userAvatarService");
const { uploadImageForUser, deleteImageByUrl } = require("../services/toolImageStorageService");
const {
    createManagedUser, updateManagedUser, assignUserRole, setManagedUserStatus,
    resetManagedUserPassword, deleteManagedUser, setManagedUserAvatar, updateUserModuleExceptions
} = require("../permissions/permissionManagement");
const { calculateEffectivePermissions } = require("../permissions/effectivePermissions");
const {
    updateLegacyRolePermissions, createPermissionRole, updatePermissionRole, deactivatePermissionRole
} = require("../permissions/roleManagement");

function handle(handler) {
    return (req, res, next) => Promise.resolve(handler(req, res)).catch(next);
}

function context(req) {
    return {
        actorId: req.authUser.id,
        actorSessionVersion: req.authUser.sessionVersion,
        actorTokenHash: req.authSession.tokenHash
    };
}

function onlyFields(body, allowed) {
    if (!body || typeof body !== "object" || Array.isArray(body) ||
        Object.keys(body).some((key) => !allowed.includes(key))) {
        throw Object.assign(new Error("La solicitud contiene campos no permitidos."), { statusCode: 400 });
    }
}

async function respondWithUser(res, id, status = 200) {
    const user = await getProfileWithPermissions(id);
    if (!user) throw Object.assign(new Error("Usuario no encontrado o con rol inactivo."), { statusCode: 404 });
    return res.status(status).json({ user: getPublicUser(user) });
}

async function removePreviousImage(url, userId) {
    if (!url) return;
    if (!await deleteImageByUrl(url)) {
        console.warn("No se pudo eliminar la imagen anterior del usuario.", { userId });
    }
}

function publicRole(role) {
    return {
        id: role.id, name: role.name, description: role.description || "",
        active: role.active !== false,
        permissions: Object.keys(role.permissions || {}).filter((id) => role.permissions[id] === true)
    };
}

const secureAdminController = {
    create: handle(async (req, res) => {
        onlyFields(req.body, ["firstName", "lastName", "email", "password", "roleId", "isActive"]);
        const userId = randomUUID();
        await createManagedUser({ ...context(req), ...req.body, userId });
        return respondWithUser(res, userId, 201);
    }),

    update: handle(async (req, res) => {
        onlyFields(req.body, ["firstName", "lastName", "email"]);
        const result = await updateManagedUser({ ...context(req), userId: req.params.id, changes: req.body });
        if (!result) return res.status(404).json({ message: "Usuario no encontrado." });
        return respondWithUser(res, req.params.id);
    }),

    updateRole: handle(async (req, res) => {
        onlyFields(req.body, ["roleId"]);
        const result = await assignUserRole({ ...context(req), userId: req.params.id, roleId: req.body.roleId });
        if (!result) return res.status(404).json({ message: "Usuario no encontrado." });
        return respondWithUser(res, req.params.id);
    }),

    updateStatus: handle(async (req, res) => {
        onlyFields(req.body, ["isActive"]);
        const result = await setManagedUserStatus({ ...context(req), userId: req.params.id, isActive: req.body.isActive });
        if (!result) return res.status(404).json({ message: "Usuario no encontrado." });
        return respondWithUser(res, req.params.id);
    }),

    resetPassword: handle(async (req, res) => {
        onlyFields(req.body, ["newPassword"]);
        const result = await resetManagedUserPassword({ ...context(req), userId: req.params.id, password: req.body.newPassword });
        if (!result) return res.status(404).json({ message: "Usuario no encontrado." });
        return res.status(204).send();
    }),

    delete: handle(async (req, res) => {
        const result = await deleteManagedUser({ ...context(req), userId: req.params.id });
        if (!result) return res.status(404).json({ message: "Usuario no encontrado." });
        await removePreviousImage(result.profileImage, req.params.id);
        return res.status(204).send();
    }),

    uploadAvatar: handle(async (req, res) => {
        if (req.params.id === req.authUser.id) {
            throw Object.assign(new Error("Usa tu perfil para modificar tu propia imagen."), { statusCode: 409 });
        }
        validateUserAvatar(req.file);
        const target = await getProfileWithPermissions(req.params.id);
        if (!target) return res.status(404).json({ message: "Usuario no encontrado." });
        if (!["app:access", "users:manage", "roles:manage"].every((id) => req.authUser.permissions.includes(id)) ||
            target.permissions.some((id) => !req.authUser.permissions.includes(id))) {
            throw Object.assign(new Error("No puedes administrar permisos que no posees."), { statusCode: 403 });
        }
        const uploaded = await uploadImageForUser(req.params.id, req.file);
        let result;
        try {
            result = await setManagedUserAvatar({
                ...context(req), userId: req.params.id, profileImage: uploaded.downloadUrl
            });
        } catch (error) {
            console.error("No se confirmó la actualización de la imagen; puede requerir limpieza en Storage.", {
                userId: req.params.id
            });
            throw error;
        }
        if (!result) {
            await removePreviousImage(uploaded.downloadUrl, req.params.id);
            return res.status(404).json({ message: "Usuario no encontrado." });
        }
        await removePreviousImage(result.previousImage, req.params.id);
        return respondWithUser(res, req.params.id);
    }),

    updatePermissions: handle(async (req, res) => {
        onlyFields(req.body, ["permissions"]);
        const role = await updateLegacyRolePermissions({
            ...context(req), roleId: req.params.roleId, permissions: req.body.permissions
        });
        return role ? res.json({ role }) : res.status(404).json({ message: "Rol no encontrado." });
    }),

    createRole: handle(async (req, res) => {
        onlyFields(req.body, ["id", "name", "description", "permissions", "sourceRoleId"]);
        const role = await createPermissionRole({
            ...context(req), roleId: req.body.id, name: req.body.name,
            description: req.body.description, permissions: req.body.permissions, sourceRoleId: req.body.sourceRoleId
        });
        if (!role) throw Object.assign(new Error("No se pudo confirmar la creación del perfil."), { statusCode: 503 });
        return res.status(201).json({ role: publicRole(role) });
    }),

    updateRoleProfile: handle(async (req, res) => {
        onlyFields(req.body, ["name", "description", "permissions"]);
        const role = await updatePermissionRole({ ...context(req), roleId: req.params.roleId, ...req.body });
        return role ? res.json({ role: publicRole(role) }) : res.status(404).json({ message: "Rol no encontrado." });
    }),

    deactivateRole: handle(async (req, res) => {
        const role = await deactivatePermissionRole({ ...context(req), roleId: req.params.roleId });
        return role ? res.json({ role: publicRole(role) }) : res.status(404).json({ message: "Rol no encontrado." });
    }),

    getUserExceptions: handle(async (req, res) => {
        const user = await getProfileWithPermissions(req.params.id);
        if (!user) return res.status(404).json({ message: "Usuario no encontrado o con rol inactivo." });
        if (user.permissions.some((id) => !req.authUser.permissions.includes(id))) {
            throw Object.assign(new Error("No puedes administrar permisos que no posees."), { statusCode: 403 });
        }
        const snapshot = await getAdminDatabase().ref("authUsers").child(req.params.id).child("permissionExceptions").get();
        const exceptions = snapshot.val() ?? {};
        calculateEffectivePermissions({}, exceptions);
        res.set("Cache-Control", "no-store");
        return res.json({ exceptions });
    }),

    updateUserExceptions: handle(async (req, res) => {
        onlyFields(req.body, ["exceptions"]);
        const result = await updateUserModuleExceptions({
            ...context(req), userId: req.params.id, exceptions: req.body.exceptions
        });
        return result ? res.json({ exceptions: result.exceptions }) : res.status(404).json({ message: "Usuario no encontrado." });
    })
};

module.exports = { secureAdminController };
