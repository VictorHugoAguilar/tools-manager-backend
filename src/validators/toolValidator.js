const requiredStringFields = [
    "name",
    "type",
    "category",
    "description",
    "urlSrc",
    "state",
    "material"
];

const searchableFields = [
    "id",
    "name",
    "type",
    "category",
    "description",
    "urlSrc",
    "state",
    "material",
    "q"
];

const sortableFields = [
    "id",
    "name",
    "type",
    "category",
    "description",
    "urlSrc",
    "state",
    "material",
    "long"
];

function validateToolPayload(payload, options = {}) {
    const errors = [];
    const data = {};

    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        return {
            isValid: false,
            errors: ["Body must be a valid JSON object"],
            data: null
        };
    }

    if (options.requireId && payload.id && typeof payload.id !== "string") {
        errors.push("id must be a string");
    }

    requiredStringFields.forEach((field) => {
        if (typeof payload[field] !== "string" || payload[field].trim() === "") {
            errors.push(`${field} is required and must be a non-empty string`);
            return;
        }

        data[field] = payload[field].trim();
    });

    if (typeof payload.long !== "number" || Number.isNaN(payload.long)) {
        errors.push("long is required and must be a valid number");
    } else {
        data.long = payload.long;
    }

    return {
        isValid: errors.length === 0,
        errors,
        data
    };
}

function validateStatePayload(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        return {
            isValid: false,
            errors: ["Body must be a valid JSON object"],
            data: null
        };
    }

    if (typeof payload.state !== "string" || payload.state.trim() === "") {
        return {
            isValid: false,
            errors: ["state is required and must be a non-empty string"],
            data: null
        };
    }

    return {
        isValid: true,
        errors: [],
        data: {
            state: payload.state.trim()
        }
    };
}

function parseOptionalNumber(value) {
    if (value === undefined) {