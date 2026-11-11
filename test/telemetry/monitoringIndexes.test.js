const test = require("node:test");
const assert = require("node:assert/strict");
const { indexes } = require("../../firestore.monitoring.indexes.json");

test("monitoring index configuration covers every supported structured query", () => {
    const hasIndex = (collectionGroup, fields) => indexes.some((index) =>
        index.collectionGroup === collectionGroup && index.queryScope === "COLLECTION" &&
        JSON.stringify(index.fields) === JSON.stringify(fields.map(([fieldPath, order]) => ({ fieldPath, order })))
    );
    const filters = ["service", "level", "eventName", "traceId"];
    for (let mask = 0; mask < 16; mask++) {
        const fields = [["environment", "ASCENDING"]];
        filters.forEach((field, bit) => {
            if (mask & (1 << bit)) fields.push([field, "ASCENDING"]);
        });
        fields.push(["receivedAt", "DESCENDING"]);
        assert.ok(hasIndex("monitoringEvents", fields), `Falta índice para máscara ${mask}`);
    }
    assert.ok(hasIndex("monitoringInstances", [
        ["environment", "ASCENDING"], ["heartbeatAt", "DESCENDING"]
    ]));
    assert.ok(hasIndex("monitoringActiveUsers", [
        ["environment", "ASCENDING"], ["lastInteractionAt", "ASCENDING"]
    ]));
    assert.ok(hasIndex("monitoringMetricBuckets", [
        ["environment", "ASCENDING"], ["metricName", "ASCENDING"],
        ["service", "ASCENDING"], ["intervalStart", "ASCENDING"]
    ]));
    assert.ok(hasIndex("auditEvents", [
        ["auditScope", "ASCENDING"], ["occurredAt", "DESCENDING"]
    ]), "Falta el índice para el historial de almacenamiento");
});
