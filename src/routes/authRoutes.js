const express = require("express");
const { controller } = require("../controllers/authController");
const { requireAuthenticated, requireCsrf } = require("../middleware/authMiddleware");
const { authOperationTelemetry } = require("../middleware/authOperationTelemetry");
const { uploadUserAvatar } = require("../middleware/userAvatarUploadMiddleware");
const { MODULES } = require("../permissions/moduleCatalog");

const authRouter = express.Router();

authRouter.post("/register", uploadUserAvatar, controller.register);
authRouter.post("/login", authOperationTelemetry("login"), controller.login);
authRouter.post("/password-reset", controller.requestPasswordReset);
authRouter.post("/password-reset/complete", controller.completePasswordReset);
authRouter.post("/logout", authOperationTelemetry("logout"), requireAuthenticated, requireCsrf, controller.logout);
authRouter.get("/csrf", requireAuthenticated, controller.csrf);
authRouter.get("/me", requireAuthenticated, controller.me);
authRouter.get("/modules", requireAuthenticated, (_req, res) => {
    res.set("Cache-Control", "no-store");
    return res.json({ modules: MODULES });
});

module.exports = { authRouter };
