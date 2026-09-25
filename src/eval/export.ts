import "dotenv/config";
import fs from "node:fs";
import { parseArgs } from "node:util";
import { loadConfig } from "../config.js";
import { openDb } from "../db/client.js";
import { realExamples } from "./examples.js";

const USAGE = `Export real customer requests for the eval.

  npm run eval:export -- --out evals/real.jsonl --labelled          the ones the team labelled (ops console: Label requests)
  npm run eval:export -- --out evals/real.jsonl [--days 30] [--limit 300]   a random sample, labelled with what the app decided

Labelled requests are exported as reviewed. Others carry what the app understood at the time:
check each, correct the mistakes, then set "reviewed": true (npm run eval skips unreviewed lines).
The file holds customer messages: keep it private (evals/real*.jsonl is git-ignored) and delete
it when you're done.`;

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    out: { type: "string" },
    days: { type: "string", default: "30" },
    limit: { type: "string", default: "300" },
    labelled: { type: "boolean", default: false },
  },
});
if (!values.out) {
  console.log(USAGE);
  process.exit(1);
}

const config = loadConfig();
const db = await openDb({ databaseUrl: config.databaseUrl, pgliteDir: config.pgliteDir });
try {
  const lines = await realExamples(db, { labelled: values.labelled, days: Number(values.days), limit: Number(values.limit) });
  fs.writeFileSync(values.out, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const labelled = lines.filter((l) => l.reviewed).length;
  console.log(
    `Wrote ${lines.length} requests to ${values.out} (${labelled} labelled by the team).` +
      (labelled < lines.length ? ' Review the other labels, then set "reviewed": true.' : ""),
  );
} finally {
  await db.close();
}
