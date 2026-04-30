function validateTechnicianPayload(payload) {
    const errors = [];

    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        return {
            isValid: false,
            errors: ["Body must be a valid JSON object"],
            data: null
        };
    }

    const name = typeof payload.name === "string" ? payload.name.trim() : "";
    const specialty = typeof payload.specialty === "string" ? payload.specialty.trim() : "";
    const phone = typeof payload.phone === "string" ? payload.phone.trim() : "";
    const email = typeof payload.email === "string" ? payload.email.trim() : "";
    const notes = typeof payload.notes === "string" ? payload.notes.trim() : "";
    const active = payload.active === undefined ? true : payload.active;

    if (name === "") {
        errors.push("name is required and must be a non-empty string");
    }

    if (specialty === "") {
        errors.push("specialty is required and must be a non-empty string");
    }

    if (typeof active !== "boolean") {
        errors.push("active must be a boolean");
    }

    return {
        isValid: errors.length === 0,
        errors,
        data: {
            name,
            specialty,
            phone,
            email,
            notes,
            active
        }
    };
}

module.exports = {
    validateTechnicianPayload
};
