function parseCost(value) {
    if (typeof value === "number") {
        return value;
    }

    if (typeof value === "string") {
        return Number(value.trim().replace(",", "."));
    }

    return Number(value);
}

function validateRepairPayload(payload) {
    const errors = [];

    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        return {
            isValid: false,
            errors: ["Body must be a valid JSON object"],
            data: null
        };
    }

    const requiredStringFields = [
        "entryDate",
        "exitDate",
        "status",
        "priority",
        "issue",
        "description",
        "technicianId"
    ];

    const data = {};

    requiredStringFields.forEach((field) => {
        if (typeof payload[field] !== "string" || payload[field].trim() === "") {
            errors.push(`${field} is required and must be a non-empty string`);
            return;
        }

        data[field] = payload[field].trim();
    });

    if (payload.cost !== undefined && payload.cost !== null && payload.cost !== "") {
        const cost = parseCost(payload.cost);

        if (Number.isNaN(cost) || cost < 0) {
            errors.push("cost must be a valid non-negative number");
        } else {
            data.cost = cost;
        }
    } else {
        data.cost = null;
    }

    data.observations = typeof payload.observations === "string"
        ? payload.observations.trim()
        : "";

    return {
        isValid: errors.length === 0,
        errors,
        data
    };
}

module.exports = {
    validateRepairPayload
};
