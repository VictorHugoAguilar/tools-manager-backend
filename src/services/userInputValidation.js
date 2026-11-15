function invalid(message) {
    throw Object.assign(new Error(message), { statusCode: 400 });
}

function validateName(value, label) {
    if (typeof value !== "string" || !value.trim() || value.trim().length > 80) {
        invalid(`${label} es obligatorio y no puede superar 80 caracteres.`);
    }
    return value.trim();
}

function validateEmail(value) {
    const email = typeof value === "string" ? value.trim().toLowerCase() : "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
        invalid("Introduce un correo electrónico válido.");
    }
    return email;
}

function validateNewPassword(password) {
    if (typeof password !== "string" || password.length < 10 || password.length > 128 ||
        !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
        invalid("La contraseña debe tener entre 10 y 128 caracteres e incluir letras y números.");
    }
    return password;
}

module.exports = { validateName, validateEmail, validateNewPassword };
