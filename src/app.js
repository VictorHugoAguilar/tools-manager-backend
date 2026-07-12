const express = require("express");
const multer = require("multer");
const { toolRouter } = require("./routes/toolRoutes");
const { technicianRouter } = require("./routes/technicianRoutes");
const { locationRouter } = require("./routes/locationRoutes");
const { toolTypeRouter } = require("./routes/toolTypeRoutes");
const { storageBoxRouter } = require("./routes/storageBoxRoutes");
const cors = require("cors");

function createApp() {
    const app = express();

    app.use(cors());

    app.use(express.json());

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
                storageBoxes: "GET|POST /api/storage-boxes",
                storageBoxById: "GET|PUT|DELETE /api/storage-boxes/:id",
                storageProducts: "POST /api/storage-boxes/:boxId/products",
                storageProductById: "PUT|DELETE /api/storage-boxes/:boxId/products/:productId"
            }
        });
    });

    app.use("/api/tools", toolRouter);
    app.use("/api/technicians", technicianRouter);
    app.use("/api/locations", locationRouter);
    app.use("/api/tool-types", toolTypeRouter);
    app.use("/api/storage-boxes", storageBoxRouter);

    app.use((err, _req, res, _next) => {
        console.error(err);

        if (err instanceof multer.MulterError) {
            const uploadMessage = err.code === "LIMIT_FILE_SIZE"
                ? "La imagen supera el tamaño máximo permitido."
                : err.message;

            return res.status(400).json({
                message: "Upload error",
                errors: [uploadMessage]
            });
        }

        if (err.message === "Only image files are allowed") {
            return res.status(400).json({
                message: "Upload error",
                errors: [err.message]
            });
        }

        return res.status(500).json({
            message: "Internal server error"
        });
    });

    return app;
}

module.exports = { createApp };
