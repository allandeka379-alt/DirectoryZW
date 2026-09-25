import "dotenv/config";
import fs from "node:fs";
import { parseArgs } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import { ClaudeInterpreter } from "../ai/claude-interpreter.js";
import { KeywordInterpreter } from "../ai/keyword-interpreter.js";
import { analyzeLocally } from "../ai/local.js";
import type { RequestInterpretation } from "../ai/types.js";
import { loadConfig } from "../config.js";
import { openDb } from "../db/client.js";
import { migrate } from "../db/migrate.js";
import { seedReferenceData } from "../db/seed.js";
import { Gazetteer } from "../directory/gazetteer.js";
import { Taxonomy } from "../directory/taxonomy.js";
import { silentLogger } from "../logger.js";
import { judge, parseExamples, score, scoreByLanguage, type Outcome, type Score } from "./score.js";

const USAGE = `Measure how well requests are understood, against labelled examples.

  npm run eval                                   the local engine only (free)
  npm run eval -- --claude                       also Claude (CLAUDE_MODEL); costs a little per example
  npm run eval -- --claude --model claude-haiku-4-5    try a cheaper model
  npm run eval -- --file evals/real.jsonl        your labelled real requests (see npm run eval:export)
  npm run eval -- --verbose                      list every miss, not just the first 25`;

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    file: { type: "string", default: "evals/requests.jsonl" },
    claude: { type: "boolean", default: false },
    model: { type: "string" },
    "include-unreviewed": { type: "boolean", default: false },
    verbose: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});
if (values.help) {
  console.log(USAGE);
  process.exit(0);
}

const config = loadConfig();
const all = parseExamples(fs.readFileSync(values.file, "utf8"));
const examples = all.filter((e) => e.source !== "real" || e.reviewed || values["include-unreviewed"]);
if (examples.length < all.length) {
  console.log(`Skipping ${all.length - examples.length} real requests whose labels haven't been reviewed (see --include-unreviewed).`);
}

// Reference data only: categories and places, in a throwaway database.
const db = await openDb({});
await migrate(db);
await seedReferenceData(db);
const [taxonomy, gazetteer] = await Promise.all([Taxonomy.load(db), Gazetteer.load(db)]);

type Reader = { name: string; read(text: string): Promise<RequestInterpretation | null> };
const keywords = new KeywordInterpreter();
const readers: Reader[] = [{ name: "keyword (local)", read: (text) => keywords.interpretRequest(text, { taxonomy, gazetteer }) }];
if (values.claude) {
  if (!config.anthropicApiKey) throw new Error("Set ANTHROPIC_API_KEY to evaluate Claude");
  const model = values.model ?? config.claudeModel;
  const claude = new ClaudeInterpreter({ client: new Anthropic({ apiKey: config.anthropicApiKey }), model, brand: config.brandName, log: silentLogger });
  readers.push({ name: model, read: (text) => claude.interpretRequest(text, { taxonomy, gazetteer }) });
  console.log(`Evaluating ${model} on ${examples.length} examples. This makes ${examples.length} API calls.`);
}

async function run(reader: Reader): Promise<Outcome[]> {
  const outcomes: Outcome[] = [];
  const concurrency = reader.name.startsWith("keyword") ? 1 : 4;
  let next = 0;
  const worker = async () => {
    while (next < examples.length) {
      const example = examples[next++]!;
      const started = performance.now();
      const i = await reader.read(example.text);
      if (!i) {
        outcomes.push(judge(example, null, performance.now() - started, "no answer (refused or failed)"));
        continue;
      }
      // Resolve the area the way the chat does: the interpreter's area, else a place named in the text.
      const area = (i.area && gazetteer.match(i.area)) || gazetteer.match(example.text);
      outcomes.push(judge(example, { intent: i.intent, category: i.category_slug, area: area?.name ?? null }, performance.now() - started));
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return outcomes.sort((a, b) => a.example.id.localeCompare(b.example.id));
}

const pct = (v: number | null) => (v == null ? "   -" : `${Math.round(v * 100)}%`.padStart(4));
const line = (label: string, s: Score) =>
  `${label.padEnd(22)} ${String(s.n).padStart(4)}  intent ${pct(s.intent)}  category ${pct(s.category)}  area ${pct(s.area)}  ${Math.round(s.avgMs)} ms${s.errors ? `  errors ${s.errors}` : ""}`;
const right = (o: Outcome) => o.intent && o.category !== false && o.area !== false;

for (const reader of readers) {
  const outcomes = await run(reader);
  console.log(`\n${reader.name}`);
  console.log(line("all", score(outcomes)));
  for (const [lang, s] of Object.entries(scoreByLanguage(outcomes))) console.log(line(`  ${lang}`, s));
  const misses = outcomes.filter((o) => !right(o));
  for (const o of misses.slice(0, values.verbose ? misses.length : 25)) {
    const want = o.example.expect;
    const got = o.error ? o.error : `${o.got?.intent} / ${o.got?.category ?? "-"} / ${o.got?.area ?? "-"}`;
    console.log(`  ✗ ${o.example.id} "${o.example.text}"\n      want ${want.intent} / ${want.category ?? "-"} / ${want.area ?? "-"}, got ${got}`);
  }
  if (!values.verbose && misses.length > 25) console.log(`  …and ${misses.length - 25} more (--verbose)`);

  // The local engine's confidence: what it would answer on its own, and how often that answer is right.
  if (reader.name.startsWith("keyword")) {
    const byId = new Map(outcomes.map((o) => [o.example.id, o]));
    const bands = { high: [] as Outcome[], medium: [] as Outcome[], low: [] as Outcome[] };
    for (const e of examples) bands[(await analyzeLocally(e.text, { taxonomy, gazetteer }, keywords)).band].push(byId.get(e.id)!);
    const share = (n: number) => `${Math.round((100 * n) / examples.length)}%`;
    console.log(
      `\n  Answered locally (high confidence): ${bands.high.length} (${share(bands.high.length)}), right ${bands.high.filter(right).length}` +
        `\n  Sent on to the phrasebook or Claude: ${bands.medium.length + bands.low.length} (${share(bands.medium.length + bands.low.length)}),` +
        ` of which the local answer would have been wrong: ${[...bands.medium, ...bands.low].filter((o) => !right(o)).length}`,
    );
    for (const o of bands.high.filter((x) => !right(x))) console.log(`  ! confident but wrong: ${o.example.id} "${o.example.text}"`);
  }
}
await db.close();
