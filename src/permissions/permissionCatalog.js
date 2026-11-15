const { MODULES } = require("./moduleCatalog");

const LEGACY_PERMISSIONS = Object.freeze({
    "app:access": "Acceder a las funciones de la aplicación",
    "users:manage": "Consultar y administrar usuarios",
    "roles:manage": "Consultar y administrar permisos por rol",
    "monitoring:app": "Acceder a las funciones de monitoreo",
    "tracing:app": "Acceder a las funciones de trazabilidad"
});

const ALL_PERMISSIONS = Object.freeze({
    ...Object.fromEntries(MODULES.map((module) => [module.permission, module.description])),
    ...LEGACY_PERMISSIONS
});

module.exports = { LEGACY_PERMISSIONS, ALL_PERMISSIONS };
