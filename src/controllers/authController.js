const { randomBytes, randomUUID } = require("node:crypto");
const {
    CSRF_COOKIE,
    SESSION_COOKIE,
    parseCookies
} = require("../middleware/authMiddleware");
const {
    createProfile,
    deleteProfileForRollback,
    getAccountByEmail,
    getProfileWithPermissions,
    updatePasswordHash
} = require("../services/userService");
const {
    SESSION_TTL_MS,
    createSession,
    deleteSession,
    consumePasswordReset,
    storePasswordReset
} = require("../services/authSessionService");
const { hashPassword, verifyPassword } = require("../services/passwordService");
const { sendPasswordResetEmail } = require("../services/emailService");
const { updateUserAvatar } = require("../services/userAvatarService");

const PASSWORD_RESET_TTL_MS = 30 * 60 * 1000;
const failedAttempts = new Map();
const passwordResetAttempts = new Map();
const MAX_ATTEMPTS = 10;
const RATE_WINDOW_MS = 15 * 60 * 1000;
const MAX_PASSWORD_RESET_ATTEMPTS = 5;
const PASSWORD_RESET_WINDOW_MS = 60 * 60 * 1000;
let dummyPasswordHash;

function createHttpError(message, statusCode) {
    return Object.assign(new Error(message), { statusCode });
}

function validateEmail(value) {
    const email = typeof value === "string" ? value.trim().toLowerCase() : "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
        throw createHttpError("Introduce un correo electrónico válido.", 400);
    }
    return email;
}

function validateCredentials(email, password) {
    const normalizedEmail = validateEmail(email);
    if (typeof password !== "string" || !password || password.length > 128) {
        throw createHttpError("Introduce una contraseña válida.", 400);
    }
    return normalizedEmail;
}

function validateNewPassword(password) {
    if (typeof password !== "string" || password.length < 10 || password.length > 128 ||
        !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
        throw createHttpError("La contraseña debe tener entre 10 y 128 caracteres e incluir letras y números.", 400);
    }
    return password;
}

function validateProfileInput(body) {
    const firstName = typeof body?.firstName === "string" ? body.firstName.trim() : "";
    const lastName = typeof body?.lastName === "string" ? body.lastName.trim() : "";
    if (!firstName || firstName.length > 80 || !lastName || lastName.length > 80) {
        throw createHttpError("El nombre y el apellido son obligatorios (máximo 80 caracteres).", 400);
    }
    return { firstName, lastName, email: validateEmail(body?.email) };
}

function appendCookie(res, name, value, options = {}) {
    const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
    const httpOnly = options.httpOnly ? "; HttpOnly" : "";
    const path = options.path || "/";
    const maxAge = options.maxAge === undefined ? "" : `; Max-Age=${options.maxAge}`;
    res.append(
        "Set-Cookie",
        `${name}=${encodeURIComponent(value)}; Path=${path}; SameSite=Strict${httpOnly}${secure}${maxAge}`
    );
}

function setSessionCookies(res, sessionToken) {
    const csrfToken = randomBytes(32).toString("base64url");
    appendCookie(res, SESSION_COOKIE, sessionToken, {
        httpOnly: true,
        path: "/api",
        maxAge: SESSION_TTL_MS / 1000
    });
    appendCookie(res, CSRF_COOKIE, csrfToken, { maxAge: SESSION_TTL_MS / 1000 });
}

function clearSessionCookies(res) {
    appendCookie(res, SESSION_COOKIE, "", { httpOnly: true, path: "/api", maxAge: 0 });
    appendCookie(res, CSRF_COOKIE, "", { maxAge: 0 });
}

async function issueSession(res, uid) {
    const session = await createSession(uid);
    setSessionCookies(res, session.token);
    return session;
}

function getPublicUser(user) {
    return {
        id: user.id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        profileImage: user.profileImage,
        roleId: user.roleId,
        roleName: user.roleName,
        isActive: user.isActive,
        permissions: user.permissions
    };
}

function checkRateLimit(req, res, next) {
    const key = req.socket.remoteAddress || "unknown";
    const now = Date.now();
    const attempts = (failedAttempts.get(key) || []).filter((timestamp) => now - timestamp < RATE_WINDOW_MS);
    failedAttempts.set(key, attempts);
    if (attempts.length >= MAX_ATTEMPTS) {
        res.set("Retry-After", String(Math.ceil((RATE_WINDOW_MS - (now - attempts[0])) / 1000)));
        return res.status(429).json({ message: "Demasiados intentos. Espera antes de volver a intentarlo." });
    }

    req.recordAuthFailure = () => {
        attempts.push(Date.now());
        failedAttempts.set(key, attempts);
    };
    return next();
}

function checkPasswordResetRateLimit(req, res, next) {
    const key = req.socket.remoteAddress || "unknown";
    const now = Date.now();
    const attempts = (passwordResetAttempts.get(key) || [])
        .filter((timestamp) => now - timestamp < PASSWORD_RESET_WINDOW_MS);
    if (attempts.length >= MAX_PASSWORD_RESET_ATTEMPTS) {
        res.set("Retry-After", String(Math.ceil(
            (PASSWORD_RESET_WINDOW_MS - (now - attempts[0])) / 1000
        )));
        return res.status(429).json({
            message: "Se han solicitado demasiados cambios de contraseña. Espera antes de volver a intentarlo."
        });
    }
    attempts.push(now);
    passwordResetAttempts.set(key, attempts);
    return next();
}

function handle(handler) {
    return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function getDummyPasswordHash() {
    if (!dummyPasswordHash) {
        dummyPasswordHash = hashPassword(randomBytes(32).toString("base64url"));
    }
    return dummyPasswordHash;
}

const controller = {
    register: handle(async (req, res) => {
        if (process.env.PUBLIC_REGISTRATION_ENABLED !== "true") {
            throw createHttpError("El registro público no está habilitado.", 403);
        }
        const profile = validateProfileInput(req.body);
        const password = validateNewPassword(req.body?.password);
        const allowed = new Set(["firstName", "lastName", "email", "password"]);
        if (Object.keys(req.body || {}).some((key) => !allowed.has(key))) {
            throw createHttpError("La solicitud contiene campos no permitidos.", 400);
        }

        const uid = randomUUID();
        let profileCreated = false;
        try {
            const passwordHash = await hashPassword(password);
            await createProfile(uid, profile, "user", passwordHash);
            profileCreated = true;
            if (req.file) await updateUserAvatar(uid, req.file);
            const user = await getProfileWithPermissions(uid);
            await issueSession(res, uid);
            return res.status(201).json({ user: getPublicUser(user) });
        } catch (error) {
            if (profileCreated) {
                try {
                    await deleteProfileForRollback(uid);
                } catch (cleanupError) {
                    console.error("Could not remove incomplete user profile", cleanupError);
                }
            }
            throw error;
        }
    }),

    requestPasswordReset: [
        checkPasswordResetRateLimit,
        handle(async (req, res) => {
            const email = validateEmail(req.body?.email);
            const profile = await getAccountByEmail(email);
            const token = randomBytes(32).toString("base64url");
            let frontendUrl;
            try {
                const baseUrl = new URL(process.env.FRONTEND_URL);
                if (!["http:", "https:"].includes(baseUrl.protocol)) throw new Error("Unsupported protocol");
                frontendUrl = new URL("/restablecer-contrasena", baseUrl);
            } catch {
                throw createHttpError("FRONTEND_URL no está configurada correctamente.", 503);
            }
            frontendUrl.hash = new URLSearchParams({ token }).toString();
            await storePasswordReset(
                token,
                profile?.id || null,
                Date.now() + PASSWORD_RESET_TTL_MS,
                profile?.sessionVersion ?? 0
            );
            await sendPasswordResetEmail(
                email,
                profile?.firstName || "usuario",
                frontendUrl.toString()
            );
            return res.status(202).json({
                message: "Si existe una cuenta con ese correo, recibirás instrucciones para restablecer la contraseña."
            });
        })
    ],

    completePasswordReset: [
        checkPasswordResetRateLimit,
        handle(async (req, res) => {
            const token = req.body?.token;
            if (typeof token !== "string" || token.length < 32 || token.length > 128) {
                throw createHttpError("El enlace de recuperación no es válido o ha caducado.", 400);
            }
            const password = validateNewPassword(req.body?.password);
            const reset = await consumePasswordReset(token);
            if (!reset) throw createHttpError("El enlace de recuperación no es válido o ha caducado.", 400);
            const profile = await updatePasswordHash(
                reset.uid,
                await hashPassword(password),
                reset.sessionVersion
            );
            if (!profile) throw createHttpError("El enlace de recuperación no es válido o ha caducado.", 400);
            return res.json({ message: "La contraseña se ha actualizado. Ya puedes iniciar sesión." });
        })
    ],

    login: [checkRateLimit, handle(async (req, res, next) => {
        const email = validateCredentials(req.body?.email, req.body?.password);
        try {
            const profile = await getAccountByEmail(email);
            const passwordHash = profile?.passwordHash || await getDummyPasswordHash();
            const validPassword = await verifyPassword(req.body.password, passwordHash);
            if (!profile?.isActive || !validPassword) {
                throw createHttpError("El correo o la contraseña no son correctos.", 401);
            }
            await issueSession(res, profile.id);
            failedAttempts.delete(req.socket.remoteAddress || "unknown");
            return res.json({ user: getPublicUser(await getProfileWithPermissions(profile.id)) });
        } catch (error) {
            if ([401, 403, 502].includes(error.statusCode)) req.recordAuthFailure();
            return next(error);
        }
    })],

    me: (req, res) => res.json({ user: getPublicUser(req.authUser) }),

    logout: handle(async (req, res) => {
        await deleteSession(req.authSession.tokenHash);
        clearSessionCookies(res);
        return res.status(204).send();
    })
};

module.exports = {
    controller,
    getPublicUser,
    issueSession,
    validateCredentials,
    validateNewPassword,
    validateProfileInput
};
