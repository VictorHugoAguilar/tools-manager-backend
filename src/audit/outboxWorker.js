const { getFirestore } = require("firebase-admin/firestore");
const { getAdminApp, getAdminDatabase } = require("../config/firebaseAdmin");

const BATCH_SIZE = 50;
const INTERVAL_MS = 5000;
const EVENT_FIELDS = ["schemaVersion", "eventId", "action", "actorId", "targetId", "occurredAt"];
const ROLE_FIELDS = ["permissionsBefore", "permissionsAfter"];

function eventFields(event) {
    return event?.action === "role.permissions.updated" ? [...EVENT_FIELDS, ...ROLE_FIELDS] : EVENT_FIELDS;
}

function validEvent(id, event) {
    const fields = eventFields(event);
    return event && typeof event === "object" && !Array.isArray(event) &&
        Object.keys(event).length === fields.length &&
        fields.every((key) => Object.hasOwn(event, key)) &&
        event.schemaVersion === 1 && event.eventId === id &&
        typeof event.action === "string" && typeof event.actorId === "string" &&
        typeof event.targetId === "string" && typeof event.occurredAt === "string" &&
        (event.action !== "role.permissions.updated" ||
            ROLE_FIELDS.every((key) => typeof event[key] === "string"));
}

class AuditOutboxWorker {
    constructor({ getRealtimeDatabase = getAdminDatabase, getFirestoreDatabase = () => getFirestore(getAdminApp()) } = {}) {
        this.getRealtimeDatabase = getRealtimeDatabase;
        this.getFirestoreDatabase = getFirestoreDatabase;
        this.inFlight = null;
        this.timer = null;
    }

    start() {
        if (this.timer) return;
        void this.flush().catch((error) => console.error("No se pudo publicar la auditoría pendiente.", error));
        this.timer = setInterval(() => {
            void this.flush().catch((error) => console.error("No se pudo publicar la auditoría pendiente.", error));
        }, INTERVAL_MS);
        this.timer.unref();
    }

    stop() {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }

    flush() {
        if (this.inFlight) return this.inFlight;
        this.inFlight = this.publishBatch().finally(() => { this.inFlight = null; });
        return this.inFlight;
    }

    async publishBatch() {
        const outbox = this.getRealtimeDatabase().ref("auditOutbox");
        const snapshot = await outbox.orderByKey().limitToFirst(BATCH_SIZE).get();
        const events = snapshot.val() || {};
        for (const [id, event] of Object.entries(events)) {
            if (!validEvent(id, event)) throw new Error(`Registro de auditoría pendiente no válido: ${id}`);
            const fields = eventFields(event);
            const target = this.getFirestoreDatabase().collection("auditEvents").doc(id);
            try {
                await target.create(event);
            } catch (error) {
                if (error.code !== 6 && error.code !== "already-exists") throw error;
                const existing = await target.get();
                const data = existing.data();
                if (!existing.exists || !data || fields.some((key) => data[key] !== event[key]) ||
                    Object.keys(data).length !== fields.length) {
                    throw new Error(`Conflicto al publicar el registro de auditoría: ${id}`);
                }
            }
            let changed = false;
            await outbox.child(id).transaction((current) => {
                changed = false;
                if (!current) return null;
                if (fields.some((key) => current[key] !== event[key]) ||
                    Object.keys(current).length !== fields.length) {
                    changed = true;
                    return;
                }
                return null;
            }, undefined, false);
            if (changed) throw new Error(`El registro de auditoría pendiente ha cambiado: ${id}`);
        }
    }
}

module.exports = { AuditOutboxWorker, BATCH_SIZE };
