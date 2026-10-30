const { getAdminDatabase } = require("../config/firebaseAdmin");

const DEFAULT_ROLES = {
    admin: {
        name: "Administrador",
        permissions: {
            "app:access": true,
            "users:manage": true,
            "roles:manage": true
        }
    },
    user: {
        name: "Usuario",
        permissions: {
            "app:access": true
        }
    }
};

const PERMISSIONS = {
    "app:access": "Acceder a las funciones de la aplicación",
    "users:manage": "Consultar y administrar usuarios",
    "roles:manage": "Consultar y administrar permisos por rol"
};

function getProfilesRef() {
    return getAdminDatabase().ref("authUsers");
}

function getRolesRef() {
    return getAdminDatabase().ref("authRoles");
}

function getPermissionsRef() {
    return getAdminDatabase().ref("authPermissions");
}

async function initializeAuthData() {
    const [rolesSnapshot, permissionsSnapshot] = await Promise.all([
        getRolesRef().get(),
        getPermissionsRef().get()
    ]);

    const updates = {};
    if (!rolesSnapshot.exists()) updates.authRoles = DEFAULT_ROLES;
    if (!permissionsSnapshot.exists()) {
        updates.authPermissions = Object.fromEntries(
            Object.entries(PERMISSIONS).map(([id, description]) => [id, { description }])
        );
    }

    if (Object.keys(updates).length) {
        await getAdminDatabase().ref().update(updates);
    }
}

function normalizeProfile(id, value) {
    if (!value) return null;
    return {
        id,
        firstName: value.firstName || "",
        lastName: value.lastName || "",
        email: value.email || "",
        profileImage: value.profileImage || "",
        roleId: value.roleId || "user",
        isActive: value.isActive !== false,
        createdAt: value.createdAt || "",
        updatedAt: value.updatedAt || "",
        sessionVersion: Number(value.sessionVersion) || 0
    };
}

function removesLastActiveAdmin(profiles, uid, changes, options = {}) {
    const current = profiles?.[uid];
    if (!current || current.roleId !== "admin" || current.isActive === false) return false;
    const removesAdmin = (changes.roleId && changes.roleId !== "admin") ||
        changes.isActive === false ||
        options.delete;
    if (!removesAdmin) return false;
    return Object.values(profiles).filter((profile) =>
        profile?.roleId === "admin" && profile.isActive !== false
    ).length <= 1;
}

async function getProfile(uid) {
    const snapshot = await getProfilesRef().child(uid).get();
    return normalizeProfile(uid, snapshot.val());
}

async function getPasswordHash(uid) {
    const snapshot = await getProfilesRef().child(uid).child("passwordHash").get();
    return snapshot.val() || null;
}

async function getAccountByEmail(email) {
    const snapshot = await getProfilesRef().get();
    const normalizedEmail = email.trim().toLowerCase();
    const match = Object.entries(snapshot.val() || {}).find(([, profile]) =>
        profile?.email?.trim().toLowerCase() === normalizedEmail
    );
    return match
        ? { ...normalizeProfile(match[0], match[1]), passwordHash: match[1].passwordHash || null }
        : null;
}

async function getProfileWithPermissions(uid) {
    const profile = await getProfile(uid);
    if (!profile) return null;
    const roleSnapshot = await getRolesRef().child(profile.roleId).get();
    const role = roleSnapshot.val();
    if (!role) return null;

    return {
        ...profile,
        roleName: role.name,
        permissions: Object.keys(role.permissions || {}).filter((permission) => role.permissions[permission])
    };
}

async function createProfile(uid, input, roleId = "user", passwordHash) {
    const now = new Date().toISOString();
    const profile = {
        firstName: input.firstName.trim(),
        lastName: input.lastName.trim(),
        email: input.email.trim().toLowerCase(),
        profileImage: "",
        roleId,
        isActive: input.isActive !== false,
        createdAt: now,
        updatedAt: now,
        sessionVersion: 0,
        ...(passwordHash ? { passwordHash } : {})
    };

    let conflict;
    const result = await getProfilesRef().transaction((profiles) => {
        conflict = undefined;
        profiles = profiles || {};
        if (profiles[uid]) {
            conflict = "La cuenta ya existe.";
            return;
        }
        if (Object.values(profiles).some((existing) =>
            existing?.email?.trim().toLowerCase() === profile.email
        )) {
            conflict = "Ya existe una cuenta con ese correo.";
            return;
        }
        profiles[uid] = profile;
        return profiles;
    });
    if (conflict) {
        throw Object.assign(new Error(conflict), { statusCode: 409 });
    }
    if (!result.committed) {
        throw Object.assign(new Error("No se pudo crear la cuenta."), { statusCode: 409 });
    }
    return normalizeProfile(uid, profile);
}

async function deleteProfileForRollback(uid) {
    await getProfilesRef().child(uid).remove();
}

async function updateProfile(uid, changes) {
    const ref = getProfilesRef().child(uid);
    const current = await ref.get();
    if (!current.exists()) return null;

    await ref.update({
        ...changes,
        updatedAt: new Date().toISOString()
    });

    const updated = await ref.get();
    return updated.exists() ? normalizeProfile(uid, updated.val()) : null;
}

async function updatePasswordHash(uid, passwordHash, expectedSessionVersion) {
    const ref = getProfilesRef();
    let stalePasswordReset = false;
    const result = await ref.transaction((profiles) => {
        stalePasswordReset = false;
        if (!profiles || !profiles[uid]) return;
        const current = profiles[uid];
        if (expectedSessionVersion !== undefined &&
            (Number(current.sessionVersion) || 0) !== expectedSessionVersion) {
            stalePasswordReset = true;
            return;
        }
        profiles[uid] = {
            ...current,
            passwordHash,
            sessionVersion: (Number(current.sessionVersion) || 0) + 1,
            updatedAt: new Date().toISOString()
        };
        return profiles;
    });
    if (stalePasswordReset) return null;
    if (!result.committed) return null;
    return normalizeProfile(uid, result.snapshot.child(uid).val());
}

async function updateProfileGuarded(uid, changes, options = {}) {
    if (!options.delete && !Object.hasOwn(changes, "roleId") && !Object.hasOwn(changes, "isActive")) {
        const existing = await getProfile(uid);
        if (!existing) return null;

        if (changes.email) {
            const account = await getAccountByEmail(changes.email);
            if (account && account.id !== uid) {
                throw Object.assign(new Error("Ya existe una cuenta con ese correo."), { statusCode: 409 });
            }
        }

        return updateProfile(uid, changes);
    }

    const ref = getProfilesRef();
    let guardError;
    const result = await ref.transaction((profiles) => {
        guardError = undefined;
        if (!profiles || !profiles[uid]) return;
        if (removesLastActiveAdmin(profiles, uid, changes, options)) {
            guardError = Object.assign(new Error("No se puede dejar el sistema sin administradores activos."), {
                statusCode: 409
            });
            return;
        }

        const current = profiles[uid];
        if (changes.email && Object.entries(profiles).some(([id, profile]) =>
            id !== uid && profile?.email?.trim().toLowerCase() === changes.email.trim().toLowerCase()
        )) {
            guardError = Object.assign(new Error("Ya existe una cuenta con ese correo."), { statusCode: 409 });
            return;
        }
        if (options.delete) {
            delete profiles[uid];
        } else {
            profiles[uid] = {
                ...current,
                ...changes,
                ...(Object.hasOwn(changes, "isActive") && changes.isActive !== current.isActive
                    ? { sessionVersion: (Number(current.sessionVersion) || 0) + 1 }
                    : {}),
                updatedAt: new Date().toISOString()
            };
        }
        return profiles;
    });

    if (guardError) throw guardError;
    if (!result.committed) return null;
    return options.delete ? true : normalizeProfile(uid, result.snapshot.child(uid).val());
}

async function listProfiles(filters = {}) {
    const snapshot = await getProfilesRef().get();
    const values = snapshot.val() || {};
    const search = String(filters.search || "").trim().toLowerCase();
    const users = Object.entries(values)
        .map(([id, value]) => normalizeProfile(id, value))
        .filter((user) => {
            if (search && !`${user.firstName} ${user.lastName} ${user.email}`.toLowerCase().includes(search)) return false;
            if (filters.role && user.roleId !== filters.role) return false;
            if (filters.status === "active" && !user.isActive) return false;
            if (filters.status === "inactive" && user.isActive) return false;
            return true;
        });

    const sort = ["firstName", "lastName", "email", "roleId", "isActive", "createdAt"].includes(filters.sort)
        ? filters.sort
        : "createdAt";
    const direction = filters.order === "asc" ? 1 : -1;
    users.sort((left, right) => String(left[sort]).localeCompare(String(right[sort])) * direction);

    const page = Math.max(1, Number.parseInt(filters.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(filters.limit, 10) || 10));
    const total = users.length;
    return {
        users: users.slice((page - 1) * limit, page * limit),
        total,
        page,
        limit,
        pages: Math.ceil(total / limit)
    };
}

async function listRoles() {
    const snapshot = await getRolesRef().get();
    return Object.entries(snapshot.val() || {}).map(([id, role]) => ({
        id,
        name: role.name,
        permissions: Object.keys(role.permissions || {}).filter((key) => role.permissions[key])
    }));
}

async function getRole(roleId) {
    const snapshot = await getRolesRef().child(roleId).get();
    return snapshot.exists() ? snapshot.val() : null;
}

async function listPermissions() {
    const snapshot = await getPermissionsRef().get();
    return Object.entries(snapshot.val() || {}).map(([id, value]) => ({
        id,
        description: value.description || ""
    }));
}

async function updateRolePermissions(roleId, permissionIds) {
    if (!Array.isArray(permissionIds) || permissionIds.some((id) => !PERMISSIONS[id])) {
        throw Object.assign(new Error("La lista incluye permisos no válidos."), { statusCode: 400 });
    }

    const roleRef = getRolesRef().child(roleId);
    const snapshot = await roleRef.get();
    const role = snapshot.val();
    if (!role) return null;
    if (roleId === "admin" && (
        !permissionIds.includes("app:access") ||
        !permissionIds.includes("users:manage") ||
        !permissionIds.includes("roles:manage")
    )) {
        throw Object.assign(new Error("El rol administrador debe conservar acceso a la aplicación y su gestión."), { statusCode: 409 });
    }

    const permissions = Object.fromEntries(permissionIds.map((id) => [id, true]));
    await roleRef.update({ permissions });
    return { id: roleId, name: role.name, permissions: permissionIds };
}

module.exports = {
    createProfile,
    deleteProfileForRollback,
    getProfile,
    getAccountByEmail,
    getProfileWithPermissions,
    getPasswordHash,
    getRole,
    initializeAuthData,
    listPermissions,
    listProfiles,
    listRoles,
    removesLastActiveAdmin,
    updatePasswordHash,
    updateProfile,
    updateProfileGuarded,
    updateRolePermissions
};
