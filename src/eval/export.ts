import "dotenv/config";
import fs from "node:fs";
import { parseArgs } from "node:util";
import { loadConfig } from "../config.js";
import { openDb } from "../db/client.js";
import type { EvalExample } from "./score.js";

const USAGE = `Export a sample of real customer requests for labelling.

  npm run eval:export -- --out evals/real.jsonl [--days 30] [--limit 300]

Each line is labelled with what the app understood at the time. Check every label, correct the
mistakes, then set "reviewed": true. npm run eval skips unreviewed lines. The file holds customer
messages: keep it private (evals/real*.jsonl is git-ignored) and delete it when you're done.`;

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    out: { type: "string" },
    days: { type: "string", default: "30" },
    limit: { type: "string", default: "300" },
  },
});
if (!values.out) {
  console.log(USAGE);
  process.exit(1);
}

const config = loadConfig();
const db = await openDb({ databaseUrl: config.databaseUrl, pgliteDir: config.pgliteDir });
try {
  const rows = await db.query<{ id: string; raw_text: string; interpretation: { intent?: string; language?: string }; category_slug: string | null; area: string | null }>(
    `SELECT r.id, r.raw_text, r.interpretation, r.category_slug, a.name AS area
       FROM requests r LEFT JOIN areas a ON a.id = r.area_id
      WHERE r.created_at > now() - make_interval(days => $1) AND r.raw_text <> '' AND left(r.raw_text, 1) <> '📷'
      ORDER BY random() LIMIT $2`,
    [Number(values.days), Number(values.limit)],
  );
  const lines = rows.map((r): EvalExample => ({
    id: `real-${r.id.slice(0, 8)}`,
    text: r.raw_text,
    language: r.interpretation.language ?? "en",
    expect: { intent: r.interpretation.intent ?? "search", category: r.category_slug, ...(r.area ? { area: r.area } : {}) },
    source: "real",
    reviewed: false,
  }));
  fs.writeFileSync(values.out, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  console.log(`Wrote ${lines.length} requests to ${values.out}. Review each label, then set "reviewed": true.`);
} finally {
  await db.close();
}
