require("dotenv").config();

const { ref, set } = require("firebase/database");
const { connectToDatabase } = require("../src/config/database");
const { readToolsFromFile } = require("../src/storage/toolStorage");

async function migrateToolsToFirebase() {
  const database = await connectToDatabase();
  const tools = readToolsFromFile();

  const toolsById = tools.reduce((accumulator, tool) => {
    const toolId = tool.id;

    if (!toolId || typeof toolId !== "string") {
      return accumulator;
    }

    accumulator[toolId] = tool;
    return accumulator;
  }, {});

  await set(ref(database, "tools"), toolsById);

  console.log(
    `Migration completed. ${Object.keys(toolsById).length} tools uploaded to Firebase.`
  );
}

migrateToolsToFirebase().catch((error) => {
  console.error("Migration failed", error);
  process.exit(1);
});