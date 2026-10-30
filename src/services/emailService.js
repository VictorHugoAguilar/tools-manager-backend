const nodemailer = require("nodemailer");

function getTransport() {
    const host = process.env.SMTP_HOST;
    const port = Number(process.env.SMTP_PORT);
    const from = process.env.SMTP_FROM;
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535 || !from) {
        throw Object.assign(new Error("El envío de correo no está configurado."), { statusCode: 503 });
    }

    const hasUser = Boolean(process.env.SMTP_USER);
    const hasPassword = Boolean(process.env.SMTP_PASSWORD);
    if (hasUser !== hasPassword) {
        throw Object.assign(new Error("SMTP_USER y SMTP_PASSWORD deben configurarse juntos."), { statusCode: 503 });
    }
    const auth = hasUser
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD }
        : undefined;
    return nodemailer.createTransport({
        host,
        port,
        secure: process.env.SMTP_SECURE === "true" || port === 465,
        ...(auth ? { auth } : {})
    });
}

function escapeHtml(value) {
    return value.replace(/[&<>"']/g, (character) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
    })[character]);
}

async function sendPasswordResetEmail(email, firstName, resetUrl) {
    const frontendUrl = process.env.FRONTEND_URL;
    if (!frontendUrl) {
        throw Object.assign(new Error("FRONTEND_URL no está configurada para los correos de recuperación."), {
            statusCode: 503
        });
    }
    let url;
    try {
        url = new URL(frontendUrl);
    } catch {
        throw Object.assign(new Error("FRONTEND_URL no es válida."), { statusCode: 503 });
    }
    if (!["http:", "https:"].includes(url.protocol)) {
        throw Object.assign(new Error("FRONTEND_URL debe usar HTTP o HTTPS."), { statusCode: 503 });
    }

    await getTransport().sendMail({
        from: process.env.SMTP_FROM,
        to: email,
        subject: "Restablece tu contraseña",
        text: `Hola ${firstName || ""},\n\nPara restablecer tu contraseña, abre este enlace (válido durante 30 minutos):\n${resetUrl}\n\nSi no solicitaste este cambio, ignora este correo.`,
        html: `<p>Hola ${escapeHtml(firstName || "usuario")},</p><p>Para restablecer tu contraseña, abre este enlace. Caduca en 30 minutos.</p><p><a href="${resetUrl}">Restablecer contraseña</a></p><p>Si no solicitaste este cambio, ignora este correo.</p>`
    });
}

module.exports = { sendPasswordResetEmail };
