import type { Guess } from "./classifier.js";
import type { Action } from "./lexicon.js";
import type { KeywordInterpreter } from "./keyword-interpreter.js";
import type { Reading } from "./reading.js";
import { CATEGORY_FAMILY, RULES, SERVICE_CATEGORIES } from "./rules.js";
import type { InterpretContext, RequestInterpretation } from "./types.js";

/**
 * How sure the local engine is:
 * - high: answer without asking anyone
 * - medium: one to three categories fit, but something is uncertain: ask the customer which
 * - low: it didn't recognise what's being asked for
 */
export type Band = "high" | "medium" | "low";

/** At most this many "Did you mean…?" options; more than that isn't a clear choice. */
export const MAX_OPTIONS = 3;

/** The thresholds Phase 3 tunes on labelled real requests (npm run eval -- --tune). */
export interface LocalSettings {
  /** How many unknown words a straight answer may contain, by language. High-scam categories allow none. */
  unknownWords: Record<"en" | "sn" | "nd", number>;
  /** How closely words must match a category's letter patterns for the classifier to suggest it (0 switches it off). */
  classifierMin: number;
}

export const DEFAULT_LOCAL_SETTINGS: LocalSettings = { unknownWords: { en: 1, sn: 0, nd: 0 }, classifierMin: 0.4 };

/** "en:1,sn:0,nd:0" → unknown words allowed per language. */
export function parseUnknownWords(text: string): LocalSettings["unknownWords"] {
  const out = { ...DEFAULT_LOCAL_SETTINGS.unknownWords };
  for (const part of text.split(",").map((p) => p.trim()).filter(Boolean)) {
    const m = part.match(/^(en|sn|nd):(\d)$/);
    if (!m) throw new Error(`LOCAL_UNKNOWN_WORDS should look like "en:1,sn:0,nd:0", not "${text}"`);
    out[m[1] as "en" | "sn" | "nd"] = Number(m[2]);
  }
  return out;
}

export interface LocalAnalysis {
  interpretation: RequestInterpretation;
  reading: Reading;
  band: Band;
  /** Categories that fit, most likely first. */
  candidates: string[];
  /** Content words the engine couldn't account for. */
  unknown: string[];
  /** Why it chose this band: for logs, the team, and Claude's notes. */
  reasons: string[];
  /** For medium: the categories to offer the customer. */
  options: string[];
}

/** Words that look Shona or Ndebele (a verb or noun prefix and a vowel ending): an unknown one may change the meaning. */
const LOOKS_BANTU = /^(?:ku|kwa|ano|vano|ndino|tino|uno|muno|ndiri|ndaka|aka|vaka|ma|chi|zvi|mu|ngi|ama|isi|ukw?)[a-z]{3,}[aeiou]$/;

/**
 * Read a request with the local engine and judge how far to trust it. Greetings, help, "agent",
 * off-topic questions and blocked items are always settled here. A search is answered straight
 * away only when one category fits, the words that decided it are approved (not drafts or
 * spelling guesses), and nearly every word is understood.
 */
export async function analyzeLocally(
  text: string,
  ctx: InterpretContext,
  keywords: KeywordInterpreter,
  settings: LocalSettings = DEFAULT_LOCAL_SETTINGS,
): Promise<LocalAnalysis> {
  const reading = keywords.read(text, ctx);
  const interpretation = keywords.interpret(text, reading, ctx);
  const { candidates, unknown } = reading;
  const result = (band: Band, reasons: string[], options: string[] = []): LocalAnalysis => ({
    interpretation,
    reading,
    band,
    candidates,
    unknown,
    reasons,
    options,
  });

  switch (interpretation.intent) {
    case "blocked":
      return result("high", ["blocked item"]);
    case "greeting":
    case "help":
    case "human":
    case "out_of_scope":
      return result("high", [interpretation.intent]);
    case "unclear":
      return result("low", ["too vague"]);
    case "search":
      break;
  }
  if (!candidates.length) {
    const reason = unknown.length ? `no category words; unknown: ${unknown.join(", ")}` : "no category words";
    // Words the rules don't know may still look like words we know ("elektrishan"): a question, not an answer.
    const actions = reading.words.flatMap((w) => w.senses.flatMap((s) => (s.role === "action" && s.action ? [s.action] : [])));
    const guesses = guessFromShapes(unknown, ctx, settings, actions);
    if (guesses.length) {
      const shown = guesses.map((g) => `${g.category} (like "${g.like}", ${Math.round(g.score * 100)}%)`).join(", ");
      return result("medium", [reason, `guessed from similar words: ${shown}`], guesses.map((g) => g.category));
    }
    return result("low", [reason]);
  }
  if (candidates.length > MAX_OPTIONS) return result("low", [`too many possibilities: ${candidates.join(", ")}`]);
  const categories = candidates.map((c) => ctx.taxonomy.get(c)).filter((c) => c !== undefined);
  if (candidates.length === 1 && categories[0]?.risk === "restricted") return result("high", [`restricted category ${candidates[0]}`]);

  const doubts: string[] = [];
  if (candidates.length > 1) doubts.push(`several categories fit: ${candidates.join(", ")}`);
  if (reading.decidedBy === "context") doubts.push("only a general word, brand or occasion says what's wanted");
  doubts.push(...reading.doubts);
  if (reading.unusedActions.length && !candidates.every((c) => SERVICE_CATEGORIES.has(c))) {
    doubts.push(`"${reading.unusedActions.join('", "')}" doesn't fit what's asked for`);
  }
  // Unknown Shona or Ndebele words may change the meaning, and high-scam categories need certainty,
  // so there no unknown word is allowed. Elsewhere one is (a brand, a size) unless it looks Shona.
  const allowed = categories.some((c) => c.risk === "high_scam") ? 0 : settings.unknownWords[reading.language === "sn" || reading.language === "nd" ? reading.language : "en"];
  if (unknown.length > allowed) doubts.push(`unknown words: ${unknown.join(", ")}`);
  else if (unknown.some((w) => LOOKS_BANTU.test(w))) doubts.push(`"${unknown.join(", ")}" may be a Shona or Ndebele word`);

  if (!doubts.length) return result("high", reading.notes);
  // Mostly words nobody knows: offering buttons would be a guess.
  const known = reading.words.filter((w) => w.kind === "meaning").length;
  if (unknown.length >= 3 && unknown.length > known) return result("low", [...reading.notes, ...doubts]);
  return result("medium", [...reading.notes, ...doubts], candidates);
}

/**
 * The classifier's suggestions for words the rules didn't know: over the settings' bar, and a
 * second or third only when it's nearly as close as the first.
 */
function guessFromShapes(unknown: string[], ctx: InterpretContext, settings: LocalSettings, actions: Action[]): Guess[] {
  if (!ctx.classifier || !settings.classifierMin || !unknown.length || unknown.length > 6) return [];
  const guesses = ctx.classifier.guess(unknown);
  const top = guesses[0]?.score ?? 0;
  const out: Guess[] = [];
  for (const g of guesses.filter((x) => x.score >= settings.classifierMin && x.score >= top - 0.15)) {
    // The action rules apply to a guessed word too: "fridj repair" is appliance repairs.
    const family = CATEGORY_FAMILY[g.category];
    const ruled = family ? actions.map((a) => RULES[a][family]).find(Boolean) : undefined;
    const category = ruled ?? g.category;
    if (!out.some((o) => o.category === category)) out.push({ ...g, category });
  }
  return out.slice(0, MAX_OPTIONS);
}
