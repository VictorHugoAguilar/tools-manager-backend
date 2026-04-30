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

function createRepairHistoryHarness(initialRepairs = {}) {
    const store = {
        toolRepairs: structuredClone(initialRepairs)
    };
    let idCounter = 1;

    const firebaseDatabaseMock = {
        ref(_database, dbPath) {
            return { path: dbPath };
        },
        async get(reference) {
            if (reference.path === "toolRepairs") {
                return createSnapshot(store.toolRepairs);
            }

            if (reference.path.startsWith("toolRepairs/")) {
                const [, toolId, repairId] = reference.path.split("/");

                if (!repairId) {
                    return createSnapshot(store.toolRepairs[toolId]);
                }

                return createSnapshot(store.toolRepairs[toolId]?.[repairId]);
            }

            return createSnapshot(undefined);
        },
        push(reference) {
            const key = `repair-${idCounter++}`;

            return {
                key,
                path: `${reference.path}/${key}`
            };
        },
        async set(reference, value) {
            const [, toolId, repairId] = reference.path.split("/");
            store.toolRepairs[toolId] ??= {};
            store.toolRepairs[toolId][repairId] = value;
        },
        async remove(reference) {
            const [, toolId, repairId] = reference.path.split("/");

            if (!store.toolRepairs[toolId]) {
                return;
            }

            delete store.toolRepairs[toolId][repairId];
        }
    };

    const repairHistoryService = loadModuleWithMocks(
        path.resolve(__dirname, "../../src/services/repairHistoryService.js"),
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
        repairHistoryService,
        store
    };
}

function createRepair(overrides = {}) {
    return {
        entryDate: "2026-04-01",
        exitDate: "2026-04-03",
        status: "Reparado",
        priority: "Normal",
        issue: "Fallo electrico",
        description: "Cambio de interruptor y pruebas finales.",
        technicianId: "tech-1",
        technicianName: "Juan Perez",
        cost: 150,
        observations: "",
        ...overrides
    };
}

test("findAllByToolId returns repairs sorted by entryDate descending", async () => {
    const { repairHistoryService } = createRepairHistoryHarness({
        "tool-1": {
            a1: createRepair({ entryDate: "2026-04-01" }),
            a2: createRepair({ entryDate: "2026-04-12" })
        }
    });

    const result = await repairHistoryService.findAllByToolId("tool-1");

    assert.deepEqual(result.map((item) => item.id), ["a2", "a1"]);
});

test("create stores a repair record under the selected tool", async () => {
    const { repairHistoryService, store } = createRepairHistoryHarness();

    const created = await repairHistoryService.create("tool-1", createRepair());

    assert.equal(created.id, "repair-1");
    assert.deepEqual(store.toolRepairs["tool-1"]["repair-1"], created);
});

test("update returns null when the repair record does not exist", async () => {
    const { repairHistoryService } = createRepairHistoryHarness();

    const result = await repairHistoryService.update("tool-1", "missing", createRepair());

    assert.equal(result, null);
});

test("remove deletes an existing repair record", async () => {
    const { repairHistoryService, store } = createRepairHistoryHarness({
        "tool-1": {
            r1: createRepair({ id: "r1" })
        }
    });

    const result = await repairHistoryService.remove("tool-1", "r1");

    assert.equal(result, true);
    assert.equal(store.toolRepairs["tool-1"].r1, undefined);
});
