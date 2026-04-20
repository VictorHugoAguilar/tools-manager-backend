const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { loadModuleWithMocks } = require("../helpers/loadModuleWithMocks");
const { createTool } = require("../fixtures/tool");

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

function createControllerHarness(overrides = {}) {
    const service = {
        findAll: async () => [],
        findById: async () => null,
        create: async (data) => ({ id: "tool-1", ...data }),
        update: async () => null,
        updateState: async () => null,
        updateImageUrl: async () => null,
        remove: async () => false,
        ...overrides.service
    };
    const imageService = {
        deleteImageByUrl: async () => true,
        uploadImageForTool: async () => ({
            downloadUrl: "https://storage.local/tool-1.jpg"
        }),
        ...overrides.imageService
    };
    const validator = {
        validateToolPayload: () => ({
            isValid: true,
            errors: [],
            data: createTool()
        }),
        validateStatePayload: () => ({
            isValid: true,
            errors: [],
            data: { state: "Prestada" }
        }),
        buildToolQueryOptions: () => ({
            isValid: true,
            errors: [],
            data: {
                filters: {},
                sorting: { enabled: false, sortBy: undefined, sortOrder: "asc" },
                pagination: { enabled: false, page: 1, limit: 10 }
            }
        }),
        ...overrides.validator
    };

    const controller = loadModuleWithMocks(
        path.resolve(__dirname, "../../src/controllers/toolController.js"),
        {
            "../services/toolService": service,
            "../services/toolImageStorageService": imageService,
            "../validators/toolValidator": validator
        }
    );

    return {
        controller,
        service,
        imageService
    };
}

test("getAllTools returns validation errors for invalid query options", async () => {
    const { controller } = createControllerHarness({
        validator: {
            buildToolQueryOptions: () => ({
                isValid: false,
                errors: ["page must be a positive integer"]
            })
        }
    });
    const res = createResponseMock();

    await controller.getAllTools({ query: {} }, res);

    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.body, {
        message: "Validation error",
        errors: ["page must be a positive integer"]
    });
});

test("createTool returns 201 when payload is valid", async () => {
    const { controller } = createControllerHarness();
    const res = createResponseMock();

    await controller.createTool({ body: createTool() }, res);

    assert.equal(res.statusCode, 201);
    assert.equal(res.body.id, "tool-1");
});

test("getToolById returns 404 when the tool does not exist", async () => {
    const { controller } = createControllerHarness();
    const res = createResponseMock();

    await controller.getToolById({ params: { id: "missing" } }, res);

    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.body, { message: "Tool not found" });
});

test("updateToolState returns the updated tool", async () => {
    const { controller } = createControllerHarness({
        service: {
            updateState: async (id, state) => ({ id, ...createTool(), state })
        }
    });
    const res = createResponseMock();

    await controller.updateToolState(
        { params: { id: "tool-1" }, body: { state: "Prestada" } },
        res
    );

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.state, "Prestada");
});

test("uploadToolImage rejects missing files", async () => {
    const { controller } = createControllerHarness();
    const res = createResponseMock();

    await controller.uploadToolImage({ params: { id: "tool-1" } }, res);

    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.body, {
        message: "Validation error",
        errors: ["image file is required"]
    });
});

test("uploadToolImage uploads the new image and deletes the previous one", async () => {
    const deletedUrls = [];
    const { controller } = createControllerHarness({
        service: {
            findById: async () => ({
                id: "tool-1",
                ...createTool({ urlSrc: "https://storage.local/old.jpg" })
            }),
            updateImageUrl: async (id, urlSrc) => ({ id, ...createTool({ urlSrc }) })
        },
        imageService: {
            uploadImageForTool: async () => ({
                downloadUrl: "https://storage.local/new.jpg"
            }),
            deleteImageByUrl: async (url) => {
                deletedUrls.push(url);
                return true;
            }
        }
    });
    const res = createResponseMock();

    await controller.uploadToolImage(
        {
            params: { id: "tool-1" },
            file: {
                originalname: "photo.jpg",
                mimetype: "image/jpeg",
                buffer: Buffer.from("demo")
            }
        },
        res
    );

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.message, "Image uploaded successfully");
    assert.deepEqual(deletedUrls, ["https://storage.local/old.jpg"]);
});

test("deleteToolImage returns 404 when the tool has no image", async () => {
    const { controller } = createControllerHarness({
        service: {
            findById: async () => ({ id: "tool-1", ...createTool({ urlSrc: "" }) })
        }
    });
    const res = createResponseMock();

    await controller.deleteToolImage({ params: { id: "tool-1" } }, res);

    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.body, { message: "Tool image not found" });
});

test("deleteTool returns 204 when the tool is removed", async () => {
    const { controller } = createControllerHarness({
        service: {
            remove: async () => true
        }
    });
    const res = createResponseMock();

    await controller.deleteTool({ params: { id: "tool-1" } }, res);

    assert.equal(res.statusCode, 204);
});
