const test = require("node:test");
const assert = require("node:assert/strict");
const { loadModuleWithMocks } = require("../helpers/loadModuleWithMocks");

let database;
const profiles = {
    owner: { id: "owner", firstName: "Ada", lastName: "Owner", isActive: true },
    editor: { id: "editor", firstName: "Grace", lastName: "Editor", isActive: true },
    viewer: { id: "viewer", firstName: "Lin", lastName: "Viewer", isActive: true }
};

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
            return {
                exists: () => value !== null && value !== undefined,
                val: () => value === undefined ? null : structuredClone(value)
            };
        },
        async set(value) {
            writePath(path, value);
        },
        async update(changes) {
            for (const [key, value] of Object.entries(changes)) {
                writePath([path, key].filter(Boolean).join("/"), value);
            }
        },
        async transaction(update) {
            // Como el SDK de Firebase en servidor: la primera llamada recibe la caché
            // local (vacía) y, si no aborta, se reintenta con el valor real.
            const first = update(null);
            if (first === undefined) return { committed: false, snapshot: { val: () => null } };
            const current = readPath(path);
            const next = update(current === undefined ? null : structuredClone(current));
            if (next === undefined) return { committed: false, snapshot: { val: () => null } };
            writePath(path, next);
            return { committed: true, snapshot: { val: () => structuredClone(next) } };
        }
    };
}

const service = loadModuleWithMocks("../../src/services/drawingAccessService", {
    "../config/firebaseAdmin": { getAdminDatabase: () => ({ ref: reference }) },
    "./userService": {
        getProfile: async (id) => profiles[id] || null,
        listProfiles: async ({ search }) => ({
            users: Object.values(profiles).filter((profile) =>
                `${profile.firstName} ${profile.lastName}`.toLowerCase().includes(search.toLowerCase())
            )
        })
    },
    "./drawingRateLimitService": { consumeDrawingRateLimit: async () => {} }
});

test.beforeEach(() => {
    database = {
        drawing: {
            documents: {
                board: { ownerUserId: "owner", name: "Board", deletedAt: null, isArchived: false }
            }
        }
    };
});

test("pending invitations do not grant access and acceptance atomically activates Viewer or Editor", async () => {
    const invitation = await service.createInvitation("board", "owner", "editor", "Editor");
    assert.equal(invitation.status, "Pending");
    await assert.rejects(service.requireDocumentAccess("board", "editor"), { statusCode: 403 });

    const accepted = await service.transitionInvitation(invitation.id, "editor", "accept");
    assert.equal(accepted.status, "Accepted");
    assert.equal((await service.getDocumentAccess("board", "editor")).role, "Editor");
    assert.equal(readPath(`drawing/accessByUser/editor/board`), true);

    writePath("drawing/accessByUser/editor/board", null);
    writePath(`drawing/permissionsById/${service.permissionId("board", "editor")}`, null);
    assert.equal((await service.transitionInvitation(invitation.id, "editor", "accept")).status, "Accepted");
    assert.equal(readPath("drawing/accessByUser/editor/board"), true);
    assert.ok(readPath(`drawing/permissionsById/${service.permissionId("board", "editor")}`));
});

test("retrying a pending invitation repairs its recipient indexes", async () => {
    const invitation = await service.createInvitation("board", "owner", "viewer", "Viewer");
    writePath(`drawing/invitationsByRecipient/viewer/${invitation.id}`, null);
    writePath(`drawing/invitationLookup/${invitation.id}`, null);

    await assert.rejects(
        service.createInvitation("board", "owner", "viewer", "Viewer"),
        { statusCode: 409 }
    );
    assert.equal(readPath(`drawing/invitationsByRecipient/viewer/${invitation.id}`), true);
    assert.equal(readPath(`drawing/invitationLookup/${invitation.id}`), "board");
});

test("only the owner can invite, and Editors cannot write document metadata", async () => {
    const invitation = await service.createInvitation("board", "owner", "editor", "Editor");
    await service.transitionInvitation(invitation.id, "editor", "accept");
    await assert.rejects(service.createInvitation("board", "editor", "viewer", "Viewer"), { statusCode: 403 });
    await assert.rejects(service.requireDocumentAccess("board", "editor", "Owner"), { statusCode: 403 });
});

test("permission changes and revocations update access indexes", async () => {
    const invitation = await service.createInvitation("board", "owner", "viewer", "Editor");
    await service.transitionInvitation(invitation.id, "viewer", "accept");
    const id = service.permissionId("board", "viewer");
    await service.changePermission(id, "owner", "Viewer");
    assert.equal((await service.getDocumentAccess("board", "viewer")).role, "Viewer");
    assert.equal(await service.revokePermission(id, "owner"), true);
    await assert.rejects(service.getDocumentAccess("board", "viewer"), { statusCode: 403 });
    assert.equal(readPath("drawing/accessByUser/viewer/board"), undefined);
});

test("search excludes the requester and inactive profiles", async () => {
    const users = await service.searchUsers("Grace", "owner");
    assert.deepEqual(users.map((user) => user.id), ["editor"]);
    assert.equal(Object.hasOwn(users[0], "sessionVersion"), false);
});
