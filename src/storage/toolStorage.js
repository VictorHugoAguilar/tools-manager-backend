const fs = require("fs");
const path = require("path");

const dataDirectory = path.join(__dirname, "..", "..", "data");
const dataFilePath = path.join(dataDirectory, "tools.json");

function ensureDataFile() {
    if (!fs.existsSync(dataDirectory)) {
        fs.mkdirSync(dataDirectory, { recursive: true });
    }

    if (!fs.existsSync(dataFilePath)) {
        fs.writeFileSync(dataFilePath, "[]", "utf8");
    }
}

function readToolsFromFile() {
    ensureDataFile();

    const rawData = fs.readFileSync(dataFilePath, "utf8");
    return JSON.parse(rawData);
}

function writeToolsToFile(tools) {
    ensureDataFile();
    fs.writeFileSync(dataFilePath, JSON.stringify(tools, null, 2), "utf8");
}

module.exports = {
    readToolsFromFile,
    writeToolsToFile
};