import type { Db } from "../db/client.js";
import { englishWords, ndebeleWords, shonaWords, type LexiconSeed } from "../db/seed-data/lexicon.js";
import type { Taxonomy } from "../directory/taxonomy.js";
import { normalizeText } from "../text.js";
import { allowedEdits, editDistance } from "./fuzzy.js";
import { findNdebeleRoot } from "./ndebele.js";
import { CATEGORY_FAMILY } from "./rules.js";
import { findRoot, looseKey } from "./shona.js";

export const LANGUAGES = ["en", "sn", "nd"] as const;
export type Lang = (typeof LANGUAGES)[number];

/**
 * What a word does in a request:
 * - service, product: decides the category
 * - object, brand, occasion: weak, only decides when nothing stronger is said
 * - action: changes the category of what it applies to
 * - spec: a neutral detail
 * - filler: ignored
 */
export const ROLES = ["service", "product", "object", "brand", "occasion", "action", "spec", "filler"] as const;
export type Role = (typeof ROLES)[number];

export const ACTIONS = [
  "repair", "make", "buy", "hire", "move", "dig", "build", "paint", "sew", "clean", "wash", "cook", "teach", "learn", "drive",
  "hair", "send", "install", "print",
] as const;
export type Action = (typeof ACTIONS)[number];

/** Kinds of thing, for the action rules: repairing an appliance is appliance repairs. */
export const FAMILIES = [
  "phone", "computer", "electronics", "appliance", "car", "car_part", "battery", "event_item", "chairs", "furniture", "house",
  "land", "clothes", "shoes", "hair", "food", "water", "goods", "parcel", "truck", "event",
] as const;
export type Family = (typeof FAMILIES)[number];

export const STATUSES = ["draft", "approved", "rejected"] as const;
export type LexiconStatus = (typeof STATUSES)[number];

/** A row of the lexicon: one meaning of one word. */
export interface LexiconEntry {
  id?: number;
  term: string;
  language: Lang;
  role: Role;
  categories: string[];
  family: Family | null;
  action: Action | null;
  /** A verb root such as "gadzir", matched with Shona prefixes and endings. */
  root: boolean;
  gloss: string;
  status: LexiconStatus;
}

/** One meaning of a word, as the engine uses it. */
export interface Sense {
  term: string;
  language: Lang;
  role: Role;
  categories: string[];
  family?: Family;
  action?: Action;
  /** False for draft words nobody has approved: they can lead to a question, never a straight answer. */
  trusted: boolean;
  /** One of a category's own words (its name or a synonym) rather than a lexicon entry. */
  fromCategory: boolean;
}

export interface Phrase {
  words: string[];
  senses: Sense[];
}

export interface LexiconOptions {
  /** Treat draft words as approved, e.g. to measure what reviewing them would gain. */
  trustDrafts?: boolean;
}

export const STRONG_ROLES: ReadonlySet<Role> = new Set(["service", "product"]);
export const WEAK_ROLES: ReadonlySet<Role> = new Set(["object", "brand", "occasion"]);
/** Roles that say what a word is (rather than what's done to it): they replace a category's own sense of the word. */
const NOUN_ROLES: ReadonlySet<Role> = new Set(["service", "product", "object", "brand", "occasion", "spec", "filler"]);

/** Singular forms to try for a plural: "tyres" → "tyre", "couches" → "couch", "batteries" → "battery". */
export function singularsOf(word: string): string[] {
  const out: string[] = [];
  if (word.length < 4) return out;
  if (word.endsWith("ies")) out.push(`${word.slice(0, -3)}y`);
  if (/(?:ches|shes|sses|xes|zes|oes)$/.test(word)) out.push(word.slice(0, -2));
  if (word.endsWith("s") && !/(?:ss|us|is)$/.test(word)) out.push(word.slice(0, -1));
  return out;
}

/** Base forms to try for an English word form: "installer" → "install", "drilling" → "drill", "fixed" → "fix". */
export function baseForms(word: string): string[] {
  const out: string[] = [];
  const add = (s: string) => {
    if (s.length >= 3 && !out.includes(s)) out.push(s);
  };
  for (const suffix of ["ing", "ed"]) {
    if (!word.endsWith(suffix)) continue;
    const base = word.slice(0, -suffix.length);
    add(base);
    add(`${base}e`);
    if (/(.)\1$/.test(base)) add(base.slice(0, -1));
  }
  if (word.endsWith("ied")) add(`${word.slice(0, -3)}y`);
  if (word.endsWith("ers")) {
    add(word.slice(0, -3));
    add(word.slice(0, -1));
  } else if (word.endsWith("er")) {
    add(word.slice(0, -2));
    add(word.slice(0, -1));
  }
  return out;
}

/** The seed lexicon as rows: English approved, Shona and Ndebele as drafts for native speakers to review. */
export function seedEntries(): LexiconEntry[] {
  const rows = (seeds: LexiconSeed[], language: Lang, status: LexiconStatus): LexiconEntry[] =>
    seeds.map((s) => ({
      term: s.root ? s.term : normalizeText(s.term),
      language,
      role: s.role,
      categories: s.categories ?? [],
      family: s.family ?? null,
      action: s.action ?? null,
      root: s.root ?? false,
      gloss: s.gloss,
      status,
    }));
  const seen = new Set<string>();
  return [...rows(englishWords, "en", "approved"), ...rows(shonaWords, "sn", "draft"), ...rows(ndebeleWords, "nd", "draft")].filter((e) => {
    const key = `${e.term}|${e.language}|${e.role}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const fromSeedsCache = new WeakMap<Taxonomy, Lexicon>();

/**
 * Everything the local engine knows about words: each category's own words, plus the lexicon's
 * roles, Shona words and verb roots. Built in memory; rebuilt when words or categories change.
 */
export class Lexicon {
  private readonly singles = new Map<string, Sense[]>();
  /** Plural terms by their singular ("chair" → "chairs"), when the singular isn't a term itself. */
  private readonly bySingular = new Map<string, Sense[]>();
  private readonly phrases = new Map<string, Phrase[]>();
  /** Verb roots by language, each matched with its own grammar; lists longest first. */
  private readonly roots = new Map<Lang, Map<string, Sense[]>>();
  private readonly rootLists = new Map<Lang, string[]>();
  private readonly loose = new Map<string, Sense[]>();
  private readonly spellings: { term: string; senses: Sense[] }[] = [];

  constructor(
    readonly entries: LexiconEntry[],
    readonly taxonomy: Taxonomy,
    readonly options: LexiconOptions = {},
  ) {
    const byTerm = new Map<string, Sense[]>();
    const add = (term: string, sense: Sense) => byTerm.set(term, [...(byTerm.get(term) ?? []), sense]);
    const nouns = new Set<string>();

    for (const e of entries) {
      if (e.status === "rejected") continue;
      const term = e.root ? e.term.trim().toLowerCase() : normalizeText(e.term);
      if (!term) continue;
      const sense: Sense = {
        term,
        language: e.language,
        role: e.role,
        categories: e.categories,
        family: e.family ?? undefined,
        action: e.action ?? undefined,
        trusted: e.status === "approved" || !!options.trustDrafts,
        fromCategory: false,
      };
      if (e.root) {
        const byRoot = this.roots.get(e.language) ?? new Map<string, Sense[]>();
        byRoot.set(term, [...(byRoot.get(term) ?? []), sense]);
        this.roots.set(e.language, byRoot);
        continue;
      }
      add(term, sense);
      if (NOUN_ROLES.has(e.role)) nouns.add(term);
    }
    // A category's own words, unless the lexicon says what the word is ("toyota" is a brand, not a car for sale).
    for (const category of taxonomy.categories) {
      for (const raw of [category.name, ...category.synonyms]) {
        const term = normalizeText(raw);
        if (!term || nouns.has(term)) continue;
        const exists = byTerm.get(term)?.some((s) => s.fromCategory && s.categories.includes(category.slug));
        if (exists) continue;
        add(term, {
          term,
          language: "en",
          role: "product",
          categories: [category.slug],
          family: CATEGORY_FAMILY[category.slug],
          trusted: true,
          fromCategory: true,
        });
      }
    }

    for (const [term, senses] of byTerm) {
      const words = term.split(" ");
      if (words.length > 1) {
        const list = this.phrases.get(words[0]!) ?? [];
        list.push({ words, senses });
        list.sort((a, b) => b.words.length - a.words.length);
        this.phrases.set(words[0]!, list);
        continue;
      }
      this.singles.set(term, senses);
      if (senses.some((s) => s.language !== "en")) this.loose.set(looseKey(term), senses);
      if (term.length >= 5) this.spellings.push({ term, senses });
    }
    for (const [term, senses] of this.singles) {
      for (const singular of singularsOf(term)) if (!this.singles.has(singular)) this.bySingular.set(singular, senses);
    }
    for (const [language, byRoot] of this.roots) this.rootLists.set(language, [...byRoot.keys()].sort((a, b) => b.length - a.length));
  }

  /** The lexicon table, plus the categories' own words. */
  static async load(db: Db, taxonomy: Taxonomy, options: LexiconOptions = {}): Promise<Lexicon> {
    const rows = await db.query<Omit<LexiconEntry, "root"> & { is_root: boolean }>(
      `SELECT id, term, language, role, categories, family, action, is_root, gloss, status
         FROM lexicon WHERE status <> 'rejected' ORDER BY id`,
    );
    return new Lexicon(
      rows.map(({ is_root, ...r }) => ({ ...r, root: is_root })),
      taxonomy,
      options,
    );
  }

  /** The seed lexicon without a database, for callers that only have the categories. */
  static fromSeeds(taxonomy: Taxonomy): Lexicon {
    let lexicon = fromSeedsCache.get(taxonomy);
    if (!lexicon) {
      lexicon = new Lexicon(seedEntries(), taxonomy);
      fromSeedsCache.set(taxonomy, lexicon);
    }
    return lexicon;
  }

  /** The same words over changed categories. */
  withTaxonomy(taxonomy: Taxonomy): Lexicon {
    return new Lexicon(this.entries, taxonomy, this.options);
  }

  /** Whether a dictionary form (a word, phrase or root, as a phrasebook signature holds it) is in the lexicon. */
  knows(key: string): boolean {
    const k = key.replace(/_/g, " ");
    if (this.singles.has(k) || this.bySingular.has(k) || [...this.roots.values()].some((r) => r.has(k))) return true;
    return (this.phrases.get(k.split(" ")[0]!) ?? []).some((p) => p.words.join(" ") === k);
  }

  /** A single word's meanings, allowing for plurals: "chair" finds "chairs", "tyres" finds "tyre". */
  word(word: string): Sense[] | undefined {
    const exact = this.singles.get(word);
    if (exact) return exact;
    for (const singular of singularsOf(word)) {
      const hit = this.singles.get(singular);
      if (hit) return hit;
    }
    return this.bySingular.get(word);
  }

  /** The longest phrase of two or more words starting at `start` (the last word may be plural). */
  phraseAt(words: readonly string[], start: number, end = words.length): Phrase | undefined {
    const first = words[start];
    if (!first) return undefined;
    const lists = [first, ...singularsOf(first)].flatMap((w) => this.phrases.get(w) ?? []);
    return lists
      .sort((a, b) => b.words.length - a.words.length)
      .find((p) => start + p.words.length <= end && p.words.every((w, k) => sameWord(words[start + k]!, w)));
  }

  /** A known verb root inside a word, read with its language's grammar: "anogadzira" → gadzir, "olungisa" → lungis. */
  root(word: string): { root: string; senses: Sense[]; language: Lang } | undefined {
    for (const [language, list] of this.rootLists) {
      const found = language === "nd" ? findNdebeleRoot(word, list) : findRoot(word, list);
      if (found) return { root: found.root, senses: this.roots.get(language)!.get(found.root)!, language };
    }
    return undefined;
  }

  /** A Shona word written with a common spelling variation ("bazi" for "bhazi"). */
  looseMatch(word: string): Sense[] | undefined {
    return this.loose.get(looseKey(word));
  }

  /**
   * The one known word this is probably a misspelling of: same first letter, one wrong letter for
   * words of 6 or more letters, two for 10 or more. Nothing when two different words are equally close.
   */
  closest(word: string): { term: string; senses: Sense[] } | undefined {
    const max = allowedEdits(word.length);
    if (!max) return undefined;
    let best: { term: string; senses: Sense[]; d: number } | undefined;
    let tie = false;
    for (const s of this.spellings) {
      const limit = Math.min(max, allowedEdits(s.term.length));
      if (!limit || s.term[0] !== word[0] || Math.abs(s.term.length - word.length) > limit) continue;
      const d = editDistance(word, s.term, limit);
      if (d > limit) continue;
      if (!best || d < best.d) {
        best = { ...s, d };
        tie = false;
      } else if (d === best.d && best.term !== s.term) {
        tie = true;
      }
    }
    return best && !tie ? { term: best.term, senses: best.senses } : undefined;
  }
}

/** "pipes" matches "pipe"; words otherwise match exactly. */
function sameWord(word: string, term: string): boolean {
  return word === term || singularsOf(word).includes(term);
}
