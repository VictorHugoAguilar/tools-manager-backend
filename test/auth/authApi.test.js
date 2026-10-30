const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp } = require("../../src/app");

async function withServer(run) {
    const server = createApp().listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    const address = server.address();
    try {
        await run(`http://127.0.0.1:${address.port}`);
    } finally {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
}

test("existing application APIs and admin APIs require a session", async () => {
    await withServer(async (baseUrl) => {
        const [inventoryResponse, adminResponse, csrfResponse] = await Promise.all([
            fetch(`${baseUrl}/api/tools`),
            fetch(`${baseUrl}/api/admin/users`),
            fetch(`${baseUrl}/api/auth/csrf`)
        ]);
        assert.equal(inventoryResponse.status, 401);
        assert.equal(adminResponse.status, 401);
        assert.equal(csrfResponse.status, 401);
    });
});

test("registration is disabled unless explicitly enabled", async () => {
    const previous = process.env.PUBLIC_REGISTRATION_ENABLED;
    process.env.PUBLIC_REGISTRATION_ENABLED = "false";
    try {
        await withServer(async (baseUrl) => {
            const response = await fetch(`${baseUrl}/api/auth/register`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    firstName: "Ada",
                    lastName: "Lovelace",
                    email: "ada@example.com",
                    password: "Workshop1234"
                })
            });
            assert.equal(response.status, 403);
        });
    } finally {
        if (previous === undefined) delete process.env.PUBLIC_REGISTRATION_ENABLED;
        else process.env.PUBLIC_REGISTRATION_ENABLED = previous;
    }
});

test("login validates malformed input before accessing the database", async () => {
    await withServer(async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/auth/login`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ email: "not-an-email", password: "" })
        });
        assert.equal(response.status, 400);
    });
});

test("password reset validates email before accessing the database", async () => {
    await withServer(async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/auth/password-reset`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ email: "not-an-email" })
        });
        assert.equal(response.status, 400);
    });
});

test("password reset rejects malformed one-time tokens", async () => {
    await withServer(async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/auth/password-reset/complete`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ token: "short", password: "Workshop1234" })
        });
        assert.equal(response.status, 400);
        assert.match((await response.json()).message, /enlace de recuperación/);
    });
});
