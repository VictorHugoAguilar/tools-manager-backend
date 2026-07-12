const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { loadModuleWithMocks } = require("../helpers/loadModuleWithMocks");

function createImageServiceHarness() {
    const requests = [];
    const originalFetch = global.fetch;

    global.fetch = async (url, options = {}) => {
        requests.push({ url, options });

        if (String(url).includes("identitytoolkit")) {
            return {
                ok: true,
                status: 200,
                async json() {
                    return {
                        idToken: "auth-token",
                        expiresIn: "3600"
                    };
                },
                async text() {
                    return "{}";
                }
            };
        }

        return {
            ok: true,
            status: 200,
            async json() {
                return {};
            },
            async text() {
                return "{}";
            }
        };
    };

    const service = loadModuleWithMocks(
        path.resolve(__dirname, "../../src/services/toolImageStorageService.js"),
        {
            crypto: {
                randomUUID() {
                    return "uuid-fixed";
                }
            }
        }
    );

    return {
        service,
        requests,
        restoreFetch() {
            global.fetch = originalFetch;
        }
    };
}

test("uploadImageForTool uploads the file and returns a download url", async () => {
    const originalNow = Date.now;
    const originalBucket = process.env.FIREBASE_STORAGE_BUCKET;
    const originalApiKey = process.env.FIREBASE_API_KEY;
    Date.now = () => 1700000000000;
    process.env.FIREBASE_STORAGE_BUCKET = "la-herreria-dev.firebasestorage.app";
    process.env.FIREBASE_API_KEY = "api-key";

    const { service, requests, restoreFetch } = createImageServiceHarness();

    try {
        const result = await service.uploadImageForTool("tool-1", {
            originalname: "foto final.png",
            mimetype: "image/png",
            buffer: Buffer.from("image")
        });

        assert.deepEqual(result, {
            storagePath: "tools/tool-1/1700000000000-uuid-fixed.png",
            downloadUrl: "https://firebasestorage.googleapis.com/v0/b/la-herreria-dev.firebasestorage.app/o/tools%2Ftool-1%2F1700000000000-uuid-fixed.png?alt=media&token=uuid-fixed"
        });

        assert.equal(requests.length, 2);
        assert.match(
            requests[1].url,
            /uploadType=media&name=tools%2Ftool-1%2F1700000000000-uuid-fixed.png/
        );
        assert.equal(requests[1].options.method, "POST");
        assert.equal(requests[1].options.headers.authorization, "Bearer auth-token");
        assert.equal(requests[1].options.headers["content-type"], "image/png");
        assert.equal(requests[1].options.headers["x-goog-meta-toolId"], "tool-1");
        assert.equal(requests[1].options.headers["x-goog-meta-firebaseStorageDownloadTokens"], "uuid-fixed");
        assert.deepEqual(requests[1].options.body, Buffer.from("image"));
    } finally {
        Date.now = originalNow;
        process.env.FIREBASE_STORAGE_BUCKET = originalBucket;
        process.env.FIREBASE_API_KEY = originalApiKey;
        restoreFetch();
    }
});

test("deleteImageByUrl deletes only firebase storage urls", async () => {
    const originalBucket = process.env.FIREBASE_STORAGE_BUCKET;
    const originalApiKey = process.env.FIREBASE_API_KEY;
    process.env.FIREBASE_STORAGE_BUCKET = "la-herreria-dev.firebasestorage.app";
    process.env.FIREBASE_API_KEY = "api-key";
    const { service, requests, restoreFetch } = createImageServiceHarness();

    try {
        const deletedResult = await service.deleteImageByUrl(
            "https://firebasestorage.googleapis.com/v0/b/la-herreria-dev.firebasestorage.app/o/storage-boxes%2Fbox-1%2Fimage.jpg?alt=media&token=token"
        );
        const skippedResult = await service.deleteImageByUrl("https://example.com/image.jpg");

        assert.equal(deletedResult, true);
        assert.equal(skippedResult, false);
        assert.equal(requests.at(-1).options.method, "DELETE");
        assert.match(requests.at(-1).url, /storage-boxes%2Fbox-1%2Fimage.jpg/);
    } finally {
        process.env.FIREBASE_STORAGE_BUCKET = originalBucket;
        process.env.FIREBASE_API_KEY = originalApiKey;
        restoreFetch();
    }
});
