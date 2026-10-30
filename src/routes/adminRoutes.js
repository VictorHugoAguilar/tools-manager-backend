const express = require("express");
const { userController } = require("../controllers/userController");
const {
    requireAuthenticated,
    requireCsrf,
    requirePermission
} = require("../middleware/authMiddleware");
const { uploadUserAvatar } = require("../middleware/userAvatarUploadMiddleware");

const adminRouter = express.Router();
adminRouter.use(requireAuthenticated);

adminRouter.get("/permissions", requirePermission("roles:manage"), userController.permissions);
adminRouter.get("/roles", requirePermission("roles:manage"), userController.roles);
adminRouter.patch(
    "/roles/:roleId/permissions",
    requirePermission("roles:manage"),
    requireCsrf,
    userController.updatePermissions
);
adminRouter.get("/users", requirePermission("users:manage"), userController.list);
adminRouter.get("/users/:id", requirePermission("users:manage"), userController.getById);
adminRouter.post("/users", requirePermission("users:manage"), requireCsrf, userController.create);
adminRouter.patch("/users/:id", requirePermission("users:manage"), requireCsrf, userController.update);
adminRouter.patch(
    "/users/:id/role",
    requirePermission("users:manage"),
    requireCsrf,
    userController.updateRole
);
adminRouter.patch(
    "/users/:id/status",
    requirePermission("users:manage"),
    requireCsrf,
    userController.updateStatus
);
adminRouter.patch(
    "/users/:id/password",
    requirePermission("users:manage"),
    requireCsrf,
    userController.resetPassword
);
adminRouter.post(
    "/users/:id/avatar",
    requirePermission("users:manage"),
    requireCsrf,
    uploadUserAvatar,
    userController.uploadAvatar
);
adminRouter.delete("/users/:id", requirePermission("users:manage"), requireCsrf, userController.delete);

module.exports = { adminRouter };
