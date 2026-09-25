import type { Db } from "../db/client.js";
import type { CategoryRisk } from "../db/seed-data/categories.js";
import { containsPhrase, normalizeText } from "../text.js";

export interface Category {
  slug: string;
  name: string;
  group: string;
  synonyms: string[];
  risk: CategoryRisk;
  needsLocation: boolean;
  /** Categories to refer customers to when none of this category's suppliers are nearby. */
  related: string[];
  /** The name, or a shorter label that fits a WhatsApp button. */
  short: string;
  /** Its businesses sell things (stores) rather than do a job. */
  goods: boolean;
}

export interface CategoryMatch {
  category: Category;
  score: number;
  term: string;
}

/** The category tree, loaded once and matched in memory. */
export class Taxonomy {
  private readonly bySlug: Map<string, Category>;
  private readonly terms: { category: Category; term: string }[];

  constructor(readonly categories: Category[]) {
    this.bySlug = new Map(categories.map((c) => [c.slug, c]));
    this.terms = categories.flatMap((c) =>
      [...new Set([c.name, ...c.synonyms].map(normalizeText))].filter(Boolean).map((term) => ({ category: c, term })),
    );
  }

  /** Seeded synonyms plus the ones added from the ops console. */
  static async load(db: Db): Promise<Taxonomy> {
    const rows = await db.query<{
      slug: string;
      name: string;
      group_name: string;
      synonyms: string[];
      risk: CategoryRisk;
      needs_location: boolean;
      related: string[];
      short_name: string | null;
      sells_goods: boolean;
    }>(
      `SELECT slug, name, group_name, synonyms || extra_synonyms AS synonyms, risk, needs_location, related, short_name, sells_goods
         FROM categories ORDER BY slug`,
    );
    return new Taxonomy(
      rows.map((r) => ({
        slug: r.slug,
        name: r.name,
        group: r.group_name,
        synonyms: r.synonyms,
        risk: r.risk,
        needsLocation: r.needs_location,
        related: r.related,
        short: r.short_name ?? r.name,
        goods: r.sells_goods,
      })),
    );
  }

  get(slug: string | null | undefined): Category | undefined {
    return slug ? this.bySlug.get(slug) : undefined;
  }

  /** Categories a customer can search (not blocked or restricted). */
  searchable(): Category[] {
    return this.categories.filter((c) => c.risk === "normal" || c.risk === "high_scam");
  }

  /** Categories whose names or synonyms appear in the text, best first. Longer phrases win. */
  match(text: string): CategoryMatch[] {
    const t = normalizeText(text);
    const best = new Map<string, CategoryMatch>();
    for (const { category, term } of this.terms) {
      if (!containsPhrase(t, term)) continue;
      const score = term.split(" ").length * 10 + term.length;
      const prev = best.get(category.slug);
      if (!prev || score > prev.score) best.set(category.slug, { category, score, term });
    }
    return [...best.values()].sort((a, b) => b.score - a.score);
  }
}
