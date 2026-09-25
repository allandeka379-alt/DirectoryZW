import { containsPhrase, normalizeMessage, parseBudget, searchTokens } from "../text.js";
import { Lexicon } from "./lexicon.js";
import { readRequest, type Reading } from "./reading.js";
import {
  sanitizeClassification,
  type BusinessClassification,
  type InterpretContext,
  type Interpreter,
  type RequestInterpretation,
} from "./types.js";

const GREETINGS = [
  "hi", "hello", "hey", "hie", "howzit", "good morning", "good afternoon", "good evening", "morning",
  "mhoro", "mhoroi", "makadini", "maswera sei", "mangwanani", "masikati", "manheru", "hesi", "ndeipi", "zvirisei",
  "salibonani", "sawubona",
];
const THANKS = ["thanks", "thank you", "ok", "okay", "cool", "ndatenda", "tatenda", "mazvita", "maita basa", "ndinotenda", "ngiyabonga", "siyabonga"];
const HELP = ["help", "menu", "how does this work", "how it works", "what can you do"];
const HUMAN = ["agent", "human", "real person", "customer care", "speak to someone", "talk to someone", "talk to a person"];
const WHEN = /\b(today|tonight|tomorrow|this weekend|weekend|next week|saturday|sunday|monday|tuesday|wednesday|thursday|friday|asap|urgently|urgent)\b/;
const QUESTION = /^(what|who|when|why|how|is|are|was|tell me|explain|define)\b/;
const PURCHASE = /\b(buy|need|want|looking|hire|rent|find|where|sell|sells|get)\b/;

/**
 * The local engine: reads requests with the lexicon (category words, word roles, Shona words and
 * verb roots), the action rules and place names. It answers on its own when it's sure (see
 * local.ts), and classifies business descriptions and tips without Claude.
 */
export class KeywordInterpreter implements Interpreter {
  readonly name = "keyword";

  /** What each word of a request is, and which categories fit. */
  read(text: string, ctx: InterpretContext): Reading {
    return readRequest(text, {
      taxonomy: ctx.taxonomy,
      gazetteer: ctx.gazetteer,
      lexicon: ctx.lexicon ?? Lexicon.fromSeeds(ctx.taxonomy),
    });
  }

  async interpretRequest(text: string, ctx: InterpretContext): Promise<RequestInterpretation> {
    return this.interpret(text, this.read(text, ctx), ctx);
  }

  /** What a reading amounts to: the intent, the most likely category, place, budget and timing. */
  interpret(text: string, reading: Reading, ctx: InterpretContext): RequestInterpretation {
    const norm = normalizeMessage(text);
    const base: RequestInterpretation = {
      intent: "search",
      category_slug: null,
      query: reading.query,
      area: reading.area?.name ?? null,
      budget_usd: parseBudget(text),
      needed_by: norm.match(WHEN)?.[1] ?? null,
      clarifying_question: null,
      language: reading.language,
    };
    if (reading.blocked) return { ...base, intent: "blocked", category_slug: reading.blocked };
    if (HUMAN.some((p) => containsPhrase(norm, p))) return { ...base, intent: "human" };
    const top = ctx.taxonomy.get(reading.candidates[0]);
    if (!top && norm.split(" ").length <= 4 && [...GREETINGS, ...THANKS].some((g) => containsPhrase(norm, g))) {
      return { ...base, intent: "greeting" };
    }
    if (!top && HELP.some((h) => containsPhrase(norm, h))) return { ...base, intent: "help" };
    if (top) return { ...base, category_slug: top.slug, query: reading.query || top.name.toLowerCase() };
    if (QUESTION.test(norm) && !PURCHASE.test(norm)) return { ...base, intent: "out_of_scope" };
    if (reading.query.length >= 3) return base;
    return {
      ...base,
      intent: "unclear",
      clarifying_question: "What are you looking for? Tell me the product or service, and your area.",
    };
  }

  async classifyBusiness(text: string, ctx: InterpretContext): Promise<BusinessClassification> {
    const slugs = this.read(text, ctx).mentioned.filter((slug) => {
      const risk = ctx.taxonomy.get(slug)?.risk;
      return risk === "normal" || risk === "high_scam";
    });
    return sanitizeClassification({ category_slugs: slugs.slice(0, 3), keywords: searchTokens(text).join(" ") }, ctx.taxonomy);
  }
}
