const { getFirestore } = require("firebase-admin/firestore");
const { getAdminApp, getAdminDatabase } = require("../config/firebaseAdmin");

const BATCH_SIZE = 50;
const STATUS_LIMIT = 100;
const INTERVAL_MS = 5000;
const EVENT_FIELDS = ["schemaVersion", "eventId", "action", "actorId", "targetId", "occurredAt"];
const ROLE_FIELDS = ["permissionsBefore", "permissionsAfter"];
const USER_ROLE_FIELDS = ["roleBefore", "roleAfter"];
const USER_STATUS_FIELDS = ["activeBefore", "activeAfter"];

class InvalidOutboxEntryError extends Error {}

function eventFields(event) {
    const scopedFields = event?.auditScope ? [...EVENT_FIELDS, "auditScope"] : EVENT_FIELDS;
    if (event?.action === "workshop.category.created" || event?.action === "workshop.category.deleted") return [...scopedFields, "categoryId"];
    if (typeof event?.action === "string" && event.action.startsWith("box.product.")) return [...scopedFields, "boxId"];
    if (typeof event?.action === "string" && event.action.startsWith("repair.")) return [...EVENT_FIELDS, "toolId"];
    if (event?.action === "role.permissions.updated") return [...EVENT_FIELDS, ...ROLE_FIELDS];
    if (event?.action === "user.role.updated") return [...EVENT_FIELDS, ...USER_ROLE_FIELDS];
    if (event?.action === "user.status.updated") return [...EVENT_FIELDS, ...USER_STATUS_FIELDS];
    return scopedFields;
}

function validEvent(id, event) {
    const fields = eventFields(event);
    return event && typeof event === "object" && !Array.isArray(event) &&
        Object.keys(event).length === fields.length &&
        fields.every((key) => Object.hasOwn(event, key)) &&
        event.schemaVersion === 1 && event.eventId === id &&
        typeof event.action === "string" && typeof event.actorId === "string" &&
        typeof event.targetId === "string" && typeof event.occurredAt === "string" &&
        (!Object.hasOwn(event, "auditScope") || ["workshop", "boxes"].includes(event.auditScope)) &&
        (!fields.includes("categoryId") || typeof event.categoryId === "string") &&
        (!fields.includes("boxId") || typeof event.boxId === "string") &&
        (!fields.includes("toolId") || typeof event.toolId === "string") &&
        (event.action !== "role.permissions.updated" ||
            ROLE_FIELDS.every((key) => typeof event[key] === "string")) &&
        (event.action !== "user.role.updated" ||
            USER_ROLE_FIELDS.every((key) => typeof event[key] === "string")) &&
        (event.action !== "user.status.updated" ||
            USER_STATUS_FIELDS.every((key) => typeof event[key] === "boolean"));
}

class AuditOutboxWorker {
    constructor({ getRealtimeDatabase = getAdminDatabase, getFirestoreDatabase = () => getFirestore(getAdminApp()) } = {}) {
        this.getRealtimeDatabase = getRealtimeDatabase;
        this.getFirestoreDatabase = getFirestoreDatabase;
        this.inFlight = null;
        this.timer = null;
        this.consecutiveFailures = 0;
        this.lastAttemptAt = null;
        this.lastSuccessfulCheckAt = null;
        this.lastFailureAt = null;
        this.scanAfter = null;
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
        this.lastAttemptAt = new Date().toISOString();
        this.inFlight = this.publishBatch().then(() => {
            this.consecutiveFailures = 0;
            this.lastSuccessfulCheckAt = new Date().toISOString();
        }, (error) => {
            this.consecutiveFailures += 1;
            this.lastFailureAt = new Date().toISOString();
            throw error;
        }).finally(() => { this.inFlight = null; });
        return this.inFlight;
    }

    getHealth() {
        return {
            running: this.timer !== null,
            inFlight: this.inFlight !== null,
            consecutiveFailures: this.consecutiveFailures,
            lastAttemptAt: this.lastAttemptAt,
            lastSuccessfulCheckAt: this.lastSuccessfulCheckAt,
            lastFailureAt: this.lastFailureAt
        };
    }

    async getPendingSummary() {
        const snapshot = await this.getRealtimeDatabase().ref("auditOutbox")
            .orderByKey().limitToFirst(STATUS_LIMIT + 1).get();
        const count = snapshot.numChildren();
        return { count: Math.min(count, STATUS_LIMIT), truncated: count > STATUS_LIMIT };
    }

    async publishBatch() {
        const outbox = this.getRealtimeDatabase().ref("auditOutbox");
        let query = outbox.orderByKey();
        if (this.scanAfter !== null) query = query.startAfter(this.scanAfter);
        const snapshot = await query.limitToFirst(BATCH_SIZE).get();
        const events = [];
        snapshot.forEach((child) => { events.push([child.key, child.val()]); });
        const errors = [];
        for (const [id, event] of events) {
            try {
                await this.publishEntry(outbox, id, event);
            } catch (error) {
                if (!(error instanceof InvalidOutboxEntryError)) {
                    if (errors.length) throw new AggregateError([...errors, error], error.message);
                    throw error;
                }
                errors.push(error);
            }
        }
        this.scanAfter = events.length === BATCH_SIZE ? events.at(-1)[0] : null;
        if (errors.length) {
            if (errors.length === 1) throw errors[0];
            throw new AggregateError(errors, `${errors.length} registros de auditoría pendientes requieren revisión.`);
        }
    }

    async publishEntry(outbox, id, event) {
        if (!validEvent(id, event)) throw new InvalidOutboxEntryError(`Registro de auditoría pendiente no válido: ${id}`);
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
                throw new InvalidOutboxEntryError(`Conflicto al publicar el registro de auditoría: ${id}`);
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
        if (changed) throw new InvalidOutboxEntryError(`El registro de auditoría pendiente ha cambiado: ${id}`);
    }
}

const auditWorker = new AuditOutboxWorker();
module.exports = { AuditOutboxWorker, auditWorker, BATCH_SIZE, STATUS_LIMIT };
