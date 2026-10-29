const COLLECTION_FIELDS = {
    shelves: ["name"],
    levels: ["shelfId", "name"],
    organizers: ["levelId", "name", "type"],
    compartments: ["organizerId", "name"],
    materials: ["compartmentId", "name", "category"]
};

const NUMERIC_FIELDS = {
    shelves: ["position"],
    levels: ["position", "width", "depth"],
    organizers: ["position", "columns", "width", "depth"],
    compartments: ["position", "row", "column"],
    materials: ["diameter", "length", "innerDiameter", "outerDiameter", "quantity"]
};
const DIMENSION_FIELDS = ["width", "depth"];
const REQUIRED_NUMERIC_FIELDS = {
    shelves: ["position"],
    levels: ["position"],
    organizers: ["position", "columns"],
    compartments: ["position", "row", "column"],
    materials: []
};

function validateWorkshopStoragePayload(collection, input) {
    const errors = [];
    const fields = COLLECTION_FIELDS[collection];

    if (!fields || !input || typeof input !== "object" || Array.isArray(input)) {
        return { isValid: false, errors: ["Invalid request body"] };
    }

    for (const field of fields) {
        if (typeof input[field] !== "string" || !input[field].trim()) {
            errors.push(`${field} is required`);
        }
    }

    for (const field of REQUIRED_NUMERIC_FIELDS[collection]) {
        if (input[field] === undefined || input[field] === null || input[field] === "") {
            errors.push(`${field} is required`);
        }
    }

    for (const field of NUMERIC_FIELDS[collection]) {
        if (input[field] !== undefined && input[field] !== "" &&
            (!Number.isFinite(Number(input[field])) || Number(input[field]) < 0)) {
            errors.push(`${field} must be a non-negative number`);
        }
    }

    for (const field of DIMENSION_FIELDS) {
        if (NUMERIC_FIELDS[collection].includes(field) &&
            input[field] !== undefined && input[field] !== null && input[field] !== "" &&
            Number(input[field]) <= 0) {
            errors.push(`${field} must be greater than zero`);
        }
    }

    if (["shelves", "levels", "organizers", "compartments"].includes(collection) &&
        input.position !== undefined &&
        (!Number.isInteger(Number(input.position)) || Number(input.position) < 1)) {
        errors.push("position must be a positive integer");
    }

    if (collection === "organizers" && input.columns !== undefined &&
        (!Number.isInteger(Number(input.columns)) || Number(input.columns) < 1)) {
        errors.push("columns must be a positive integer");
    }

    if (collection === "compartments") {
        for (const field of ["row", "column"]) {
            if (input[field] !== undefined && input[field] !== "" &&
                (!Number.isInteger(Number(input[field])) || Number(input[field]) < 1)) {
                errors.push(`${field} must be a positive integer`);
            }
        }
    }

    const data = Object.fromEntries(
        Object.entries(input).map(([key, value]) => {
            if (NUMERIC_FIELDS[collection].includes(key)) {
                return [key, value === "" || value === null ? null : Number(value)];
            }

            return [key, typeof value === "string" ? value.trim() : value];
        })
    );

    return { isValid: errors.length === 0, errors, data };
}

module.exports = { validateWorkshopStoragePayload };
