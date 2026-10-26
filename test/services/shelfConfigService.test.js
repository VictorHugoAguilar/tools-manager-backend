const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { loadModuleWithMocks } = require("../helpers/loadModuleWithMocks");

function createSnapshot(value) {
    return {
        exists: () => value !== undefined && value !== null,
        val: () => value
    };
}

function createShelfConfigServiceHarness({
    shelfConfig = undefined,
    storageBoxes = {}
} = {}) {
    const store = {
        shelfConfig,
        storageBoxes
    };
    const writes = [];
    const database = {};
    const firebaseDatabase = {
        ref(_database, location) {
            return { location };
        },
        async get(reference) {
            if (reference.location === "shelfConfig") {
                return createSnapshot(store.shelfConfig);
            }

            if (reference.location === "storageBoxes") {
                return createSnapshot(store.storageBoxes);
            }

            throw new Error(`Unexpected read: ${reference.location}`);
        },
        async set(reference, value) {
            writes.push({ location: reference.location, value });

            if (reference.location === "shelfConfig") {
                store.shelfConfig = value;
                return;
            }

            throw new Error(`Unexpected write: ${reference.location}`);
        }
    };

    const service = loadModuleWithMocks(
        path.resolve(__dirname, "../../src/services/shelfConfigService.js"),
        {
            "firebase/database": firebaseDatabase,
            "../config/database": {
                getDatabaseInstance: () => database
            }
        }
    );

    return { service, store, writes };
}

test("getShelfConfig returns the default when no configuration exists", async () => {
    const { service } = createShelfConfigServiceHarness();

    const config = await service.getShelfConfig();

    assert.deepEqual(config, { rows: 5, columns: 6 });
});

test("updateShelfConfig persists a compatible configuration", async () => {
    const { service, store, writes } = createShelfConfigServiceHarness();

    const config = await service.updateShelfConfig({ rows: 4, columns: 3 });

    assert.deepEqual(config, { rows: 4, columns: 3 });
    assert.deepEqual(store.shelfConfig, { rows: 4, columns: 3 });
    assert.deepEqual(writes, [{
        location: "shelfConfig",
        value: { rows: 4, columns: 3 }
    }]);
});

test("updateShelfConfig rejects fewer rows than an existing box requires", async () => {
    const { service, writes } = createShelfConfigServiceHarness({
        storageBoxes: {
            box1: { shelfRow: 5, shelfColumn: 1 }
        }
    });

    await assert.rejects(
        () => service.updateShelfConfig({ rows: 4, columns: 6 }),
        (error) => error.code === "SHELF_CONFIG_CONFLICT"
            && error.message.includes("Fila 5")
    );
    assert.deepEqual(writes, []);
});

test("updateShelfConfig rejects fewer columns than an existing box requires", async () => {
    const { service, writes } = createShelfConfigServiceHarness({
        storageBoxes: {
            box1: { shelfRow: 1, shelfColumn: 6 }
        }
    });

    await assert.rejects(
        () => service.updateShelfConfig({ rows: 5, columns: 5 }),
        (error) => error.code === "SHELF_CONFIG_CONFLICT"
            && error.message.includes("Columna 6")
    );
    assert.deepEqual(writes, []);
});

test("updateShelfConfig allows a resize that contains all boxes", async () => {
    const { service, writes } = createShelfConfigServiceHarness({
        storageBoxes: {
            box1: { shelfRow: 2, shelfColumn: 2 },
            box2: { shelfRow: 4, shelfColumn: 3 }
        }
    });

    await service.updateShelfConfig({ rows: 4, columns: 3 });

    assert.equal(writes.length, 1);
});

