const { statfs } = require("node:fs/promises");

const MAX_SAMPLE_AGE_MS = 120000;

class ResourceSampler {
    constructor({ intervalMs = 30000, cpuUsage = () => process.cpuUsage(),
        memoryUsage = () => process.memoryUsage.rss(), monotonicNow = () => process.hrtime.bigint(),
        now = () => Date.now(), readDisk = () => statfs("/") } = {}) {
        this.intervalMs = intervalMs;
        this.cpuUsage = cpuUsage;
        this.memoryUsage = memoryUsage;
        this.monotonicNow = monotonicNow;
        this.now = now;
        this.readDisk = readDisk;
        this.previous = null;
        this.processSample = null;
        this.diskSample = null;
        this.diskInFlight = false;
        this.diskFailures = 0;
        this.generation = 0;
        this.timer = null;
    }

    start() {
        if (this.timer) return;
        this.sample();
        this.timer = setInterval(() => this.sample(), this.intervalMs);
        this.timer.unref();
    }

    stop() {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        this.previous = null;
        this.processSample = null;
        this.diskSample = null;
        this.generation += 1;
    }

    sample() {
        try {
            const cpu = this.cpuUsage();
            const time = this.monotonicNow();
            const rssBytes = this.memoryUsage();
            if (!Number.isSafeInteger(cpu.user) || !Number.isSafeInteger(cpu.system) ||
                cpu.user < 0 || cpu.system < 0 || typeof time !== "bigint" ||
                !Number.isSafeInteger(rssBytes) || rssBytes < 0) {
                throw new Error("Muestra de recursos del proceso no válida.");
            }
            let cpuPercent = null;
            if (this.previous) {
                const elapsedMicros = Number(time - this.previous.time) / 1000;
                const cpuMicros = cpu.user + cpu.system - this.previous.cpu.user - this.previous.cpu.system;
                const percent = 100 * cpuMicros / elapsedMicros;
                if (elapsedMicros > 0 && cpuMicros >= 0 && Number.isFinite(percent)) cpuPercent = percent;
            }
            this.previous = { cpu, time };
            this.processSample = { sampledAt: this.now(), cpuPercent, rssBytes };
        } catch (error) {
            this.previous = null;
            this.processSample = null;
            console.error("No se pudieron medir los recursos del proceso.", error);
        }

        if (this.diskInFlight) return;
        this.diskInFlight = true;
        const generation = this.generation;
        Promise.resolve().then(() => this.readDisk()).then((disk) => {
            if (generation !== this.generation) return;
            const totalBytes = disk.blocks * disk.bsize;
            const freeBytes = disk.bfree * disk.bsize;
            const availableBytes = disk.bavail * disk.bsize;
            if (![totalBytes, freeBytes, availableBytes].every(Number.isSafeInteger) ||
                totalBytes <= 0 || freeBytes < 0 || freeBytes > totalBytes ||
                availableBytes < 0 || availableBytes > freeBytes) {
                throw new Error("Muestra del sistema de archivos no válida.");
            }
            this.diskSample = { sampledAt: this.now(), totalBytes, usedBytes: totalBytes - freeBytes, availableBytes };
            this.diskFailures = 0;
        }).catch((error) => {
            if (generation !== this.generation) return;
            this.diskSample = null;
            this.diskFailures += 1;
            if (this.diskFailures === 1 || this.diskFailures % 60 === 0) {
                console.error("No se pudo medir el sistema de archivos de /.", error);
            }
        }).finally(() => { this.diskInFlight = false; });
    }

    snapshot() {
        const now = this.now();
        const fresh = (sample) => sample && now >= sample.sampledAt && now - sample.sampledAt <= MAX_SAMPLE_AGE_MS;
        return {
            process: fresh(this.processSample) ? this.processSample : null,
            disk: fresh(this.diskSample) ? this.diskSample : null
        };
    }
}

module.exports = { ResourceSampler, MAX_SAMPLE_AGE_MS };
