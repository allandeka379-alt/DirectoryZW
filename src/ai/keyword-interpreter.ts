import { containsPhrase, normalizeText, parseBudget, searchTokens } from "../text.js";
import {
  sanitizeClassification,
  type BusinessClassification,
  type InterpretContext,
  type Interpreter,
  type RequestInterpretation,
} from "./types.js";

const GREETINGS = ["hi", "hello", "hey", "hie", "howzit", "mhoro", "mhoroi", "makadini", "salibonani", "sawubona", "good morning", "good afternoon", "good evening", "morning"];
const THANKS = ["thanks", "thank you", "ndatenda", "ngiyabonga", "siyabonga", "ok", "okay", "cool"];
const HELP = ["help", "menu", "how does this work", "how it works", "what can you do"];
const HUMAN = ["agent", "human", "real person", "customer care", "speak to someone", "talk to someone", "talk to a person"];
const WHEN = /\b(today|tonight|tomorrow|this weekend|weekend|next week|saturday|sunday|monday|tuesday|wednesday|thursday|friday|asap|urgently|urgent)\b/;
const QUESTION = /^(what|who|when|why|how|is|are|was|tell me|explain|define)\b/;
const PURCHASE = /\b(buy|need|want|looking|hire|rent|find|where|sell|sells|get)\b/;
const SHONA = /\b(ndiri|ndinoda|ndoda|ndinotsvaga|ndirikuda|mhoro|kupi|ndapota|zvakanaka|mune|muri)\b/;
const NDEBELE = /\b(ngifuna|ngicela|sawubona|salibonani|ngiyabonga|kuphi|ngidinga)\b/;

/**
 * Offline interpreter: category synonyms, place names and a few patterns. Used when there is
 * no Claude API key, when Claude fails, and in tests. It is deliberately simple.
 */
export class KeywordInterpreter implements Interpreter {
  readonly name = "keyword";

  async interpretRequest(text: string, ctx: InterpretContext): Promise<RequestInterpretation> {
    const norm = normalizeText(text);
    const words = norm.split(" ").filter(Boolean);
    const top = ctx.taxonomy.match(text)[0];
    const area = ctx.gazetteer?.match(text);
    const base: RequestInterpretation = {
      intent: "search",
      category_slug: null,
      query: "",
      area: area?.name ?? null,
      budget_usd: parseBudget(text),
      needed_by: norm.match(WHEN)?.[1] ?? null,
      clarifying_question: null,
      language: SHONA.test(norm) ? "sn" : NDEBELE.test(norm) ? "nd" : "en",
    };
    if (top?.category.risk === "blocked") return { ...base, intent: "blocked", category_slug: top.category.slug };
    if (HUMAN.some((p) => containsPhrase(norm, p))) return { ...base, intent: "human" };
    if (!top && words.length <= 4 && [...GREETINGS, ...THANKS].some((g) => containsPhrase(norm, g))) {
      return { ...base, intent: "greeting" };
    }
    if (!top && HELP.some((h) => containsPhrase(norm, h))) return { ...base, intent: "help" };

    const areaWords = new Set(area ? normalizeText([area.name, ...area.aliases].join(" ")).split(" ") : []);
    const tokens = searchTokens(text).filter((t) => !areaWords.has(t));
    const query = tokens.join(" ");
    if (top) return { ...base, category_slug: top.category.slug, query: query || top.term };
    if (QUESTION.test(norm) && !PURCHASE.test(norm)) return { ...base, intent: "out_of_scope" };
    if (query.length >= 3) return { ...base, query };
    return {
      ...base,
      intent: "unclear",
      clarifying_question: "What are you looking for? Tell me the product or service, and your area.",
    };
  }

  async classifyBusiness(text: string, ctx: InterpretContext): Promise<BusinessClassification> {
    const slugs = ctx.taxonomy
      .match(text)
      .filter((m) => m.category.risk === "normal" || m.category.risk === "high_scam")
      .slice(0, 3)
      .map((m) => m.category.slug);
    return sanitizeClassification({ category_slugs: slugs, keywords: searchTokens(text).join(" ") }, ctx.taxonomy);
  }
}
