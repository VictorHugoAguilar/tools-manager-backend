function validateLocationPayload(payload) {
    const errors = [];

    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        return {
            isValid: false,
            errors: ["Body must be a valid JSON object"],
            data: null
        };
    }

    const name = typeof payload.name === "string" ? payload.name.trim() : "";
    const description = typeof payload.description === "string"
        ? payload.description.trim()
        : "";

    if (name === "") {
        errors.push("name is required and must be a non-empty string");
    }

    return {
        isValid: errors.length === 0,
        errors,
        data: {
            name,
            description
        }
    };
}

module.exports = {
    validateLocationPayload
};
