require("dotenv").config();

const express = require("express");
const multer = require("multer");
const { connectToDatabase } = require("./config/database");
const { toolRouter } = require("./routes/toolRoutes");

const app = express();
const PORT = process.env.PORT || 3000;

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
            uploadImage: "POST /api/tools/:id/image",
            deleteImage: "DELETE /api/tools/:id/image",
            delete: "DELETE /api/tools/:id"
        }
    });
});

app.use("/api/tools", toolRouter);

app.use((err, _req, res, _next) => {
    console.error(err);

    if (err instanceof multer.MulterError) {
        return res.status(400).json({
            message: "Upload error",
            errors: [err.message]
        });
    }

    if (err.message === "Only image files are allowed") {
        return res.status(400).json({
            message: "Upload error",
            errors: [err.message]
        });
    }

    res.status(500).json({
        message: "Internal server error"
    });
});

async function startServer() {
    try {
        await connectToDatabase();

        app.listen(PORT, () => {
            console.log(`Server running on http://localhost:${PORT}`);
        });
    } catch (error) {
        console.error("Failed to start server", error);
        process.exit(1);
    }
}

startServer();