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
        return undefined;
    }

    const parsedValue = Number(value);
    return Number.isNaN(parsedValue) ? undefined : parsedValue;
}

function buildToolFilters(query = {}) {
    const filters = {};

    searchableFields.forEach((field) => {
        if (typeof query[field] === "string" && query[field].trim() !== "") {
            filters[field] = query[field].trim();
        }
    });

    const minLong = parseOptionalNumber(query.minLong);
    const maxLong = parseOptionalNumber(query.maxLong);

    if (minLong !== undefined) {
        filters.minLong = minLong;
    }

    if (maxLong !== undefined) {
        filters.maxLong = maxLong;
    }

    return filters;
}

function parsePositiveInteger(value) {
    if (value === undefined) {
        return { value: undefined, isValid: true };
    }

    const parsedValue = Number(value);
    const isInteger = Number.isInteger(parsedValue);

    if (!isInteger || parsedValue <= 0) {
        return { value: undefined, isValid: false };
    }

    return { value: parsedValue, isValid: true };
}

function buildToolQueryOptions(query = {}) {
    const errors = [];
    const filters = buildToolFilters(query);
    const page = parsePositiveInteger(query.page);
    const limit = parsePositiveInteger(query.limit);
    const paginationEnabled = query.page !== undefined || query.limit !== undefined;
    const sorting = {
        enabled: false,
        sortBy: undefined,
        sortOrder: "asc"
    };

    if (!page.isValid) {
        errors.push("page must be a positive integer");
    }

    if (!limit.isValid) {
        errors.push("limit must be a positive integer");
    }

    if (
        filters.minLong !== undefined &&
        filters.maxLong !== undefined &&
        filters.minLong > filters.maxLong
    ) {
        errors.push("minLong cannot be greater than maxLong");
    }

    if (query.sortBy !== undefined) {
        if (
            typeof query.sortBy !== "string" ||
            !sortableFields.includes(query.sortBy.trim())
        ) {
            errors.push(
                `sortBy must be one of: ${sortableFields.join(", ")}`
            );
        } else {
            sorting.enabled = true;
            sorting.sortBy = query.sortBy.trim();
        }
    }

    if (query.sortOrder !== undefined) {
        if (
            typeof query.sortOrder !== "string" ||
            !["asc", "desc"].includes(query.sortOrder.trim().toLowerCase())
        ) {
            errors.push("sortOrder must be 'asc' or 'desc'");
        } else {
            sorting.sortOrder = query.sortOrder.trim().toLowerCase();
        }
    }

    if (!sorting.enabled && query.sortOrder !== undefined) {
        errors.push("sortOrder requires sortBy");
    }

    return {
        isValid: errors.length === 0,
        errors,
        data: {
            filters,
            sorting,
            pagination: {
                enabled: paginationEnabled,
                page: page.value || 1,
                limit: limit.value || 10
            }
        }
    };
}

module.exports = {
    validateToolPayload,
    validateStatePayload,
    buildToolQueryOptions
};
