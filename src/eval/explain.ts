import { parseArgs } from "node:util";
import { KeywordInterpreter } from "../ai/keyword-interpreter.js";
import { Lexicon } from "../ai/lexicon.js";
import { analyzeLocally } from "../ai/local.js";
import { signatureOf } from "../ai/reading.js";
import { openDb } from "../db/client.js";
import { migrate } from "../db/migrate.js";
import { seedReferenceData } from "../db/seed.js";
import { Gazetteer } from "../directory/gazetteer.js";
import { Taxonomy } from "../directory/taxonomy.js";

const USAGE = `Show how the local engine reads a request, word by word (with the seed word list).

  npm run explain -- "ndoda keke remuchato ku Budiriro"
  npm run explain -- --trust-drafts "ndirikutsvaga munhu anogadzira fridge"   as if the Shona words were approved`;

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: { "trust-drafts": { type: "boolean", default: false }, help: { type: "boolean", default: false } },
  allowPositionals: true,
});
if (values.help || !positionals.length) {
  console.log(USAGE);
  process.exit(0);
}

const db = await openDb({});
await migrate(db);
await seedReferenceData(db);
const [taxonomy, gazetteer] = await Promise.all([Taxonomy.load(db), Gazetteer.load(db)]);
const ctx = { taxonomy, gazetteer, lexicon: await Lexicon.load(db, taxonomy, { trustDrafts: values["trust-drafts"] }) };
const keywords = new KeywordInterpreter();

for (const text of positionals) {
  const a = await analyzeLocally(text, ctx, keywords);
  const r = a.reading;
  console.log(`\n"${text}"`);
  for (const w of r.words) {
    const senses = w.senses
      .filter((s) => s.role !== "filler")
      .map((s) => `${s.role}${s.categories.length ? ` → ${s.categories.join("/")}` : ""}${s.action ? ` (${s.action})` : ""}${s.trusted ? "" : ", draft"}`);
    const how = w.via && w.via !== "exact" ? ` [${w.via}${w.key !== w.text ? `: ${w.key}` : ""}]` : "";
    console.log(`  ${w.text.padEnd(18)} ${w.kind}${how}${senses.length ? `: ${senses.join("; ")}` : ""}`);
  }
  console.log(`  → ${a.band}: ${a.candidates.join(", ") || "no category"}${r.area ? `, near ${r.area.name}` : ""} (${r.language})`);
  for (const reason of a.reasons) console.log(`    ${reason}`);
  if (a.options.length) console.log(`    would ask: did you mean ${a.options.join(" / ")}?`);
  console.log(`    phrasebook key: ${signatureOf(r) ?? "none"}`);
}
await db.close();
