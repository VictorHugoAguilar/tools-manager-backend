const { resolveSession } = require("../services/authSessionService");
const { MODULES } = require("../permissions/moduleCatalog");

const SESSION_COOKIE = "tm_session";
const CSRF_COOKIE = "tm_csrf";

function parseCookies(header = "") {
    return header.split(";").reduce((cookies, part) => {
        const separator = part.indexOf("=");
        if (separator < 0) return cookies;
        const name = part.slice(0, separator).trim();
        const value = part.slice(separator + 1).trim();
        try {
            cookies[name] = decodeURIComponent(value);
        } catch {
            cookies[name] = "";
        }
        return cookies;
    }, {});
}

function unauthorized(res) {
    return res.status(401).json({ message: "La sesión no es válida o ha caducado." });
}

async function requireAuthenticated(req, res, next) {
    const sessionToken = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!sessionToken) return unauthorized(res);

    try {
        const session = await resolveSession(sessionToken);
        if (!session) return unauthorized(res);
        req.authUser = session.profile;
        req.authSession = session;
        return next();
    } catch (error) {
        return next(error);
    }
}

function requirePermission(permission) {
    return (req, res, next) => {
        if (!req.authUser?.permissions?.includes(permission)) {
            return res.status(403).json({ message: "No tienes permisos para realizar esta operación." });
        }
        return next();
    };
}

function requireModulePermission(moduleId) {
    const module = MODULES.find((item) => item.id === moduleId && item.active);
    if (!module) throw new TypeError("El módulo protegido no es válido.");
    const checkPermission = requirePermission(module.permission);
    return (req, res, next) => {
        if (!req.authUser) return unauthorized(res);
        return checkPermission(req, res, next);
    };
}

function requireModuleWhenEnabled(...moduleIds) {
    const modules = moduleIds.map((id) => {
        const module = MODULES.find((item) => item.id === id && item.active);
        if (!module) throw new TypeError("El módulo protegido no es válido.");
        return module;
    });
    if (!modules.length) throw new TypeError("Debe indicarse al menos un módulo.");
    return (req, res, next) => {
        if (process.env.MODULE_PERMISSIONS_ENABLED !== "true") return next();
        if (!req.authUser) return unauthorized(res);
        if (!modules.some((module) => req.authUser.permissions?.includes(module.permission))) {
            return res.status(403).json({ message: "No tienes permisos para realizar esta operación." });
        }
        return next();
    };
}

function requireCsrf(req, res, next) {
    const cookies = parseCookies(req.headers.cookie);
    const csrfCookie = cookies[CSRF_COOKIE];
    const csrfHeader = req.get("x-csrf-token");
    if (!csrfCookie || !csrfHeader || csrfCookie !== csrfHeader) {
        return res.status(403).json({ message: "La solicitud no superó la validación de seguridad." });
    }
    return next();
}

module.exports = {
    CSRF_COOKIE,
    SESSION_COOKIE,
    parseCookies,
    requireAuthenticated,
    requireCsrf,
    requireModulePermission,
    requireModuleWhenEnabled,
    requirePermission
};
