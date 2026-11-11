const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { loadModuleWithMocks } = require("../helpers/loadModuleWithMocks");
const { transactAdminUser } = require("../../src/audit/businessOutbox");

const token = "private-reset-token";
const tokenHash = createHash("sha256").update(token).digest("hex");

function harness() {
    let root = {
        authUsers: { user: { passwordHash: "old-hash", sessionVersion: 4 } },
        authPasswordResets: { [tokenHash]: { uid: "user", expiresAt: Date.now() + 60000, sessionVersion: 4 } },
        unrelated: { keep: true }
    };
    let retry;
    let fail = false;
    const database = {
        ref(pathname) {
            if (!pathname) return { transaction: async (change) => {
                if (fail) throw new Error("database offline");
                let next = change(structuredClone(root));
                if (retry) {
                    retry(root);
                    retry = null;
                    next = change(structuredClone(root));
                }
                if (next === undefined) return { committed: false };
                root = next;
                return { committed: true };
            } };
            assert.equal(pathname, "authPasswordResets");
            return { child: (key) => ({ get: async () => ({ val: () => structuredClone(root.authPasswordResets[key] || null) }) }) };
        }
    };
    const service = loadModuleWithMocks(path.resolve(__dirname, "../../src/services/authSessionService.js"), {
        "../config/firebaseAdmin": { getAdminDatabase: () => database },
        "../audit/businessOutbox": { transactAdminUser: (args) => transactAdminUser({ ...args, database }) }
    });
    return {
        service, get root() { return root; },
        retryWith(fn) { retry = fn; }, fail(value) { fail = value; }
    };
}

test("recovery consumes token, changes password and appends sanitized audit atomically", async () => {
    const h = harness();
    assert.equal(await h.service.completeAuditedPasswordReset(token, "new-hash"), true);
    assert.equal(h.root.authPasswordResets[tokenHash], undefined);
    assert.equal(h.root.authUsers.user.passwordHash, "new-hash");
    assert.equal(h.root.authUsers.user.sessionVersion, 5);
    assert.deepEqual(h.root.unrelated, { keep: true });
    const [event] = Object.values(h.root.auditOutbox);
    assert.equal(event.action, "user.password.recovered");
    assert.equal(event.actorId, "user");
    assert.equal(event.targetId, "user");
    assert.doesNotMatch(JSON.stringify(event), /private-reset-token|new-hash|old-hash/);
    assert.equal(await h.service.completeAuditedPasswordReset(token, "another"), null);
});

test("concurrent token use or session changes reject recovery without an audit", async () => {
    for (const change of [
        (root) => { delete root.authPasswordResets[tokenHash]; },
        (root) => { root.authUsers.user.sessionVersion++; },
        (root) => { root.authPasswordResets[tokenHash].expiresAt = Date.now() - 1; },
        (root) => { root.authPasswordResets[tokenHash].uid = "other"; }
    ]) {
        const h = harness();
        h.retryWith(change);
        assert.equal(await h.service.completeAuditedPasswordReset(token, "new-hash"), null);
        assert.equal(h.root.authUsers.user.passwordHash, "old-hash");
        assert.equal(h.root.auditOutbox, undefined);
    }
});

test("invalid recovery token or database failure does not consume the token", async () => {
    const h = harness();
    assert.equal(await h.service.completeAuditedPasswordReset("missing", "new-hash"), null);
    h.fail(true);
    await assert.rejects(h.service.completeAuditedPasswordReset(token, "new-hash"), /offline/);
    assert.ok(h.root.authPasswordResets[tokenHash]);
    assert.equal(h.root.authUsers.user.passwordHash, "old-hash");
    assert.equal(h.root.auditOutbox, undefined);
});

test("audited recovery controller uses atomic path and never consumes token separately", async () => {
    let received;
    const { controller } = loadModuleWithMocks(path.resolve(__dirname, "../../src/controllers/authController.js"), {
        "../audit/businessOutbox": { isRecoveryAuditEnabled: () => true },
        "../services/authSessionService": {
            completeAuditedPasswordReset: async (...args) => { received = args; return true; },
            consumePasswordReset: () => assert.fail("must not consume separately")
        },
        "../services/passwordService": { hashPassword: async () => "hashed" }
    });
    let payload;
    const request = { body: { token: "t".repeat(32), password: "Workshop1234" } };
    await controller.completePasswordReset[1](request, { json(value) { payload = value; } }, assert.fail);
    assert.deepEqual(received, ["t".repeat(32), "hashed"]);
    assert.match(payload.message, /contraseña se ha actualizado/);
});
