const express = require("express");
const { userController } = require("../controllers/userController");
const {
    requireAuthenticated,
    requireCsrf,
    requirePermission
} = require("../middleware/authMiddleware");
const { uploadUserAvatar } = require("../middleware/userAvatarUploadMiddleware");

const userRouter = express.Router();
userRouter.use(requireAuthenticated);

userRouter.get("/me", userController.getMe);
userRouter.patch("/me", requireCsrf, userController.updateMe);
userRouter.patch("/me/password", requireCsrf, userController.changeMyPassword);
userRouter.post("/me/avatar", requireCsrf, uploadUserAvatar, userController.uploadMyAvatar);

module.exports = { userRouter };
