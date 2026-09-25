import type { KeywordInterpreter } from "./keyword-interpreter.js";
import type { Reading } from "./reading.js";
import { SERVICE_CATEGORIES } from "./rules.js";
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
export async function analyzeLocally(text: string, ctx: InterpretContext, keywords: KeywordInterpreter): Promise<LocalAnalysis> {
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
  if (!candidates.length) return result("low", [unknown.length ? `no category words; unknown: ${unknown.join(", ")}` : "no category words"]);
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
  const strict = reading.language !== "en" || categories.some((c) => c.risk === "high_scam");
  if (unknown.length > (strict ? 0 : 1)) doubts.push(`unknown words: ${unknown.join(", ")}`);
  else if (unknown.some((w) => LOOKS_BANTU.test(w))) doubts.push(`"${unknown.join(", ")}" may be a Shona or Ndebele word`);

  if (!doubts.length) return result("high", reading.notes);
  // Mostly words nobody knows: offering buttons would be a guess.
  const known = reading.words.filter((w) => w.kind === "meaning").length;
  if (unknown.length >= 3 && unknown.length > known) return result("low", [...reading.notes, ...doubts]);
  return result("medium", [...reading.notes, ...doubts], candidates);
}
