const productStates = ["Nuevo", "Usado"];

function normalizeTags(value) {
    if (value === undefined || value === null || value === "") {
        return [];
    }

    if (!Array.isArray(value)) {
        return null;
    }

    const tags = value
        .map((tag) => typeof tag === "string" ? tag.trim() : "")
        .filter(Boolean);

    return [...new Set(tags)];
}

function validateStorageBoxPayload(payload, options = {}) {
    const errors = [];
    const data = {};

    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        return {
            isValid: false,
            errors: ["Body must be a valid JSON object"],
            data: null
        };
    }

    if (options.requireCode) {
        if (typeof payload.code !== "string" || payload.code.trim() === "") {
            errors.push("code is required and must be a non-empty string");
        } else {
            data.code = payload.code.trim();
        }
    } else if (payload.code !== undefined) {
        if (typeof payload.code !== "string" || payload.code.trim() === "") {
            errors.push("code must be a non-empty string when provided");
        } else {
            data.code = payload.code.trim();
        }
    }

    if (typeof payload.name !== "string" || payload.name.trim() === "") {
        errors.push("name is required and must be a non-empty string");
    } else {
        data.name = payload.name.trim();
    }

    if (typeof payload.description !== "string" || payload.description.trim() === "") {
        errors.push("description is required and must be a non-empty string");
    } else {
        data.description = payload.description.trim();
    }

    if (payload.imageUrl === undefined || payload.imageUrl === null || payload.imageUrl === "") {
        data.imageUrl = "";
    } else if (typeof payload.imageUrl !== "string") {
        errors.push("imageUrl must be a string when provided");
    } else {
        data.imageUrl = payload.imageUrl.trim();
    }

    return {
        isValid: errors.length === 0,
        errors,
        data
    };
}

function validateStorageProductPayload(payload) {
    const errors = [];
    const data = {};

    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        return {
            isValid: false,
            errors: ["Body must be a valid JSON object"],
            data: null
        };
    }

    if (typeof payload.name !== "string" || payload.name.trim() === "") {
        errors.push("name is required and must be a non-empty string");
    } else {
        data.name = payload.name.trim();
    }

    if (typeof payload.description !== "string" || payload.description.trim() === "") {
        errors.push("description is required and must be a non-empty string");
    } else {
        data.description = payload.description.trim();
    }

    if (payload.imageUrl === undefined || payload.imageUrl === null || payload.imageUrl === "") {
        data.imageUrl = "";
    } else if (typeof payload.imageUrl !== "string") {
        errors.push("imageUrl must be a string when provided");
    } else {
        data.imageUrl = payload.imageUrl.trim();
    }

    if (!Number.isInteger(payload.quantity) || payload.quantity < 0) {
        errors.push("quantity is required and must be an integer greater than or equal to 0");
    } else {
        data.quantity = payload.quantity;
    }

    if (typeof payload.state !== "string" || !productStates.includes(payload.state.trim())) {
        errors.push(`state must be one of: ${productStates.join(", ")}`);
    } else {
        data.state = payload.state.trim();
    }

    const normalizedTags = normalizeTags(payload.tags);

    if (normalizedTags === null) {
        errors.push("tags must be an array of strings when provided");
    } else {
        data.tags = normalizedTags;
    }

    return {
        isValid: errors.length === 0,
        errors,
        data
    };
}

module.exports = {
    validateStorageBoxPayload,
    validateStorageProductPayload
};
