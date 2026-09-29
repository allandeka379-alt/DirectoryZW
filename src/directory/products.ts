import { singularsOf, type Lexicon, type Sense } from "../ai/lexicon.js";
import type { Db } from "../db/client.js";
import { isStopword, normalizeText } from "../text.js";
import { haversineKm, type Gazetteer } from "./gazetteer.js";

/**
 * Products businesses list on the dashboard, found for what a customer asked for. Everything is
 * read live, at the moment of the request: a new product, a price change or "out of stock" on the
 * dashboard shows in the very next reply on WhatsApp.
 *
 * Words are compared, not just looked up: "fridges", "refrigerator" and "frige" find "Fridge";
 * '55"', "55in" and "55 inch" are one size; a TV asked for doesn't match a TV bracket.
 */

// ---------- Words ----------

/** Units, written many ways, in one form: "300L", "300 litres" and "300 ltr" are all "300 l". */
const UNITS: Record<string, string> = {
  l: "l", lt: "l", ltr: "l", ltrs: "l", litre: "l", litres: "l", liter: "l", liters: "l",
  ml: "ml",
  inch: "inch", inches: "inch", in: "inch",
  kg: "kg", kgs: "kg", kilo: "kg", kilos: "kg", kilogram: "kg", kilograms: "kg",
  g: "g", gram: "g", grams: "g",
  gb: "gb", tb: "tb", mb: "mb",
  mm: "mm", cm: "cm", metre: "m", metres: "m", meter: "m", meters: "m",
  w: "w", watt: "w", watts: "w", kw: "kw", kva: "kva", v: "v", volt: "v", volts: "v",
  ah: "ah", mah: "mah", hp: "hp",
  pc: "pcs", pcs: "pcs", piece: "pcs", pieces: "pcs",
  seater: "seater", seat: "seater", plate: "plate", door: "door", burner: "burner",
};

/** Two-word names treated as one item, so "washing machine" doesn't match a sewing machine. */
const COMPOUNDS: { item: string; phrases: string[] }[] = [
  { item: "washingmachine", phrases: ["washing machine"] },
  { item: "sewingmachine", phrases: ["sewing machine"] },
  { item: "mealiemeal", phrases: ["mealie meal", "maize meal", "mielie meal"] },
  { item: "aircon", phrases: ["air conditioner", "air con"] },
  { item: "solarpanel", phrases: ["solar panel"] },
  { item: "freezer", phrases: ["deep freezer"] },
  { item: "freezer chest", phrases: ["chest freezer"] },
  { item: "gasstove", phrases: ["gas stove"] },
  { item: "phone", phrases: ["cell phone", "smart phone", "mobile phone"] },
  { item: "roofingsheet", phrases: ["roofing sheet", "iron sheet"] },
  { item: "cookingoil", phrases: ["cooking oil"] },
];
/** Each phrase with or without its space, and plural at the end: "washing machines", "aircon". */
const COMPOUND_PATTERNS: [RegExp, string][] = COMPOUNDS.flatMap(({ item, phrases }) =>
  phrases.map((p): [RegExp, string] => [new RegExp(`\\b${p.split(" ").join(" ?")}s?\\b`, "g"), item]),
);
const COMPOUND_ITEMS = new Set(COMPOUNDS.map((c) => c.item.split(" ")[0]!));
/** How the database holds a joined item ("washing" and "machine"), for its first cut. */
const COMPOUND_WORDS: Map<string, string[][]> = new Map(
  COMPOUNDS.filter((c) => !c.phrases.some((p) => p.split(" ").includes(c.item))).map((c) => [c.item, c.phrases.map((p) => p.split(" "))]),
);

/** After these, the rest of a name comes with it: "TV with wall bracket" is a TV. */
const BUNDLE_WORDS = new Set(["with", "plus", "and", "free", "incl", "including", "includes"]);
/** After these, the rest of a name is what it's made for: "Bracket for 55 inch TV" is a bracket. */
const FITS_WORDS = new Set(["for", "of", "fits", "compatible"]);
/** How much, not what: "Tray of 30 eggs" is eggs, "Case of 24 Coke" is Coke. */
const QUANTITY_OF = /\b(?:case|crate|carton|box|pack|packet|bag|tray|bale|roll|bundle|dozen)s? of\b/gi;

/** Words for the same item. The first is the form compared. Extend as customers teach us. */
const SAME_ITEM: string[][] = [
  ["fridge", "refrigerator", "refridgerator", "refrigeration", "frige", "firiji", "friji"],
  ["tv", "television", "telly", "terevhizheni"],
  ["phone", "cellphone", "smartphone", "handset", "foni"],
  ["laptop", "notebook"],
  ["stove", "cooker"],
  ["sofa", "couch", "lounge"],
  ["generator", "genset"],
  ["tyre", "tire"],
  ["tap", "faucet"],
  ["torch", "flashlight"],
  ["nappy", "diaper"],
  ["petrol", "gasoline"],
  ["paraffin", "kerosene"],
  ["mealiemeal", "upfu", "impuphu"],
  ["wardrobe", "closet"],
  ["bed", "bedframe"],
  ["cement", "simende"],
];
const SAME: Map<string, string[]> = new Map();
for (const group of SAME_ITEM) for (const w of group) SAME.set(w, group);

/** Things sold for another item: a "TV stand" isn't a TV. */
const ACCESSORIES = new Set(
  (
    "bracket brackets mount mounts stand stands remote remotes cover covers case cases charger chargers cable cables " +
    "adapter adaptor adapters protector protectors pouch strap straps holder holders sticker stickers skin skins spare spares " +
    "part parts accessory accessories hose knob knobs shelf shelves tray trays seal seals gasket gaskets magnet magnets " +
    "repair repairs service servicing"
  ).split(" "),
);

/** One word of a product name or a request, in every form it's compared by. */
export interface Token {
  text: string;
  /** The word, its singulars and the item it's another name for. */
  forms: string[];
  /** A number, as "55" or "1.5". */
  num?: string;
  /** The unit after a number: "inch", "l", "kg". */
  unit?: string;
  /** After "with", "plus" or "free": it comes with the product ("TV with bracket"). */
  bundled?: boolean;
  /** After "for" or "fits": what the product is made for ("Bracket for TV"). */
  fitsOther?: boolean;
}

function canonicalNumber(raw: string): string {
  const n = Number(raw.replace("p", "."));
  return Number.isFinite(n) ? String(n) : raw;
}

function formsOf(word: string): string[] {
  const out = new Set<string>([word, ...singularsOf(word)]);
  for (const w of [...out]) {
    const group = SAME.get(w);
    if (group) out.add(group[0]!);
  }
  return [...out];
}

/** The words of a product name or a request, sizes and units made comparable. */
export function productTokens(text: string): Token[] {
  const prepared = text
    .replace(QUANTITY_OF, " ")
    .replace(/(\d)\s*(?:"|''|”|″)/g, "$1 inch ")
    .replace(/(\d)[.,](\d)/g, "$1p$2")
    .replace(/[+&]/g, " plus ");
  let norm = normalizeText(prepared);
  for (const [re, to] of COMPOUND_PATTERNS) norm = norm.replace(re, to);
  const out: Token[] = [];
  let bundled = false;
  let fitsOther = false;
  const push = (t: Token) => {
    if (bundled) t.bundled = true;
    if (fitsOther) t.fitsOther = true;
    out.push(t);
  };
  for (const raw of norm.split(" ")) {
    if (!raw) continue;
    if (BUNDLE_WORDS.has(raw)) {
      bundled = true;
      continue;
    }
    if (FITS_WORDS.has(raw)) {
      fitsOther = true;
      continue;
    }
    const parts = /^(\d+(?:p\d+)?)([a-z]+)$/.exec(raw);
    if (parts && UNITS[parts[2]!]) {
      const num = canonicalNumber(parts[1]!);
      push({ text: num, forms: [num], num });
      push({ text: UNITS[parts[2]!]!, forms: [UNITS[parts[2]!]!], unit: UNITS[parts[2]!] });
      continue;
    }
    if (/^\d+(?:p\d+)?$/.test(raw)) {
      const num = canonicalNumber(raw);
      push({ text: num, forms: [num], num });
      continue;
    }
    const prev = out[out.length - 1];
    const unit = UNITS[raw];
    if (unit && prev?.num) {
      push({ text: unit, forms: [unit], unit });
      continue;
    }
    if (isStopword(raw) || raw.length < 2) continue;
    push({ text: raw, forms: formsOf(raw) });
  }
  // A number followed by its unit is a size ("55 inch"): remember the pair on the number.
  for (let i = 0; i < out.length - 1; i++) if (out[i]!.num && out[i + 1]!.unit) out[i]!.unit = out[i + 1]!.unit;
  return out;
}

// ---------- What was asked ----------

/**
 * The words of a request to look for in products: its search words when it has them, otherwise
 * what they typed without the place ("fridge in Avondale" looks for a fridge, not an Avondale).
 */
export function wordsToMatch(
  raw: string,
  query: string | null | undefined,
  area: string | null | undefined,
  gazetteer: Pick<Gazetteer, "match">,
): string {
  if (query?.trim()) return query;
  const place = area ?? gazetteer.match(raw)?.name;
  return place ? normalizeText(raw).replace(new RegExp(`\\b${normalizeText(place)}\\b`, "g"), " ") : raw;
}

type TermKind = "item" | "name" | "brand" | "size" | "unit" | "minor";

interface Term {
  token: Token;
  kind: TermKind;
  weight: number;
  /** Every form it may be written in: its own, synonyms, and English for a Shona or Ndebele word. */
  alternatives: string[];
}

export interface ProductQuery {
  terms: Term[];
  /** The request names an item (not only a brand or a size). */
  hasItem: boolean;
  total: number;
  /** For the database's first cut: prefix searches for the words that matter. */
  tsquery: string;
  budgetUsd: number | null;
  /** Whether a word of a product's name names an item ("fridge"), not a brand, model or size. */
  isItem: (t: Token) => boolean;
}

const WEIGHTS: Record<TermKind, number> = { item: 2, name: 1.5, brand: 1, size: 0.75, unit: 0.25, minor: 0.5 };

function kindOf(senses: Sense[] | undefined): TermKind {
  if (!senses?.length) return "name";
  const roles = new Set(senses.map((s) => s.role));
  if (roles.has("product") || roles.has("service") || roles.has("object")) return "item";
  if (roles.has("brand")) return "brand";
  return "minor";
}

const glossIndex = new WeakMap<Lexicon, Map<string, string[]>>();

/** English words a Shona or Ndebele word means, from its gloss: "firiji" → "fridge". */
function glossWords(lexicon: Lexicon, word: string): string[] {
  let index = glossIndex.get(lexicon);
  if (!index) {
    index = new Map();
    for (const e of lexicon.entries) {
      if (e.language === "en" || !e.gloss) continue;
      const words = normalizeText(e.gloss)
        .split(" ")
        .slice(0, 3)
        .filter((w) => w.length >= 3 && !isStopword(w));
      index.set(e.term, [...(index.get(e.term) ?? []), ...words]);
    }
    glossIndex.set(lexicon, index);
  }
  return index.get(word) ?? [];
}

/**
 * What to look for in product names, from a request's search words ("samsung 55 inch tv"). Items
 * weigh most, then names nobody's taught us (often models), brands, sizes and units.
 */
export function productQuery(text: string, lexicon: Lexicon, budgetUsd: number | null = null): ProductQuery {
  const terms: Term[] = [];
  for (const token of productTokens(text)) {
    if (token.num) {
      terms.push({ token, kind: "size", weight: WEIGHTS.size, alternatives: token.forms });
      continue;
    }
    if (token.unit) {
      terms.push({ token, kind: "unit", weight: WEIGHTS.unit, alternatives: token.forms });
      continue;
    }
    const senses = lexicon.word(token.text);
    const roles = new Set((senses ?? []).map((s) => s.role));
    if (roles.has("filler") && !roles.has("product") && !roles.has("service")) continue;
    let kind = kindOf(senses);
    const alternatives = new Set(token.forms);
    for (const w of glossWords(lexicon, token.text)) for (const f of formsOf(w)) alternatives.add(f);
    // A misspelled word we know ("refrigirator"): look for what it was meant to be too.
    if (!senses) {
      const near = lexicon.closest(token.text);
      if (near) {
        for (const f of formsOf(near.term)) alternatives.add(f);
        kind = kindOf(near.senses);
      }
    }
    if (SAME.has(token.text) || token.forms.some((f) => SAME.has(f)) || COMPOUND_ITEMS.has(token.text)) kind = "item";
    terms.push({ token, kind, weight: WEIGHTS[kind], alternatives: [...alternatives] });
  }
  // The database's first cut looks for every way an item is written: "fridge" finds "Refrigerator".
  const wide = terms.filter((t) => t.kind !== "size" && t.kind !== "unit");
  const lexemes = new Set<string>();
  for (const t of wide) {
    for (const a of t.alternatives) {
      for (const w of [a, ...(SAME.get(a) ?? [])]) {
        if (/^[a-z0-9]{2,}$/.test(w)) lexemes.add(`${w}:*`);
        // It holds "Washing machine" as two words.
        for (const parts of COMPOUND_WORDS.get(w) ?? []) lexemes.add(`(${parts.map((p) => `${p}:*`).join(" & ")})`);
      }
    }
    // A word nobody taught us may be misspelled ("samsang"): its first letters find the right spelling.
    const word = t.token.text;
    if (word.length >= 6 && !lexicon.word(word) && !SAME.has(word) && !COMPOUND_ITEMS.has(word)) lexemes.add(`${word.slice(0, 4)}:*`);
  }
  return {
    terms,
    hasItem: terms.some((t) => t.kind === "item"),
    total: terms.reduce((sum, t) => sum + t.weight, 0),
    tsquery: [...lexemes].slice(0, 40).join(" | "),
    budgetUsd,
    isItem: (t) => itemWord(lexicon, t),
  };
}

const itemWords = new WeakMap<Lexicon, Map<string, boolean>>();

/** A word for something sold or done ("fridge", "tyres", "plumbing"), not a brand, model or size. */
function itemWord(lexicon: Lexicon, t: Token): boolean {
  if (t.num || t.unit) return false;
  let known = itemWords.get(lexicon);
  if (!known) itemWords.set(lexicon, (known = new Map()));
  let is = known.get(t.text);
  if (is === undefined) {
    is = t.forms.some((f) => SAME.has(f)) || COMPOUND_ITEMS.has(t.text) || kindOf(lexicon.word(t.text)) === "item";
    if (known.size >= 20_000) known.clear();
    known.set(t.text, is);
  }
  return is;
}

// ---------- Comparing ----------

function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      cur.push(v);
      best = Math.min(best, v);
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length]!;
}

/** Two forms of a word agree: the same, one a longer form of the other ("samsung"/"samsungs"), or one typo apart. */
function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  if (/^\d/.test(a) || /^\d/.test(b)) return false;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length >= 4 && long.startsWith(short) && long.length - short.length <= 3) return true;
  if (short.length >= 5 && a[0] === b[0]) return editDistance(a, b, long.length >= 9 ? 2 : 1) <= (long.length >= 9 ? 2 : 1);
  return false;
}

function termMatches(term: Term, product: Token[]): Token | undefined {
  return product.find((p) => {
    if (term.kind === "size") return p.num === term.token.num;
    if (term.kind === "unit") return p.unit === term.token.unit;
    return term.alternatives.some((a) => p.forms.some((f) => sameWord(a, f)));
  });
}

export interface ProductScore {
  score: number;
  /** A size asked for and a different one listed ("55 inch" and "43 inch"). */
  sizeConflict: boolean;
}

/** A product's words: its name, the owner's category for it, and its description. */
export interface ProductWords {
  name: Token[];
  category: Token[];
  description: Token[];
}

export function productWords(p: { name: string; category?: string | null; description?: string | null }): ProductWords {
  return {
    name: productTokens(p.name),
    category: productTokens(p.category ?? ""),
    description: productTokens((p.description ?? "").slice(0, 300)),
  };
}

const isAccessory = (t: Token) => t.forms.some((f) => ACCESSORIES.has(f));

/** Sizes within 5% are the same size as far as a customer is concerned: 300 and 305 litres. */
function nearlySame(a: string, b: string): boolean {
  const x = Number(a);
  const y = Number(b);
  return Number.isFinite(x) && Number.isFinite(y) && Math.abs(x - y) <= 0.05 * Math.max(x, y);
}

/**
 * How well a product answers the request, 0 to about 1.2. The item asked for must be in its name or
 * the owner's category for it; its description will do only when the name is just a brand and model
 * ("Capri CF300"). A different size from the one asked for isn't a match, and nor is an accessory
 * for the item.
 */
export function scoreProduct(q: ProductQuery, w: ProductWords): ProductScore {
  if (!q.terms.length || !q.total) return { score: 0, sizeConflict: false };
  let matched = 0;
  let placed = false;
  let itemPlaced = false;
  let itemDescribed = false;
  let accessoryMissing = false;
  /** Where the item (or, with no item asked for, the first word matched) is in the name. */
  let anchor = -1;
  const used = new Set<Token>();
  let sizeConflict = false;
  for (const term of q.terms) {
    const inName = termMatches(term, w.name);
    const inCategory = inName ? undefined : termMatches(term, w.category);
    const inDescription = inName || inCategory ? undefined : termMatches(term, w.description);
    if (inName || inCategory || inDescription) {
      // The name counts in full, the owner's category nearly as much, the description less.
      matched += term.weight * (inName ? 1 : inCategory ? 0.9 : 0.6);
      if (inName || inCategory) placed = true;
      if (inName) {
        used.add(inName);
        if (anchor < 0 && (term.kind === "item" || !q.hasItem)) anchor = w.name.indexOf(inName);
      }
      if (term.kind === "item") {
        if (inName || inCategory) itemPlaced = true;
        else itemDescribed = true;
      }
      continue;
    }
    // Asked for a TV stand: a TV isn't one.
    if (isAccessory(term.token)) accessoryMissing = true;
    if (term.kind === "size" && term.token.unit) {
      sizeConflict ||= [...w.name, ...w.category, ...w.description].some(
        (p) => p.num && p.unit === term.token.unit && !nearlySame(p.num, term.token.num!),
      );
    }
  }
  const none = { score: 0, sizeConflict };
  // Asked for a 65 inch TV: a 43 inch one isn't it, and saying we found it would mislead.
  if (accessoryMissing || sizeConflict) return none;
  const describedOnly = itemDescribed && !w.name.some((t) => q.isItem(t));
  if (q.hasItem && !itemPlaced && !describedOnly) return none;
  if (!placed && !describedOnly) return none;
  // An accessory for the item isn't the item: "TV stand", "Fridge magnet", "Bracket for 55 inch TV".
  // Before the item it only describes it ("Stand fan"); in a bundle it comes with it ("TV with bracket").
  const asked = new Set(q.terms.flatMap((t) => t.alternatives));
  const accessory = w.name.findIndex((p) => isAccessory(p) && !p.bundled && !p.forms.some((f) => asked.has(f)));
  if (accessory >= 0 && (anchor < accessory || w.name[anchor]!.fitsOther)) return none;
  let score = matched / q.total;
  // Tighter names first: "Samsung 55 inch TV" before "Samsung 55 inch TV with soundbar and wall bracket".
  const content = w.name.filter((p) => !p.num && !p.unit);
  if (content.length) score += 0.2 * (content.filter((p) => used.has(p)).length / content.length);
  return { score, sizeConflict };
}

/** Good enough to show a customer. */
export const MATCH_THRESHOLD = 0.55;

// ---------- Finding them ----------

export interface ProductMatch {
  id: string;
  businessId: string;
  name: string;
  price: number | null;
  priceText: string | null;
  unit: string | null;
  photoId: string | null;
  priceUpdatedAt: Date | null;
  score: number;
}

/** The businesses a product search found, each with its best match. */
export interface ProductHit {
  businessId: string;
  name: string;
  description: string;
  phone: string;
  verification: "verified" | "registered";
  areaName: string | null;
  city: string | null;
  distanceKm: number | null;
  ratingAvg: number | null;
  ratingCount: number;
  responseScore: number;
  best: ProductMatch;
  /** How many of its products match. */
  matches: number;
  /** The lowest price among its good matches. */
  fromPrice: number | null;
}

export interface ProductSearch {
  query: ProductQuery;
  lat?: number;
  lng?: number;
  maxKm?: number;
  excludeIds?: string[];
  trade?: "retail" | "wholesale";
  /** Only these businesses (a business card, or showing results again). */
  businessIds?: string[];
  /**
   * Only businesses in this category. For services: a "fridge repair" request is about repairers'
   * listed jobs, never fridges for sale.
   */
  categorySlug?: string;
  /** How many candidates the database may return before they're scored. */
  candidates?: number;
}

interface Row {
  id: string;
  business_id: string;
  name: string;
  category: string | null;
  description: string;
  price_usd: string | null;
  price_text: string | null;
  unit: string | null;
  photo_id: string | null;
  price_updated_at: Date | null;
  b_name: string;
  b_description: string;
  b_phone: string;
  verification: "verified" | "registered";
  lat: number | null;
  lng: number | null;
  response_score: number;
  rating_sum: number;
  rating_count: number;
  area_name: string | null;
  city: string | null;
}

/**
 * Businesses with a product that matches, closest and best first within the database's cut. Only
 * products customers can buy count: live businesses, in stock, not taken down, and never in blocked
 * or restricted categories. Wholesale-only businesses are for businesses buying stock.
 */
export async function searchProducts(db: Db, s: ProductSearch): Promise<ProductHit[]> {
  const q = s.query;
  if (!q.tsquery || !q.terms.length) return [];
  const params: unknown[] = [q.tsquery, s.excludeIds ?? [], s.trade === "wholesale" ? "retail" : "wholesale"];
  const where: string[] = [];
  const located = s.lat != null && s.lng != null;
  const maxKm = s.maxKm ?? 60;
  if (located) {
    // A box around the customer first, so a big catalogue far away is never scored.
    const dLat = maxKm / 111;
    const dLng = maxKm / (111 * Math.max(0.2, Math.cos((s.lat! * Math.PI) / 180)));
    params.push(s.lat! - dLat, s.lat! + dLat, s.lng! - dLng, s.lng! + dLng);
    where.push(`(b.lat IS NULL OR (b.lat BETWEEN $4 AND $5 AND b.lng BETWEEN $6 AND $7))`);
  }
  if (s.businessIds) {
    params.push(s.businessIds);
    where.push(`b.id = ANY($${params.length}::uuid[])`);
  }
  if (s.categorySlug) {
    params.push(s.categorySlug);
    where.push(`EXISTS (SELECT 1 FROM business_categories bc WHERE bc.business_id = b.id AND bc.category_slug = $${params.length})`);
  }
  params.push(s.candidates ?? 1500);
  const rows = await db.query<Row>(
    `WITH q AS (SELECT to_tsquery('simple', $1) AS tsq)
     SELECT o.id, o.business_id, o.name, o.category, o.description, o.price_usd, o.price_text, o.unit, o.photo_id,
            o.price_updated_at, b.name AS b_name, b.description AS b_description, b.phone AS b_phone, b.verification,
            b.lat, b.lng, b.response_score, b.rating_sum, b.rating_count, a.name AS area_name, a.city
       FROM offerings o
       JOIN businesses b ON b.id = o.business_id
       LEFT JOIN areas a ON a.id = b.area_id
       CROSS JOIN q
      WHERE o.archived_at IS NULL AND o.in_stock AND o.search_tsv @@ q.tsq
        AND b.status = 'active'
        AND NOT (b.id::text = ANY($2::text[]))
        AND b.trade <> $3
        AND NOT EXISTS (
          SELECT 1 FROM business_categories bc JOIN categories c ON c.slug = bc.category_slug
           WHERE bc.business_id = b.id AND c.risk IN ('blocked', 'restricted'))
        ${where.map((w) => `AND ${w}`).join(" ")}
      ORDER BY ts_rank(o.search_tsv, q.tsq) DESC
      LIMIT $${params.length}`,
    params,
  );

  const byBusiness = new Map<string, ProductHit>();
  for (const r of rows) {
    const distanceKm = located && r.lat != null && r.lng != null ? haversineKm(s.lat!, s.lng!, r.lat, r.lng) : null;
    if (distanceKm != null && distanceKm > maxKm) continue;
    const { score } = scoreProduct(q, productWords(r));
    if (score < MATCH_THRESHOLD) continue;
    const price = r.price_usd == null ? null : Number(r.price_usd);
    const match: ProductMatch = {
      id: r.id,
      businessId: r.business_id,
      name: r.name,
      price,
      priceText: price == null ? r.price_text : null,
      unit: r.unit,
      photoId: r.photo_id,
      priceUpdatedAt: r.price_updated_at ? new Date(r.price_updated_at) : null,
      score: score + budgetFit(price, q.budgetUsd),
    };
    const hit = byBusiness.get(r.business_id);
    if (!hit) {
      byBusiness.set(r.business_id, {
        businessId: r.business_id,
        name: r.b_name,
        description: r.b_description,
        phone: r.b_phone,
        verification: r.verification,
        areaName: r.area_name,
        city: r.city,
        distanceKm,
        ratingAvg: r.rating_count > 0 ? r.rating_sum / r.rating_count : null,
        ratingCount: r.rating_count,
        responseScore: r.response_score,
        best: match,
        matches: 1,
        fromPrice: price,
      });
      continue;
    }
    hit.matches++;
    if (price != null && (hit.fromPrice == null || price < hit.fromPrice)) hit.fromPrice = price;
    if (better(match, hit.best)) hit.best = match;
  }
  return [...byBusiness.values()];
}

/** Within budget helps; well over it counts against. No budget, no change. */
function budgetFit(price: number | null, budget: number | null): number {
  if (budget == null || price == null) return 0;
  if (price <= budget) return 0.1;
  return price <= budget * 1.1 ? -0.05 : -0.3;
}

/** The better of two matches from one business: more relevant, then cheaper, then more recently priced. */
function better(a: ProductMatch, b: ProductMatch): boolean {
  if (Math.abs(a.score - b.score) > 0.05) return a.score > b.score;
  if (a.price != null && b.price != null && a.price !== b.price) return a.price < b.price;
  if (a.price != null && b.price == null) return true;
  return (a.priceUpdatedAt?.getTime() ?? 0) > (b.priceUpdatedAt?.getTime() ?? 0);
}

/** A business's own products that match, best first: for its card. */
export async function productsOf(db: Db, businessId: string, query: ProductQuery, limit = 3): Promise<ProductMatch[]> {
  if (!query.tsquery) return [];
  const rows = await db.query<Row>(
    `SELECT o.id, o.business_id, o.name, o.category, o.description, o.price_usd, o.price_text, o.unit, o.photo_id, o.price_updated_at
       FROM offerings o
      WHERE o.business_id = $2 AND o.archived_at IS NULL AND o.in_stock AND o.search_tsv @@ to_tsquery('simple', $1)
      ORDER BY ts_rank(o.search_tsv, to_tsquery('simple', $1)) DESC
      LIMIT 300`,
    [query.tsquery, businessId],
  );
  const matches: ProductMatch[] = [];
  for (const r of rows) {
    const { score } = scoreProduct(query, productWords(r));
    if (score < MATCH_THRESHOLD) continue;
    const price = r.price_usd == null ? null : Number(r.price_usd);
    matches.push({
      id: r.id,
      businessId: r.business_id,
      name: r.name,
      price,
      priceText: price == null ? r.price_text : null,
      unit: r.unit,
      photoId: r.photo_id,
      priceUpdatedAt: r.price_updated_at ? new Date(r.price_updated_at) : null,
      score: score + budgetFit(price, query.budgetUsd),
    });
  }
  return matches.sort((a, b) => (better(a, b) ? -1 : better(b, a) ? 1 : 0)).slice(0, limit);
}

/** "$11.50", or the price as written when it isn't in US dollars, or null for "ask them". */
export function priceOf(m: { price: number | null; priceText: string | null }): string | null {
  if (m.price != null) return `$${m.price.toFixed(2)}`;
  return m.priceText;
}
