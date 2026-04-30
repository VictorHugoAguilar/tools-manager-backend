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

function createLocationServiceHarness(initialLocations = {}) {
    const store = {
        locations: structuredClone(initialLocations)
    };
    let idCounter = 1;

    const firebaseDatabaseMock = {
        ref(_database, dbPath) {
            return { path: dbPath };
        },
        async get(reference) {
            if (reference.path === "locations") {
                return createSnapshot(store.locations);
            }

            const locationId = reference.path.replace("locations/", "");
            return createSnapshot(store.locations[locationId]);
        },
        push(reference) {
            const key = `location-${idCounter++}`;

            return {
                key,
                path: `${reference.path}/${key}`
            };
        },
        async set(reference, value) {
            const locationId = reference.path.replace("locations/", "");
            store.locations[locationId] = value;
        },
        async remove(reference) {
            const locationId = reference.path.replace("locations/", "");
            delete store.locations[locationId];
        }
    };

    const locationService = loadModuleWithMocks(
        path.resolve(__dirname, "../../src/services/locationService.js"),
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
        locationService,
        store
    };
}

test("findAll returns locations sorted by name", async () => {
    const { locationService } = createLocationServiceHarness({
        b1: { id: "b1", name: "Taller Mecanico", description: "" },
        a1: { id: "a1", name: "Almacen Central", description: "" }
    });

    const result = await locationService.findAll();

    assert.deepEqual(result.map((item) => item.name), ["Almacen Central", "Taller Mecanico"]);
});

test("create stores a new location with generated id", async () => {
    const { locationService, store } = createLocationServiceHarness();

    const created = await locationService.create({
        name: "Zona de Diagnostico",
        description: "Banco de pruebas"
    });

    assert.equal(created.id, "location-1");
    assert.deepEqual(store.locations["location-1"], created);
});

test("remove deletes an existing location", async () => {
    const { locationService, store } = createLocationServiceHarness({
        a1: { id: "a1", name: "Almacen Central", description: "" }
    });

    const result = await locationService.remove("a1");

    assert.equal(result, true);
    assert.equal(store.locations.a1, undefined);
});
