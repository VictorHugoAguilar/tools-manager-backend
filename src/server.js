require("dotenv").config();

const { connectToDatabase } = require("./config/database");
const { initializeAuthData } = require("./services/userService");
const { createApp } = require("./app");
const { telemetry } = require("./telemetry/telemetry");
const { AuditOutboxWorker } = require("./audit/outboxWorker");
const { isToolAuditEnabled, isRoleAuditEnabled } = require("./audit/businessOutbox");

const PORT = process.env.PORT || 3000;
const app = createApp();
const auditWorker = new AuditOutboxWorker();

async function startServer() {
    try {
        await connectToDatabase();
        await initializeAuthData();
        return app.listen(PORT, () => {
            telemetry.start();
            if (isToolAuditEnabled() || isRoleAuditEnabled()) auditWorker.start();
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
