const test = require("node:test");
const assert = require("node:assert/strict");
const { sendPasswordResetEmail } = require("../../src/services/emailService");

test("password reset email requires a complete SMTP configuration", async () => {
    const keys = ["FRONTEND_URL", "SMTP_HOST", "SMTP_PORT", "SMTP_FROM", "SMTP_USER", "SMTP_PASSWORD"];
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    process.env.FRONTEND_URL = "http://localhost:4200";
    process.env.SMTP_HOST = "smtp.example.test";
    process.env.SMTP_PORT = "587";
    process.env.SMTP_FROM = "support@example.test";
    process.env.SMTP_USER = "smtp-user";
    delete process.env.SMTP_PASSWORD;

    try {
        await assert.rejects(
            sendPasswordResetEmail("user@example.test", "User", "http://localhost/reset#token=x"),
            { statusCode: 503 }
        );
    } finally {
        for (const key of keys) {
            if (previous[key] === undefined) delete process.env[key];
            else process.env[key] = previous[key];
        }
    }
});
