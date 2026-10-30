const { promisify } = require("node:util");
const { randomBytes, scrypt: scryptCallback, timingSafeEqual } = require("node:crypto");

const scrypt = promisify(scryptCallback);
const KEY_LENGTH = 64;
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

async function hashPassword(password) {
    const salt = randomBytes(16);
    const derivedKey = await scrypt(password, salt, KEY_LENGTH, SCRYPT_OPTIONS);
    return `scrypt$16384$8$1$${salt.toString("base64url")}$${derivedKey.toString("base64url")}`;
}

async function verifyPassword(password, storedHash) {
    if (typeof storedHash !== "string") return false;
    const [algorithm, cost, blockSize, parallelization, saltText, hashText] = storedHash.split("$");
    if (algorithm !== "scrypt" || cost !== "16384" || blockSize !== "8" ||
        parallelization !== "1" || !saltText || !hashText) return false;

    const salt = Buffer.from(saltText, "base64url");
    const expected = Buffer.from(hashText, "base64url");
    if (salt.length !== 16 || expected.length !== KEY_LENGTH) return false;

    const actual = await scrypt(password, salt, KEY_LENGTH, SCRYPT_OPTIONS);
    return timingSafeEqual(expected, actual);
}

module.exports = { hashPassword, verifyPassword };
