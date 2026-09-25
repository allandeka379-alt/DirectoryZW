import "dotenv/config";
import { loadConfig } from "../config.js";
import { openDb } from "./client.js";
import { migrate } from "./migrate.js";
import { seedReferenceData, seedSampleBusinesses } from "./seed.js";

const config = loadConfig();
const db = await openDb({ databaseUrl: config.databaseUrl, pgliteDir: config.pgliteDir });
await migrate(db);
await seedReferenceData(db);
console.log("Seeded categories and areas.");
if (config.seedSampleData) {
  const n = await seedSampleBusinesses(db);
  console.log(n ? `Seeded ${n} sample businesses.` : "Sample businesses already present.");
}
await db.close();
