const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { loadModuleWithMocks } = require("../helpers/loadModuleWithMocks");

function createSnapshot(value) {
    return {
        val() {
            return value;
        },
        exists() {
            return value !== null && value !== undefined;
        }
    };
}

function createTechnicianServiceHarness(initialTechnicians = {}) {
    const store = {
        technicians: structuredClone(initialTechnicians)
    };
    let idCounter = 1;

    const firebaseDatabaseMock = {
        ref(_database, dbPath) {
            return { path: dbPath };
        },
        async get(reference) {
            if (reference.path === "technicians") {
                return createSnapshot(store.technicians);
            }

            const technicianId = reference.path.replace("technicians/", "");
            return createSnapshot(store.technicians[technicianId]);
        },
        push(reference) {
            const key = `tech-${idCounter++}`;

            return {
                key,
                path: `${reference.path}/${key}`
            };
        },
        async set(reference, value) {
            const technicianId = reference.path.replace("technicians/", "");
            store.technicians[technicianId] = value;
        },
        async remove(reference) {
            const technicianId = reference.path.replace("technicians/", "");
            delete store.technicians[technicianId];
        }
    };

    const technicianService = loadModuleWithMocks(
        path.resolve(__dirname, "../../src/services/technicianService.js"),
        {
            "firebase/database": firebaseDatabaseMock,
            "../config/database": {
                getDatabaseInstance() {
                    return {};
                }
            }
        }
    );

    return {
        technicianService,
        store
    };
}

test("findAll returns technicians sorted by name", async () => {
    const { technicianService } = createTechnicianServiceHarness({
        b1: { id: "b1", name: "Maria Lopez", specialty: "Electrica", active: true },
        a1: { id: "a1", name: "Ana Torres", specialty: "Soldadura", active: true }
    });

    const result = await technicianService.findAll();

    assert.deepEqual(result.map((item) => item.name), ["Ana Torres", "Maria Lopez"]);
});

test("create stores a new technician with generated id", async () => {
    const { technicianService, store } = createTechnicianServiceHarness();

    const created = await technicianService.create({
        name: "Carlos Ramirez",
        specialty: "Mecanica",
        phone: "",
        email: "",
        notes: "",
        active: true
    });

    assert.equal(created.id, "tech-1");
    assert.deepEqual(store.technicians["tech-1"], created);
});

test("update returns null for an unknown technician", async () => {
    const { technicianService } = createTechnicianServiceHarness();

    const result = await technicianService.update("missing", {
        name: "Juan Perez",
        specialty: "Revision",
        phone: "",
        email: "",
        notes: "",
        active: true
    });

    assert.equal(result, null);
});

test("remove deletes an existing technician", async () => {
    const { technicianService, store } = createTechnicianServiceHarness({
        a1: { id: "a1", name: "Ana Torres", specialty: "Soldadura", active: true }
    });

    const result = await technicianService.remove("a1");

    assert.equal(result, true);
    assert.equal(store.technicians.a1, undefined);
});
