import "dotenv/config";
import { loadConfig } from "../config.js";
import { openDb } from "./client.js";
import { migrate } from "./migrate.js";

const config = loadConfig();
const db = await openDb({ databaseUrl: config.databaseUrl, pgliteDir: config.pgliteDir });
const applied = await migrate(db);
console.log(applied.length ? `Applied: ${applied.join(", ")}` : "Database is up to date.");
await db.close();
