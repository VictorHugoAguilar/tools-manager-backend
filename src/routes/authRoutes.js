const express = require("express");
const { controller } = require("../controllers/authController");
const { requireAuthenticated, requireCsrf } = require("../middleware/authMiddleware");
const { uploadUserAvatar } = require("../middleware/userAvatarUploadMiddleware");

const authRouter = express.Router();

authRouter.post("/register", uploadUserAvatar, controller.register);
authRouter.post("/login", controller.login);
authRouter.post("/password-reset", controller.requestPasswordReset);
authRouter.post("/password-reset/complete", controller.completePasswordReset);
authRouter.post("/logout", requireAuthenticated, requireCsrf, controller.logout);
authRouter.get("/me", requireAuthenticated, controller.me);

module.exports = { authRouter };
