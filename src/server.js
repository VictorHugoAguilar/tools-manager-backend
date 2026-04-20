require("dotenv").config();

const { connectToDatabase } = require("./config/database");
const { createApp } = require("./app");

const PORT = process.env.PORT || 3000;
const app = createApp();

async function startServer() {
    try {
        await connectToDatabase();

        return app.listen(PORT, () => {
            console.log(`Server running on http://localhost:${PORT}`);
        });
    } catch (error) {
        console.error("Failed to start server", error);
        process.exit(1);
    }
}

if (require.main === module) {
    startServer();
}

module.exports = {
    app,
    startServer
};
