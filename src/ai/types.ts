import { z } from "zod";
import type { Gazetteer } from "../directory/gazetteer.js";
import type { Taxonomy } from "../directory/taxonomy.js";
import type { WordShapeClassifier } from "./classifier.js";
import type { Lexicon } from "./lexicon.js";

export const RequestInterpretationSchema = z.object({
  intent: z.enum(["search", "greeting", "help", "human", "out_of_scope", "blocked", "unclear"]),
  /** Best category slug from our taxonomy, or null. */
  category_slug: z.string().nullable(),
  /** Short English search phrase: "samsung 55 inch tv", "plumber blocked drain". */
  query: z.string(),
  /** Suburb, town or landmark as the customer wrote it. */
  area: z.string().nullable(),
  budget_usd: z.number().nullable(),
  needed_by: z.string().nullable(),
  /** Only when a search would be useless without one more detail. */
  clarifying_question: z.string().nullable(),
  language: z.enum(["en", "sn", "nd", "other"]),
});
export type RequestInterpretation = z.infer<typeof RequestInterpretationSchema>;

export const BusinessClassificationSchema = z.object({
  category_slugs: z.array(z.string()),
  keywords: z.string(),
});
export type BusinessClassification = z.infer<typeof BusinessClassificationSchema>;

export interface InterpretContext {
  taxonomy: Taxonomy;
  gazetteer?: Gazetteer;
  /** What words mean to the local engine; the seed lexicon when left out. */
  lexicon?: Lexicon;
  /** A second opinion from word shapes, for words the rules don't know. */
  classifier?: WordShapeClassifier;
  /** The customer's previous request, for follow-ups like "cheaper ones?". */
  previousRequest?: string;
}

/** Turns free text into structured data. It never decides prices, stock or which businesses exist. */
export interface Interpreter {
  readonly name: string;
  interpretRequest(text: string, ctx: InterpretContext): Promise<RequestInterpretation>;
  classifyBusiness(text: string, ctx: InterpretContext): Promise<BusinessClassification>;
}

/** Keep model output inside what the rest of the app expects. */
export function sanitizeInterpretation(i: RequestInterpretation, taxonomy: Taxonomy): RequestInterpretation {
  const category = taxonomy.get(i.category_slug);
  return {
    ...i,
    category_slug: category ? category.slug : null,
    intent: category?.risk === "blocked" ? "blocked" : i.intent,
    query: i.query.trim().slice(0, 80),
    area: i.area?.trim().slice(0, 60) || null,
    budget_usd: i.budget_usd != null && i.budget_usd > 0 ? i.budget_usd : null,
    needed_by: i.needed_by?.trim().slice(0, 40) || null,
    clarifying_question: i.clarifying_question?.trim().slice(0, 300) || null,
  };
}

export function sanitizeClassification(c: BusinessClassification, taxonomy: Taxonomy): BusinessClassification {
  const slugs = c.category_slugs.filter((s) => {
    const cat = taxonomy.get(s);
    return cat && (cat.risk === "normal" || cat.risk === "high_scam");
  });
  return { category_slugs: [...new Set(slugs)].slice(0, 3), keywords: c.keywords.trim().slice(0, 200) };
}
