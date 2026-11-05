require("dotenv").config();

const { createHash } = require("node:crypto");
const { getAdminDatabase } = require("../config/firebaseAdmin");
const {
    parseRoomName,
    revalidateCollaborationContext,
    verifyCollaborationSession
} = require("../services/drawingCollaborationService");
const {
    loadCollaborationDocument,
    persistCollaborationDocument,
    MAX_COLLABORATION_STATE_BYTES
} = require("../services/drawingCollaborationPersistenceService");

const TOKEN_SYNC_INTERVAL_MS = 30_000;
const PRESENCE_COLORS = ["#356bd5", "#a14fc1", "#d05e48", "#16876c", "#b07a13", "#46566f"];

function presenceColor(userId) {
    const index = createHash("sha256").update(userId).digest()[0] % PRESENCE_COLORS.length;
    return PRESENCE_COLORS[index];
}

function allowedOrigins() {
    return (process.env.FRONTEND_ORIGINS || "http://localhost:4200")
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean);
}

function sendAccessRevoked(connection) {
    connection.sendStateless(JSON.stringify({ type: "access:revoked" }));
    connection.close();
    connection.webSocket.close(4003, "Drawing access revoked");
}

function attachAccessWatchers(connection, context) {
    const database = getAdminDatabase();
    const refs = [];
    let tokenSyncTimer;
    const watch = (ref, listener) => {
        ref.on("value", listener, (error) => {
            console.error("Drawing collaboration access watch failed", {
                documentId: context.documentId,
                userId: context.userId,
                message: error.message
            });
            sendAccessRevoked(connection);
        });
        refs.push({ ref, listener });
    };

    if (context.shareLinkTokenHash) {
        const ref = database.ref(`drawing/shareLinks/${context.documentId}`);
        watch(ref, (snapshot) => {
            const link = snapshot.val();
            if (!link || !link.isActive || link.tokenHash !== context.shareLinkTokenHash ||
                (link.expiresAt && link.expiresAt <= Date.now())) {
                sendAccessRevoked(connection);
            }
        });
    } else if (context.role !== "Owner") {
        const ref = database.ref(`drawing/access/${context.documentId}/permissions/${context.userId}`);
        watch(ref, (snapshot) => {
            const permission = snapshot.val();
            if (!permission || permission.status !== "Active" ||
                !["Editor", "Viewer"].includes(permission.role)) {
                sendAccessRevoked(connection);
                return;
            }
            const becameReadOnly = permission.role === "Viewer";
            if (connection.readOnly !== becameReadOnly) {
                connection.readOnly = becameReadOnly;
                connection.context = { ...connection.context, role: permission.role };
                connection.sendStateless(JSON.stringify({ type: "access:role-changed", role: permission.role }));
            }
        });
    }

    watch(database.ref(`drawing/documents/${context.documentId}`), (snapshot) => {
        const document = snapshot.val();
        if (!document || document.deletedAt) sendAccessRevoked(connection);
    });
    watch(database.ref(`drawing/pages/${context.pageId}`), (snapshot) => {
        const page = snapshot.val();
        if (!page || page.deletedAt || page.documentId !== context.documentId) {
            sendAccessRevoked(connection);
        }
    });
    watch(database.ref(`authUsers/${context.userId}`), (snapshot) => {
        const profile = snapshot.val();
        if (!profile || profile.isActive === false ||
            (Number(profile.sessionVersion) || 0) !== context.sessionVersion) {
            sendAccessRevoked(connection);
        }
    });
    tokenSyncTimer = setInterval(() => connection.requestToken(), TOKEN_SYNC_INTERVAL_MS);
    connection.onClose(() => {
        clearInterval(tokenSyncTimer);
        for (const { ref, listener } of refs) ref.off("value", listener);
    });
}

async function startDrawingCollaborationServer() {
    const [{ Server }, Y] = await Promise.all([
        import("@hocuspocus/server"),
        import("yjs")
    ]);
    const actorByRoom = new Map();
    const server = new Server({
        name: "drawing-collaboration",
        address: process.env.DRAWING_COLLAB_HOST || "0.0.0.0",
        port: Number(process.env.DRAWING_COLLAB_PORT) || 3001,
        quiet: true,
        debounce: 1000,
        maxDebounce: 5000,
        websocketOptions: { maxPayload: MAX_COLLABORATION_STATE_BYTES },
        async onUpgrade({ request, socket }) {
            const origin = request.headers.origin;
            if (!origin || !allowedOrigins().includes(origin)) {
                // Lanzar una excepción aquí tumba el proceso (Hocuspocus la relanza
                // en el listener "upgrade"): se responde 403 y se cierra el socket.
                console.warn("Drawing collaboration upgrade rejected: origin not allowed", { origin });
                socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
                socket.destroy();
            }
        },
        async onAuthenticate({ documentName, token, connectionConfig }) {
            const session = await verifyCollaborationSession(token, documentName);
            if (!session) throw new Error("La sesión colaborativa no es válida.");
            // En onAuthenticate aún no existe la Connection: el modo lectura se
            // configura en connectionConfig y la sesión se devuelve como contexto.
            connectionConfig.readOnly = session.role === "Viewer";
            return session;
        },
        async onTokenSync({ documentName, token, connection }) {
            const session = await verifyCollaborationSession(token, documentName);
            if (!session) throw new Error("El acceso a la pizarra ha caducado o se ha revocado.");
            connection.readOnly = session.role === "Viewer";
            return session;
        },
        async beforeHandleMessage({ documentName, context, connection, update }) {
            if (update.byteLength > MAX_COLLABORATION_STATE_BYTES) {
                throw new Error("La actualización colaborativa supera el tamaño permitido.");
            }
            const access = await revalidateCollaborationContext(context);
            if (!access) throw new Error("El acceso a la pizarra se ha revocado.");
            if (access.role === "Viewer") {
                connection.readOnly = true;
                throw new Error("El acceso de solo lectura no permite modificar la pizarra.");
            }
            connection.readOnly = false;
            actorByRoom.set(documentName, access.userId);
        },
        async beforeHandleAwareness({ context, states }) {
            const access = await revalidateCollaborationContext(context);
            if (!access) throw new Error("El acceso a la pizarra se ha revocado.");
            for (const [clientId, state] of states) {
                if (!state || typeof state !== "object") {
                    states.delete(clientId);
                    continue;
                }
                state.user = {
                    id: access.userId,
                    name: access.displayName,
                    profileImage: access.profileImage || "",
                    color: presenceColor(access.userId)
                };
                const cursor = state.cursor;
                state.cursor = cursor && typeof cursor === "object" &&
                    Number.isFinite(cursor.x) && Number.isFinite(cursor.y) &&
                    Math.abs(cursor.x) <= 10_000_000 && Math.abs(cursor.y) <= 10_000_000
                    ? { x: cursor.x, y: cursor.y }
                    : null;
                state.selectedIds = Array.isArray(state.selectedIds)
                    ? [...new Set(state.selectedIds.filter((id) =>
                        typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id)))].slice(0, 100)
                    : [];
            }
        },
        async connected({ connection, context }) {
            attachAccessWatchers(connection, context);
        },
        async onLoadDocument({ documentName, document }) {
            const room = parseRoomName(documentName);
            if (!room) throw new Error("La sala colaborativa no es válida.");
            const loaded = await loadCollaborationDocument(room.documentId, room.pageId, document, Y);
            return loaded.document;
        },
        async afterHandleMessage({ documentName, context }) {
            if (context?.userId) actorByRoom.set(documentName, context.userId);
        },
        async onStoreDocument({ documentName, document }) {
            const room = parseRoomName(documentName);
            if (!room) throw new Error("La sala colaborativa no es válida.");
            const actorUserId = actorByRoom.get(documentName) || null;
            await persistCollaborationDocument(room.documentId, room.pageId, document, Y, actorUserId);
            actorByRoom.delete(documentName);
        }
    });
    await server.listen();
    console.log(`Drawing collaboration server listening on ${server.configuration.port}`);
    return server;
}

if (require.main === module) {
    startDrawingCollaborationServer().catch((error) => {
        if (error?.code === "EADDRINUSE") {
            console.error(
                `El puerto ${process.env.DRAWING_COLLAB_PORT || 3001} ya está en uso. ` +
                "Detén la otra instancia del servidor de colaboración o cambia DRAWING_COLLAB_PORT."
            );
        } else {
            console.error("Failed to start drawing collaboration server", error);
        }
        process.exitCode = 1;
    });
}

module.exports = {
    attachAccessWatchers,
    startDrawingCollaborationServer
};
