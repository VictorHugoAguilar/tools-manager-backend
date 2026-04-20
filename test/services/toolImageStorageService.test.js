const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { loadModuleWithMocks } = require("../helpers/loadModuleWithMocks");

function createImageServiceHarness() {
    const uploaded = [];
    const deleted = [];

    const service = loadModuleWithMocks(
        path.resolve(__dirname, "../../src/services/toolImageStorageService.js"),
        {
            "firebase/storage": {
                ref(_storage, targetPath) {
                    return { targetPath };
                },
                async uploadBytes(reference, buffer, metadata) {
                    uploaded.push({
                        targetPath: reference.targetPath,
                        size: buffer.length,
                        metadata
                    });
                },
                async getDownloadURL(reference) {
                    return `https://storage.local/${reference.targetPath}`;
                },
                async deleteObject(reference) {
                    deleted.push(reference.targetPath);
                }
            },
            "../config/database": {
                getStorageInstance() {
                    return {};
                }
            },
            crypto: {
                randomUUID() {
                    return "uuid-fixed";
                }
            }
        }
    );

    return {
        service,
        uploaded,
        deleted
    };
}

test("uploadImageForTool uploads the file and returns a download url", async () => {
    const originalNow = Date.now;
    Date.now = () => 1700000000000;

    const { service, uploaded } = createImageServiceHarness();

    try {
        const result = await service.uploadImageForTool("tool-1", {
            originalname: "foto final.png",
            mimetype: "image/png",
            buffer: Buffer.from("image")
        });

        assert.deepEqual(result, {
            storagePath: "tools/tool-1/1700000000000-uuid-fixed.png",
            downloadUrl: "https://storage.local/tools/tool-1/1700000000000-uuid-fixed.png"
        });

        assert.deepEqual(uploaded[0], {
            targetPath: "tools/tool-1/1700000000000-uuid-fixed.png",
            size: 5,
            metadata: {
                contentType: "image/png",
                customMetadata: {
                    toolId: "tool-1"
                }
            }
        });
    } finally {
        Date.now = originalNow;
    }
});

test("deleteImageByUrl deletes only firebase storage urls", async () => {
    process.env.FIREBASE_STORAGE_BUCKET = "la-herreria-dev.firebasestorage.app";
    const { service, deleted } = createImageServiceHarness();

    const deletedResult = await service.deleteImageByUrl(
        "https://firebasestorage.googleapis.com/v0/b/demo/o/image.jpg"
    );
    const skippedResult = await service.deleteImageByUrl("https://example.com/image.jpg");

    assert.equal(deletedResult, true);
    assert.equal(skippedResult, false);
    assert.equal(deleted.length, 1);
});
