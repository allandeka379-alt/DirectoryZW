import { normalizeText, searchTokens } from "../text.js";
import type { KeywordInterpreter } from "./keyword-interpreter.js";
import type { InterpretContext, RequestInterpretation } from "./types.js";

/**
 * How sure the local engine is:
 * - high: answer without Claude
 * - medium: probably right, but another reading is possible (several categories, unknown words)
 * - low: it didn't recognise what's being asked for
 */
export type Band = "high" | "medium" | "low";

export interface LocalAnalysis {
  interpretation: RequestInterpretation;
  band: Band;
  /** Categories whose words appear in the message. */
  candidates: string[];
  /** Content words the engine couldn't account for. */
  unknown: string[];
  /** Why it chose this band: for logs, the team, and Claude's notes. */
  reasons: string[];
}

/** Words that name a product and a service at once ("paint" the product, or painting a house). */
const AMBIGUOUS_TERMS = new Set(["paint", "gas"]);

/**
 * Read a request with the keyword engine and judge how far to trust it. Greetings, help, "agent",
 * off-topic questions and blocked items are always settled here; a search is trusted only when
 * one category clearly fits and nearly every word is understood.
 */
export async function analyzeLocally(text: string, ctx: InterpretContext, keywords: KeywordInterpreter): Promise<LocalAnalysis> {
  const interpretation = await keywords.interpretRequest(text, ctx);
  const matches = ctx.taxonomy.match(text);
  const candidates = [...new Set(matches.map((m) => m.category.slug))];
  const area = ctx.gazetteer?.match(text);
  const areaWords = new Set(area ? normalizeText([area.name, area.city, ...area.aliases].join(" ")).split(" ") : []);
  const termWords = new Set(matches.flatMap((m) => m.term.split(" ")));
  const known = (w: string) => termWords.has(w) || termWords.has(w.replace(/e?s$/, ""));
  const unknown = searchTokens(text).filter((w) => !areaWords.has(w) && !known(w) && !/^\d+$/.test(w));
  const result = (band: Band, reason: string): LocalAnalysis => ({ interpretation, band, candidates, unknown, reasons: [reason] });

  switch (interpretation.intent) {
    case "blocked":
      return result("high", "blocked item");
    case "greeting":
    case "help":
    case "human":
    case "out_of_scope":
      return result("high", interpretation.intent);
    case "unclear":
      return result("low", "too vague");
    case "search":
      break;
  }
  if (!candidates.length) return result("low", unknown.length ? `no category words; unknown: ${unknown.join(", ")}` : "no category words");
  const category = ctx.taxonomy.get(interpretation.category_slug);
  if (category?.risk === "restricted") return result("high", `restricted category ${category.slug}`);
  if (candidates.length > 1) return result("medium", `several categories: ${candidates.join(", ")}`);
  const term = matches[0]?.term ?? "";
  if (AMBIGUOUS_TERMS.has(term)) return result("medium", `"${term}" can mean more than one thing`);
  // Unknown Shona or Ndebele words may change the meaning ("anogadzira" = repairs), and high-scam
  // categories need certainty, so there no unknown word is allowed. Elsewhere one is (a brand, a size).
  const strict = interpretation.language === "sn" || interpretation.language === "nd" || category?.risk === "high_scam";
  if (unknown.length > (strict ? 0 : 1)) return result("medium", `unknown words: ${unknown.join(", ")}`);
  return result("high", `${candidates[0]} from "${term}"`);
}
