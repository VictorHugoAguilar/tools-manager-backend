const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { loadModuleWithMocks } = require("../helpers/loadModuleWithMocks");

function createResponseMock() {
    return {
        statusCode: 200,
        body: undefined,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(payload) {
            this.body = payload;
            return this;
        }
    };
}

function createControllerHarness(overrides = {}) {
    const service = {
        getShelfConfig: async () => ({ rows: 5, columns: 6 }),
        updateShelfConfig: async (config) => config,
        ...overrides.service
    };
    const validator = {
        validateShelfConfigPayload: (payload) => ({
            isValid: true,
            errors: [],
            data: payload
        }),
        ...overrides.validator
    };
    const controller = loadModuleWithMocks(
        path.resolve(__dirname, "../../src/controllers/shelfConfigController.js"),
        {
            "../services/shelfConfigService": service,
            "../validators/shelfConfigValidator": validator
        }
    );

    return { controller, service, validator };
}

test("getShelfConfig returns the configuration supplied by the service", async () => {
    const { controller } = createControllerHarness({
        service: {
            getShelfConfig: async () => ({ rows: 4, columns: 3 })
        }
    });
    const res = createResponseMock();

    await controller.getShelfConfig({}, res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { rows: 4, columns: 3 });
});

test("updateShelfConfig returns validation errors without saving", async () => {
    let saved = false;
    const { controller } = createControllerHarness({
        service: {
            updateShelfConfig: async () => {
                saved = true;
            }
        },
        validator: {
            validateShelfConfigPayload: () => ({
                isValid: false,
                errors: ["rows must be an integer between 1 and 10"],
                data: null
            })
        }
    });
    const res = createResponseMock();

    await controller.updateShelfConfig({ body: { rows: 0, columns: 6 } }, res);

    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.body, {
        message: "Validation error",
        errors: ["rows must be an integer between 1 and 10"]
    });
    assert.equal(saved, false);
});

test("updateShelfConfig returns the persisted compatible configuration", async () => {
    const { controller } = createControllerHarness({
        service: {
            updateShelfConfig: async () => ({ rows: 4, columns: 3 })
        }
    });
    const res = createResponseMock();

    await controller.updateShelfConfig({ body: { rows: 4, columns: 3 } }, res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { rows: 4, columns: 3 });
});

test("updateShelfConfig returns 409 for a shelf configuration conflict", async () => {
    const { controller } = createControllerHarness({
        service: {
            updateShelfConfig: async () => {
                const error = new Error("La caja BX-1 está en Fila 5");
                error.code = "SHELF_CONFIG_CONFLICT";
                throw error;
            }
        }
    });
    const res = createResponseMock();

    await controller.updateShelfConfig({ body: { rows: 4, columns: 6 } }, res);

    assert.equal(res.statusCode, 409);
    assert.deepEqual(res.body, {
        message: "La caja BX-1 está en Fila 5"
    });
});

