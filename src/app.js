const express = require("express");
const multer = require("multer");
const { toolRouter } = require("./routes/toolRoutes");
const { technicianRouter } = require("./routes/technicianRoutes");
const { locationRouter } = require("./routes/locationRoutes");
const { toolTypeRouter } = require("./routes/toolTypeRoutes");
const { tagRouter } = require("./routes/tagRoutes");
const { storageBoxRouter } = require("./routes/storageBoxRoutes");
const { shelfConfigRouter } = require("./routes/shelfConfigRoutes");
const { workshopStorageRouter } = require("./routes/workshopStorageRoutes");
const { authRouter } = require("./routes/authRoutes");
const { userRouter } = require("./routes/userRoutes");
const { adminRouter } = require("./routes/adminRoutes");
const { taskBoardRouter } = require("./routes/taskBoardRoutes");
const {
    requireAuthenticated,
    requireCsrf,
    requirePermission
} = require("./middleware/authMiddleware");
const cors = require("cors");

function createApp() {
    const app = express();
    const allowedOrigins = (process.env.FRONTEND_ORIGINS || "http://localhost:4200")
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean);

    app.use(cors({
        origin: (origin, callback) => callback(null, !origin || allowedOrigins.includes(origin)),
        credentials: true
    }));

    app.use(express.json({ limit: "1mb" }));

    app.get("/", (_req, res) => {
        res.json({
            message: "Tool management API is running",
            endpoints: {
                list: "GET /api/tools",
                getById: "GET /api/tools/:id",
                create: "POST /api/tools",
                update: "PUT /api/tools/:id",
                updateState: "PATCH /api/tools/:id/state",
                repairs: "GET|POST /api/tools/:toolId/repairs",
                repairById: "GET|PUT|DELETE /api/tools/:toolId/repairs/:repairId",
                uploadImage: "POST /api/tools/:id/image",
                deleteImage: "DELETE /api/tools/:id/image",
                delete: "DELETE /api/tools/:id",
                technicians: "GET|POST /api/technicians",
                technicianById: "GET|PUT|DELETE /api/technicians/:id",
                locations: "GET|POST /api/locations",
                locationById: "GET|PUT|DELETE /api/locations/:id",
                toolTypes: "GET|POST /api/tool-types",
                toolTypeById: "GET|PUT|DELETE /api/tool-types/:id",
                tags: "GET|POST /api/tags",
                tagById: "GET|PUT|DELETE /api/tags/:id",
                storageBoxes: "GET|POST /api/storage-boxes",
                shelfConfig: "GET|PUT /api/shelf-config",
                storageSearch: "GET /api/storage-boxes/search?q=:query",
                storageBoxById: "GET|PUT|DELETE /api/storage-boxes/:id",
                storageProducts: "POST /api/storage-boxes/:boxId/products",
                storageProductById: "PUT|DELETE /api/storage-boxes/:boxId/products/:productId",
                workshopStorage: "GET /api/workshop-storage",
                workshopStorageSearch: "GET /api/workshop-storage/search?q=:query",
                workshopStorageCategories: "GET|POST /api/workshop-storage/categories and DELETE /api/workshop-storage/categories/:id",
                workshopStorageResources: "POST|PUT|DELETE /api/workshop-storage/{shelves,levels,organizers,compartments,materials}",
                taskBoard: "GET /api/task-board, POST /api/task-board/{columns,tasks,labels}, PATCH /api/task-board/{columns,tasks,labels}/:id, DELETE /api/task-board/{columns,tasks,labels}/:id",
                auth: "POST /api/auth/{register,login,password-reset,password-reset/complete,logout}, GET /api/auth/me",
                profile: "GET|PATCH /api/users/me, PATCH /api/users/me/password, POST /api/users/me/avatar",
                adminUsers: "GET|POST /api/admin/users, GET|PATCH|DELETE /api/admin/users/:id, PATCH /api/admin/users/:id/password",
                adminRoles: "GET /api/admin/{roles,permissions}, PATCH /api/admin/roles/:roleId/permissions"
            }
        });
    });

    app.use("/api/auth", authRouter);
    app.use("/api/users", userRouter);
    app.use("/api/admin", adminRouter);

    const protectApplicationApi = [
        requireAuthenticated,
        requirePermission("app:access"),
        (req, res, next) => ["POST", "PUT", "PATCH", "DELETE"].includes(req.method)
            ? requireCsrf(req, res, next)
            : next()
    ];
    app.use("/api/tools", protectApplicationApi, toolRouter);
    app.use("/api/technicians", protectApplicationApi, technicianRouter);
    app.use("/api/locations", protectApplicationApi, locationRouter);
    app.use("/api/tool-types", protectApplicationApi, toolTypeRouter);
    app.use("/api/tags", protectApplicationApi, tagRouter);
    app.use("/api/storage-boxes", protectApplicationApi, storageBoxRouter);
    app.use("/api/shelf-config", protectApplicationApi, shelfConfigRouter);
    app.use("/api/workshop-storage", protectApplicationApi, workshopStorageRouter);
    app.use("/api/task-board", protectApplicationApi, taskBoardRouter);

    app.use((err, _req, res, _next) => {
        if (!err.statusCode || err.statusCode >= 500) console.error(err);

        if (err instanceof multer.MulterError) {
            const uploadMessage = err.code === "LIMIT_FILE_SIZE"
                ? "La imagen supera el tamaño máximo permitido."
                : err.message;

            return res.status(400).json({
                message: "Upload error",
                errors: [uploadMessage]
            });
        }

        if (err.message === "Only image files are allowed" ||
            err.message === "Only JPEG, PNG or WebP images are allowed") {
            return res.status(400).json({
                message: "Upload error",
                errors: [err.message]
            });
        }

        return res.status(err.statusCode || 500).json({
            message: err.statusCode ? err.message : "Internal server error"
        });
    });

    return app;
}

module.exports = { createApp };
