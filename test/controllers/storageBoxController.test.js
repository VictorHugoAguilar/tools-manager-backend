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
        },
        send(payload) {
            this.body = payload;
            return this;
        }
    };
}

function createControllerHarness() {
    const validationOptions = [];
    const shelfConfig = { rows: 2, columns: 2 };
    const service = {
        create: async (data) => ({ id: "box-1", ...data }),
        createProduct: async () => null,
        findAll: async () => [],
        findById: async () => null,
        findProductById: async () => null,
        remove: async () => false,
        removeProduct: async () => false,
        searchProducts: async () => [],
        update: async (id, data) => ({ id, ...data }),
        updateProduct: async () => null,
        updateImageUrl: async () => null,
        updateProductImageUrl: async () => null
    };
    const imageService = {
        deleteImageByUrl: async () => true,
        uploadImageForStorageBox: async () => ({
            downloadUrl: "https://storage.local/box.jpg"
        }),
        uploadImageForStorageProduct: async () => ({
            downloadUrl: "https://storage.local/product.jpg"
        })
    };
    const validator = {
        validateStorageBoxPayload: (payload, options) => {
            validationOptions.push(options);
            return {
                isValid: true,
                errors: [],
                data: {
                    code: payload.code || "BOX-001",
                    name: payload.name,
                    description: payload.description,
                    imageUrl: "",
                    shelfRow: payload.shelfRow,
                    shelfColumn: payload.shelfColumn
                }
            };
        },
        validateStorageProductPayload: () => ({
            isValid: true,
            errors: [],
            data: {}
        })
    };
    const shelfConfigService = {
        getShelfConfig: async () => shelfConfig
    };
    const controller = loadModuleWithMocks(
        path.resolve(__dirname, "../../src/controllers/storageBoxController.js"),
        {
            "../services/storageBoxService": service,
            "../services/toolImageStorageService": imageService,
            "../services/shelfConfigService": shelfConfigService,
            "../validators/storageBoxValidator": validator
        }
    );

    return {
        controller,
        shelfConfig,
        validationOptions
    };
}

test("createStorageBox validates against the persisted shelf configuration", async () => {
    const { controller, shelfConfig, validationOptions } = createControllerHarness();
    const res = createResponseMock();

    await controller.createStorageBox({
        body: {
            name: "Caja de brocas",
            description: "Brocas de metal",
            shelfRow: 2,
            shelfColumn: 2
        }
    }, res);

    assert.equal(res.statusCode, 201);
    assert.deepEqual(validationOptions, [{
        requireCode: false,
        shelfConfig
    }]);
});

test("updateStorageBox validates against the persisted shelf configuration", async () => {
    const { controller, shelfConfig, validationOptions } = createControllerHarness();
    const res = createResponseMock();

    await controller.updateStorageBox({
        params: { id: "box-1" },
        body: {
            code: "BOX-001",
            name: "Caja de brocas",
            description: "Brocas de metal",
            shelfRow: 2,
            shelfColumn: 2
        }
    }, res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(validationOptions, [{
        requireCode: true,
        shelfConfig
    }]);
});

