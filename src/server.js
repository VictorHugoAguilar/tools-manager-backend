require("dotenv").config();

const { connectToDatabase } = require("./config/database");
const { initializeAuthData } = require("./services/userService");
const { createApp } = require("./app");
const { telemetry } = require("./telemetry/telemetry");
const { auditWorker } = require("./audit/outboxWorker");
const {
    isToolAuditEnabled, isRoleAuditEnabled, isUserAuditEnabled, isSelfUserAuditEnabled, isRecoveryAuditEnabled,
    isRegistrationAuditEnabled, isWorkshopStorageAuditEnabled, isStorageBoxAuditEnabled, isRepairAuditEnabled,
    isCatalogAuditEnabled, isTaskBoardCatalogAuditEnabled, isTaskBoardTaskAuditEnabled,
    isTodoProjectAuditEnabled, isTodoSectionAuditEnabled, isDrawingDocumentAuditEnabled, isDrawingPageAuditEnabled
} = require("./audit/businessOutbox");

const PORT = process.env.PORT || 3000;
const app = createApp();

async function startServer() {
    try {
        const taskBoardTaskAuditEnabled = isTaskBoardTaskAuditEnabled();
        const todoSectionAuditEnabled = isTodoSectionAuditEnabled();
        await connectToDatabase();
        await initializeAuthData();
        return app.listen(PORT, () => {
            telemetry.start();
            if (isToolAuditEnabled() || isRoleAuditEnabled() || isUserAuditEnabled() ||
                isSelfUserAuditEnabled() || isRecoveryAuditEnabled() || isRegistrationAuditEnabled() ||
                isWorkshopStorageAuditEnabled() || isStorageBoxAuditEnabled() || isRepairAuditEnabled() ||
                isCatalogAuditEnabled() || isTaskBoardCatalogAuditEnabled() || taskBoardTaskAuditEnabled ||
                isTodoProjectAuditEnabled() || todoSectionAuditEnabled ||
                isDrawingDocumentAuditEnabled() || isDrawingPageAuditEnabled()) {
                auditWorker.start();
            }
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
