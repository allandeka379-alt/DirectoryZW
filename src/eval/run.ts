import "dotenv/config";
import fs from "node:fs";
import { parseArgs } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import type { UsageMeter } from "../ai/budget.js";
import { ClaudeInterpreter } from "../ai/claude-interpreter.js";
import { KeywordInterpreter } from "../ai/keyword-interpreter.js";
import { trainClassifier } from "../ai/learning.js";
import { Lexicon } from "../ai/lexicon.js";
import { analyzeLocally, type LocalAnalysis, type LocalSettings } from "../ai/local.js";
import { costOf } from "../ai/pricing.js";
import type { InterpretContext, RequestInterpretation } from "../ai/types.js";
import { loadConfig } from "../config.js";
import { openDb } from "../db/client.js";
import { migrate } from "../db/migrate.js";
import { seedReferenceData } from "../db/seed.js";
import { Gazetteer } from "../directory/gazetteer.js";
import { Taxonomy } from "../directory/taxonomy.js";
import { silentLogger } from "../logger.js";
import { judge, parseExamples, score, scoreByLanguage, type EvalExample, type Outcome, type Score } from "./score.js";

const USAGE = `Measure how well requests are understood, against labelled examples.

  npm run eval                                   the local engine only (free)
  npm run eval -- --file evals/real.jsonl        the team's labelled real requests (npm run eval:export -- --labelled)
  npm run eval -- --tune                         the thresholds that answer most requests locally, 98% of them right
  npm run eval -- --claude                       also Claude (CLAUDE_MODEL), on the requests the local engine passes on
  npm run eval -- --claude --model claude-sonnet-5,claude-haiku-4-5   compare models: accuracy, and cost per 100 requests
  npm run eval -- --claude --all                 Claude on every example, not only the ones passed on
  npm run eval -- --trust-drafts                 as if native speakers had approved the draft Shona and Ndebele words
  npm run eval -- --no-classifier                without the word-shape classifier's guesses
  npm run eval -- --verbose                      list every miss, not just the first 25

The thresholds come from LOCAL_UNKNOWN_WORDS and LOCAL_CLASSIFIER_MIN, as in the app.`;

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    file: { type: "string", default: "evals/requests.jsonl" },
    claude: { type: "boolean", default: false },
    model: { type: "string" },
    all: { type: "boolean", default: false },
    tune: { type: "boolean", default: false },
    "include-unreviewed": { type: "boolean", default: false },
    "trust-drafts": { type: "boolean", default: false },
    "no-classifier": { type: "boolean", default: false },
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

// Reference data only: categories, places and the seed lexicon, in a throwaway database. The
// classifier learns from those alone here; in the app it also learns from the phrasebook and labels.
const db = await openDb({});
await migrate(db);
await seedReferenceData(db);
const [taxonomy, gazetteer] = await Promise.all([Taxonomy.load(db), Gazetteer.load(db)]);
const lexicon = await Lexicon.load(db, taxonomy, { trustDrafts: values["trust-drafts"] });
const classifier = values["no-classifier"] ? undefined : await trainClassifier({ taxonomy, lexicon, gazetteer });
const local: InterpretContext = { taxonomy, gazetteer, lexicon, classifier };
const settings: LocalSettings = { ...config.local, classifierMin: values["no-classifier"] ? 0 : config.local.classifierMin };
const keywords = new KeywordInterpreter();

const pct = (v: number | null) => (v == null ? "   -" : `${Math.round(v * 100)}%`.padStart(4));
const share = (n: number, of: number) => `${Math.round((100 * n) / (of || 1))}%`;
const line = (label: string, s: Score) =>
  `${label.padEnd(22)} ${String(s.n).padStart(4)}  intent ${pct(s.intent)}  category ${pct(s.category)}  area ${pct(s.area)}  ${Math.round(s.avgMs)} ms${s.errors ? `  errors ${s.errors}` : ""}`;
const right = (o: Outcome) => o.intent && o.category !== false && o.area !== false;

/** Judge an answer the way the chat would use it: the interpreter's area, else a place named in the text. */
function outcome(example: EvalExample, i: RequestInterpretation | null, ms: number): Outcome {
  if (!i) return judge(example, null, ms, "no answer (refused or failed)");
  const area = (i.area && gazetteer.match(i.area)) || gazetteer.match(example.text);
  return judge(example, { intent: i.intent, category: i.category_slug, area: area?.name ?? null }, ms);
}

async function analyseAll(s: LocalSettings): Promise<Map<string, LocalAnalysis>> {
  const out = new Map<string, LocalAnalysis>();
  for (const e of examples) out.set(e.id, await analyzeLocally(e.text, local, keywords, s));
  return out;
}

function printScores(name: string, outcomes: Outcome[]): void {
  console.log(`\n${name}`);
  console.log(line("all", score(outcomes)));
  for (const [lang, s] of Object.entries(scoreByLanguage(outcomes))) console.log(line(`  ${lang}`, s));
  const misses = outcomes.filter((o) => !right(o));
  for (const o of misses.slice(0, values.verbose ? misses.length : 25)) {
    const want = o.example.expect;
    const got = o.error ? o.error : `${o.got?.intent} / ${o.got?.category ?? "-"} / ${o.got?.area ?? "-"}`;
    console.log(`  ✗ ${o.example.id} "${o.example.text}"\n      want ${want.intent} / ${want.category ?? "-"} / ${want.area ?? "-"}, got ${got}`);
  }
  if (!values.verbose && misses.length > 25) console.log(`  …and ${misses.length - 25} more (--verbose)`);
}

// ---------- The local engine ----------

const started = performance.now();
const analyses = await analyseAll(settings);
const perExampleMs = (performance.now() - started) / (examples.length || 1);
const localOutcomes = examples.map((e) => outcome(e, analyses.get(e.id)!.interpretation, perExampleMs));
printScores(`local engine${classifier ? `, with the classifier (${classifier.size} categories learnt)` : ""}`, localOutcomes);

// What the ladder does with each request before any phrasebook entries exist: answer it locally,
// ask "Did you mean…?", or pass it to Claude or a person.
const offered = (o: Outcome, a: LocalAnalysis) => {
  const want = o.example.expect.category;
  return want === undefined || want === null || a.options.includes(want);
};
function ladder(list: Outcome[], byId: Map<string, LocalAnalysis>): string {
  const band = (b: string) => list.filter((o) => byId.get(o.example.id)!.band === b);
  const [high, medium, low] = [band("high"), band("medium"), band("low")];
  return (
    `answered ${high.length} (${share(high.length, list.length)}, right ${high.filter(right).length}) · ` +
    `asked ${medium.length} (${share(medium.length, list.length)}, right option offered ${medium.filter((o) => offered(o, byId.get(o.example.id)!)).length}) · ` +
    `to Claude or a person ${low.length} (${share(low.length, list.length)})`
  );
}
console.log(`\n  How the ladder handles them${values["trust-drafts"] ? " (draft Shona and Ndebele words treated as approved)" : " (draft Shona and Ndebele words not yet approved)"}:`);
console.log(`  ${"all".padEnd(4)} ${ladder(localOutcomes, analyses)}`);
for (const lang of [...new Set(localOutcomes.map((o) => o.example.language))].sort()) {
  console.log(`  ${lang.padEnd(4)} ${ladder(localOutcomes.filter((o) => o.example.language === lang), analyses)}`);
}
for (const o of localOutcomes) {
  const a = analyses.get(o.example.id)!;
  if (a.band === "high" && !right(o)) console.log(`  ! confident but wrong: ${o.example.id} "${o.example.text}"`);
  if (a.band === "medium" && !offered(o, a)) console.log(`  ? asked without the right option: ${o.example.id} "${o.example.text}" (offered ${a.options.join(", ")})`);
}

// ---------- Tuning the thresholds ----------

if (values.tune) {
  console.log("\nTuning: how many unknown words a straight answer may have, by language (aim: 98% of straight answers right)");
  const suggested = { ...settings.unknownWords };
  for (const lang of ["en", "sn", "nd"] as const) {
    const ofLang = examples.filter((e) => e.language === lang);
    if (!ofLang.length) continue;
    let best: { n: number; answered: number } | undefined;
    for (let n = 0; n <= 3; n++) {
      const tried = await analyseAll({ ...settings, unknownWords: { ...settings.unknownWords, [lang]: n } });
      const high = ofLang.filter((e) => tried.get(e.id)!.band === "high");
      const good = high.filter((e) => right(outcome(e, tried.get(e.id)!.interpretation, 0))).length;
      const precision = high.length ? good / high.length : 1;
      console.log(`  ${lang} ${n}: answered ${high.length} of ${ofLang.length} (${share(high.length, ofLang.length)}), right ${good} (${share(good, high.length)})`);
      if (precision >= 0.98 && (!best || high.length > best.answered)) best = { n, answered: high.length };
    }
    if (best) suggested[lang] = best.n;
    if (ofLang.length < 100) console.log(`     only ${ofLang.length} ${lang} examples: label more real requests before relying on this`);
  }
  console.log(`  Suggested: LOCAL_UNKNOWN_WORDS=en:${suggested.en},sn:${suggested.sn},nd:${suggested.nd} (now en:${settings.unknownWords.en},sn:${settings.unknownWords.sn},nd:${settings.unknownWords.nd})`);

  if (classifier) {
    console.log("\nThe classifier's bar: requests with no category words, where it may offer options instead of passing them on");
    const noCategory = examples.filter((e) => !analyses.get(e.id)!.candidates.length && analyses.get(e.id)!.interpretation.intent === "search");
    for (const min of [0.3, 0.4, 0.5, 0.6]) {
      const tried = await analyseAll({ ...settings, classifierMin: min });
      const asked = noCategory.filter((e) => tried.get(e.id)!.band === "medium");
      const hit = asked.filter((e) => e.expect.category && tried.get(e.id)!.options.includes(e.expect.category)).length;
      console.log(`  ${min.toFixed(1)}: asked ${asked.length} of ${noCategory.length}, the right option among them ${hit}, a wrong guess ${asked.length - hit}`);
    }
    console.log(`  Now LOCAL_CLASSIFIER_MIN=${settings.classifierMin}. Higher asks less often and more accurately; 0 switches the classifier off.`);
  }
}

// ---------- Claude, on what the local engine passes on ----------

if (values.claude) {
  if (!config.anthropicApiKey) throw new Error("Set ANTHROPIC_API_KEY to evaluate Claude");
  const client = new Anthropic({ apiKey: config.anthropicApiKey });
  const models = (values.model ?? config.claudeModel).split(",").map((m) => m.trim()).filter(Boolean);
  // In the app Claude only sees what the local engine doesn't answer (and "Something else" after a question).
  const subset = values.all ? examples : examples.filter((e) => analyses.get(e.id)!.band !== "high");
  console.log(`\nClaude on ${subset.length} of ${examples.length} examples${values.all ? "" : " (the ones the local engine doesn't answer on its own)"}: ${subset.length * models.length} API calls.`);
  for (const model of models) {
    const spend = { usd: 0, calls: 0 };
    const meter: UsageMeter = {
      record: async (_feature, m, usage, _contact, opts) => {
        spend.usd += costOf(m, usage, opts);
        spend.calls++;
      },
    };
    const claude = new ClaudeInterpreter({ client, model, brand: config.brandName, log: silentLogger, meter });
    const outcomes: Outcome[] = [];
    let next = 0;
    const worker = async () => {
      while (next < subset.length) {
        const example = subset[next++]!;
        const t0 = performance.now();
        const notes = analyses.get(example.id)!.reasons.slice(0, 3);
        outcomes.push(outcome(example, await claude.interpretRequest(example.text, { taxonomy, gazetteer, notes }), performance.now() - t0));
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
    outcomes.sort((a, b) => a.example.id.localeCompare(b.example.id));
    printScores(model, outcomes);
    const perCall = spend.calls ? spend.usd / spend.calls : 0;
    const per100 = perCall * (subset.length / (examples.length || 1)) * 100;
    console.log(
      `  cost: $${spend.usd.toFixed(4)} for ${spend.calls} calls, $${perCall.toFixed(5)} a call;` +
        ` about $${per100.toFixed(3)} per 100 customer requests at this share passed on`,
    );
  }
}
await db.close();
