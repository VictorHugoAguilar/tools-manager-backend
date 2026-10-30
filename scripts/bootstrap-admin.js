require("dotenv").config();

const { getAdminDatabase } = require("../src/config/firebaseAdmin");
const { randomUUID } = require("node:crypto");
const { hashPassword } = require("../src/services/passwordService");
const {
    createProfile,
    initializeAuthData,
    updatePasswordHash,
    updateProfileGuarded
} = require("../src/services/userService");

function readHiddenInput(prompt) {
    if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
        return Promise.reject(new Error("Ejecuta este comando desde una terminal interactiva."));
    }

    return new Promise((resolve, reject) => {
        process.stdout.write(prompt);
        process.stdin.setRawMode(true);
        process.stdin.resume();
        let value = "";

        const finish = (error) => {
            process.stdin.removeListener("data", onData);
            process.stdin.setRawMode(false);
            process.stdin.pause();
            process.stdout.write("\n");
            if (error) reject(error);
            else resolve(value);
        };

        const onData = (chunk) => {
            for (const character of chunk.toString("utf8")) {
                if (character === "\u0003") {
                    finish(new Error("Operación cancelada."));
                    return;
                }
                if (character === "\r" || character === "\n") {
                    finish();
                    return;
                }
                if (character === "\u007f" || character === "\b") {
                    value = value.slice(0, -1);
                    continue;
                }
                value += character;
            }
        };

        process.stdin.on("data", onData);
    });
}

async function main() {
    const [firstName, lastName, rawEmail] = process.argv.slice(2);
    const email = String(rawEmail || "").trim().toLowerCase();
    if (!firstName?.trim() || !lastName?.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        throw new Error("Uso: npm run bootstrap:admin -- <nombre> <apellido> <correo>");
    }

    const password = await readHiddenInput("Contraseña inicial (mín. 10 caracteres, letras y números): ");
    if (password.length < 10 || password.length > 128 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
        throw new Error("La contraseña no cumple los requisitos mínimos.");
    }

    await initializeAuthData();
    const lockRef = getAdminDatabase().ref("authAdminBootstrapLock");
    const lockResult = await lockRef.transaction((current) =>
        current && current.expiresAt > Date.now()
            ? undefined
            : { expiresAt: Date.now() + 5 * 60 * 1000 }
    );
    if (!lockResult.committed) throw new Error("Ya se está creando el administrador inicial.");

    try {
        const profiles = (await getAdminDatabase().ref("authUsers").get()).val() || {};
        const existingEntry = Object.entries(profiles).find(([, profile]) =>
            profile?.email?.trim().toLowerCase() === email
        );
        const activeCustomAdmins = Object.entries(profiles).filter(([, profile]) =>
            profile?.roleId === "admin" && profile.isActive !== false && profile.passwordHash
        );
        const upgradesExistingAdmin = existingEntry &&
            existingEntry[1]?.roleId === "admin" &&
            activeCustomAdmins.length === 1 &&
            activeCustomAdmins[0][0] === existingEntry[0];
        if (activeCustomAdmins.length && !upgradesExistingAdmin) {
            throw new Error("Ya existe un administrador activo; no se ha creado ninguna cuenta.");
        }

        const passwordHash = await hashPassword(password);
        if (existingEntry) {
            const [uid] = existingEntry;
            const updated = await updateProfileGuarded(uid, {
                firstName: firstName.trim(),
                lastName: lastName.trim(),
                roleId: "admin",
                isActive: true
            });
            if (!updated) throw new Error("No se pudo actualizar la cuenta existente.");
            await updatePasswordHash(uid, passwordHash);
        } else {
            await createProfile(
                randomUUID(),
                { firstName, lastName, email, isActive: true },
                "admin",
                passwordHash
            );
        }
        console.log(`Administrador inicial creado: ${email}`);
    } finally {
        await lockRef.remove();
    }
}

main().catch((error) => {
    console.error(error.message || "No se pudo crear el administrador inicial.");
    process.exitCode = 1;
});
