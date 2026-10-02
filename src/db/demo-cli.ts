import "dotenv/config";
import { loadConfig } from "../config.js";
import { createLoginLink, signInUrl } from "../web/owner-auth.js";
import { openDb } from "./client.js";
import { clearDemoActivity, seedDemoActivity } from "./demo.js";
import { migrate } from "./migrate.js";
import { seedReferenceData } from "./seed.js";

// Sample activity for trying the dashboards, on the local database only (src/db/demo.ts):
//   npm run db:demo                  replace any earlier sample activity with seven fresh months of it
//   npm run db:demo -- --days 120    a different number of days
//   npm run db:demo -- --clear       remove it
// Stop the server first: the local database takes one process at a time.

const args = process.argv.slice(2);
const config = loadConfig();
if (config.env === "production" || config.databaseUrl) {
  console.error("Sample activity is only for the local database. Unset DATABASE_URL, and don't run it with NODE_ENV=production.");
  process.exit(1);
}

const db = await openDb({ pgliteDir: config.pgliteDir });
try {
  await migrate(db);
  await seedReferenceData(db);
  await clearDemoActivity(db);
  if (args.includes("--clear")) {
    console.log("Removed the sample activity.");
  } else {
    const at = args.indexOf("--days");
    const days = at >= 0 ? Number(args[at + 1]) : 210;
    if (!Number.isInteger(days) || days < 14 || days > 800) throw new Error("--days takes a whole number from 14 to 800");
    const now = new Date();
    const s = await seedDemoActivity(db, now, { days });
    console.log(
      `Added ${days} days of sample activity in ${config.pgliteDir}: ${s.businesses} businesses, ${s.products} products, ` +
        `${s.customers} customers, ${s.requests} requests and ${s.connections} connections.`,
    );
    const token = await createLoginLink(db, s.showcase.ownerContactId, now, 24 * 60);
    console.log(`${s.showcase.name}'s dashboard (the link works once, for 24 hours):`);
    console.log(`  ${signInUrl(config.publicBaseUrl, token)}`);
  }
} finally {
  await db.close();
}
