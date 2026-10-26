const {
    getShelfConfig: getShelfConfigFromService,
    updateShelfConfig: updateShelfConfigInService
} = require("../services/shelfConfigService");
const {
    validateShelfConfigPayload
} = require("../validators/shelfConfigValidator");

async function getShelfConfig(_req, res) {
    return handleControllerError(res, async () => {
        const config = await getShelfConfigFromService();
        return res.json(config);
    });
}

async function updateShelfConfig(req, res) {
    return handleControllerError(res, async () => {
        const validation = validateShelfConfigPayload(req.body);

        if (!validation.isValid) {
            return res.status(400).json({
                message: "Validation error",
                errors: validation.errors
            });
        }

        const config = await updateShelfConfigInService(validation.data);
        return res.json(config);
    });
}

async function handleControllerError(res, action) {
    try {
        return await action();
    } catch (error) {
        if (error?.code === "SHELF_CONFIG_CONFLICT") {
            return res.status(409).json({
                message: error.message
            });
        }

        console.error(error);
        return res.status(500).json({
            message: "Internal server error"
        });
    }
}

module.exports = {
    getShelfConfig,
    updateShelfConfig
};

