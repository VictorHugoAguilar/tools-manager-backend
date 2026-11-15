const express = require("express");
const { userController } = require("../controllers/userController");
const { secureAdminController } = require("../controllers/secureAdminController");
const {
    requireAuthenticated,
    requireCsrf,
    requirePermission
} = require("../middleware/authMiddleware");
const { uploadUserAvatar } = require("../middleware/userAvatarUploadMiddleware");

const adminRouter = express.Router();
const management = process.env.SECURE_ADMIN_ENABLED === "true" ? secureAdminController : userController;
adminRouter.use(requireAuthenticated);

adminRouter.get("/permissions", requirePermission("roles:manage"), userController.permissions);
adminRouter.get("/roles", requirePermission("roles:manage"), userController.roles);
adminRouter.patch(
    "/roles/:roleId/permissions",
    requirePermission("roles:manage"),
    requireCsrf,
    management.updatePermissions
);
adminRouter.get("/users", requirePermission("users:manage"), userController.list);
adminRouter.get("/users/:id", requirePermission("users:manage"), userController.getById);
adminRouter.post("/users", requirePermission("users:manage"), requireCsrf, management.create);
adminRouter.patch("/users/:id", requirePermission("users:manage"), requireCsrf, management.update);
adminRouter.patch(
    "/users/:id/role",
    requirePermission("users:manage"),
    requireCsrf,
    management.updateRole
);
adminRouter.patch(
    "/users/:id/status",
    requirePermission("users:manage"),
    requireCsrf,
    management.updateStatus
);
adminRouter.patch(
    "/users/:id/password",
    requirePermission("users:manage"),
    requireCsrf,
    management.resetPassword
);
adminRouter.post(
    "/users/:id/avatar",
    requirePermission("users:manage"),
    requireCsrf,
    uploadUserAvatar,
    management.uploadAvatar
);
adminRouter.delete("/users/:id", requirePermission("users:manage"), requireCsrf, management.delete);

module.exports = { adminRouter };
