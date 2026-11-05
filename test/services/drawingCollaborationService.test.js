const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { loadModuleWithMocks } = require("../helpers/loadModuleWithMocks");

let database;
let currentRole = "Editor";
let sessionVersion = 4;
const DOCUMENT_ID = "22222222-2222-4222-8222-222222222222";
const PAGE_ID = "33333333-3333-4333-8333-333333333333";

function readPath(path) {
    return path.split("/").filter(Boolean).reduce((value, part) => value?.[part], database);
}

function writePath(path, value) {
    const segments = path.split("/").filter(Boolean);
    let node = database;
    for (const segment of segments.slice(0, -1)) {
        if (!node[segment] || typeof node[segment] !== "object") node[segment] = {};
        node = node[segment];
    }
    if (value === null) delete node[segments.at(-1)];
    else node[segments.at(-1)] = structuredClone(value);
}

function reference(path = "") {
    return {
        child(childPath) {
            return reference([path, childPath].filter(Boolean).join("/"));
        },
        async get() {
            const value = readPath(path);
            return { val: () => value === undefined ? null : structuredClone(value) };
        },
        async set(value) {
            writePath(path, value);
        },
        async remove() {
            writePath(path, null);
        }
    };
}

const service = loadModuleWithMocks("../../src/services/drawingCollaborationService", {
    "../config/firebaseAdmin": { getAdminDatabase: () => ({ ref: reference }) },
    "./drawingAccessService": {
        getDocumentAccess: async () => ({ role: currentRole })
    },
    "./drawingShareLinkService": {
        hashToken: (token) => createHash("sha256").update(token).digest("hex"),
        validateShareTokenHash: async () => true
    },
    "./userService": {
        getProfile: async () => ({
            isActive: true,
            sessionVersion,
            firstName: "Ada",
            lastName: "Editor",
            profileImage: ""
        })
    },
    "./drawingRateLimitService": { consumeDrawingRateLimit: async () => {} }
});

test.beforeEach(() => {
    currentRole = "Editor";
    sessionVersion = 4;
    database = {
        drawing: {
            pages: { [PAGE_ID]: { documentId: DOCUMENT_ID, deletedAt: null } }
        }
    };
});

test("collaboration sessions store only a token hash and revalidate current access", async () => {
    const session = await service.createCollaborationSession(DOCUMENT_ID, PAGE_ID, "user");
    const tokenHash = createHash("sha256").update(session.token).digest("hex");
    const stored = readPath(`drawing/collaborationSessions/${tokenHash}`);

    assert.equal(stored.userId, "user");
    assert.equal(stored.role, "Editor");
    assert.equal(stored.token, undefined);
    assert.equal(session.roomName, `drawing:${DOCUMENT_ID}:${PAGE_ID}`);
    assert.equal((await service.verifyCollaborationSession(session.token, session.roomName)).role, "Editor");

    currentRole = "Viewer";
    assert.equal((await service.verifyCollaborationSession(session.token, session.roomName)).role, "Viewer");
    assert.equal(await service.verifyCollaborationSession(
        session.token,
        `drawing:44444444-4444-4444-8444-444444444444:${PAGE_ID}`
    ), null);

    sessionVersion += 1;
    assert.equal(await service.verifyCollaborationSession(session.token, session.roomName), null);
});
