import type { Area, Gazetteer } from "../directory/gazetteer.js";
import type { Taxonomy } from "../directory/taxonomy.js";
import { isStopword, normalizeMessage } from "../text.js";
import { baseForms, STRONG_ROLES, WEAK_ROLES, type Action, type Family, type Lexicon, type Role, type Sense } from "./lexicon.js";
import { ndebeleStems } from "./ndebele.js";
import { ACTION_DEFAULTS, FAMILY_CONTEXT, RULES, SOFT_ACTIONS } from "./rules.js";
import { withoutJoiner, withoutPlural } from "./shona.js";

/** Words that only appear in Shona or Ndebele requests. */
const SHONA_HINT =
  /\b(ndiri|ndinoda|ndoda|ndinotsvaga|ndirikutsvaga|ndirikuda|ndichada|mhoro|mhoroi|kupi|ndekupi|ndapota|zvakanaka|mune|muri|munhu|mumwe|anogona|ndibatsirei|ndibatsire|ku|kwa)\b/;
const NDEBELE_HINT = /\b(ngifuna|ngiyafuna|ngicela|ngiyacela|sawubona|salibonani|ngiyabonga|kuphi|lapho|ngidinga|umuntu|omunye)\b/;

export type WordKind = "place" | "number" | "filler" | "meaning" | "unknown";

/** One word (or phrase) of a request and what the engine made of it. */
export interface ReadWord {
  /** As written, after normalising. */
  text: string;
  /** Its dictionary form: the term, root or stem it matched. Phrasebook signatures use it. */
  key: string;
  kind: WordKind;
  senses: Sense[];
  /** How it was recognised: as written, as a word form ("drilling"), through Shona or Ndebele prefixes, or as a likely misspelling. */
  via?: "exact" | "form" | "shona" | "ndebele" | "spelling";
  /** It describes another word ("yemombe", of cattle, in "nyama yemombe"): it narrows, it doesn't compete. */
  describes?: boolean;
}

export type EvidenceKind = "rule" | "item" | "context" | "action";

/** Categories one part of the message points to, and why. */
export interface Evidence {
  categories: string[];
  kind: EvidenceKind;
  words: ReadWord[];
}

export interface Reading {
  words: ReadWord[];
  area?: Area;
  /** Categories that fit, most likely first. */
  candidates: string[];
  /**
   * What settled them: an action applied to a thing ("fix" + phone), a product or service word,
   * only weak words (a brand, an occasion, "car"), or only an action ("ndoda kusona", to sew).
   */
  decidedBy: EvidenceKind | "none";
  /** A blocked category named anywhere in the message. */
  blocked?: string;
  /** Every category the message names, best first, for classifying business descriptions. */
  mentioned: string[];
  /** Content words nothing recognised. */
  unknown: string[];
  /** Why the answer isn't certain: spelling guesses and draft words nobody has approved. */
  doubts: string[];
  /** Words whose action nothing used: "fix" + shoes may want a cobbler, not a shoe shop. */
  unusedActions: string[];
  language: "en" | "sn" | "nd";
  /** The customer's content words, for searching and for "I found … for X". */
  query: string;
  /** How the categories were reached, for logs, the team and Claude. */
  notes: string[];
}

export interface ReadContext {
  taxonomy: Taxonomy;
  gazetteer?: Gazetteer;
  lexicon: Lexicon;
}

const EVIDENCE_ORDER: EvidenceKind[] = ["rule", "item", "context", "action"];

/**
 * Read a request word by word. Places come out first (with Shona prefixes: "kuBudiriro"). Then each
 * word or phrase is looked up as written, as an English word form, through Shona prefixes and verb
 * roots, and finally as a likely misspelling. Actions are applied to the things they're about, the
 * products and services named decide the category, and weak words only narrow or fill in.
 */
export function readRequest(text: string, ctx: ReadContext): Reading {
  const { lexicon, gazetteer, taxonomy } = ctx;
  const norm = normalizeMessage(text);
  const all = norm ? norm.split(" ") : [];
  // The most specific place is where they are; others ("Hillside, Bulawayo") are known words too.
  const places = gazetteer?.locateAll(all) ?? [];
  const placeAt = new Map(places.map((p) => [p.start, p]));

  const words: ReadWord[] = [];
  for (let i = 0; i < all.length; ) {
    const place = placeAt.get(i);
    if (place) {
      words.push({ text: all.slice(place.start, place.end).join(" "), key: "", kind: "place", senses: [] });
      i = place.end;
      continue;
    }
    const nextPlace = places.filter((p) => p.start > i).reduce((min, p) => Math.min(min, p.start), all.length);
    const phrase = lexicon.phraseAt(all, i, nextPlace);
    if (phrase) {
      words.push(recognised(all.slice(i, i + phrase.words.length).join(" "), phrase.words.join(" "), phrase.senses, "exact"));
      i += phrase.words.length;
      continue;
    }
    words.push(readWord(all[i]!, lexicon));
    i++;
  }

  // A misspelt place ("Mabelrein"), among the words nothing else explains.
  const notes: string[] = [];
  let area = places[0]?.area;
  if (!area && gazetteer) {
    for (const w of words) {
      const guess = w.kind === "unknown" ? gazetteer.closest(w.text) : undefined;
      if (!guess) continue;
      area = guess;
      w.kind = "place";
      notes.push(`place "${w.text}" read as ${guess.name}`);
      break;
    }
  }

  const meaning = words.filter((w) => w.kind === "meaning");
  const evidence: Evidence[] = [];

  // 1. Actions applied to things: "anogadzira" (repairs) + fridge is appliance repairs.
  const usedAsAction = new Set<ReadWord>();
  const usedAsObject = new Set<ReadWord>();
  for (const a of meaning) {
    for (const act of actionsOf(a)) {
      for (const o of meaning) {
        if (o === a) continue;
        for (const family of familiesOf(o)) {
          const category = RULES[act][family];
          if (!category) continue;
          evidence.push({ categories: [category], kind: "rule", words: [a, o] });
          usedAsAction.add(a);
          usedAsObject.add(o);
        }
      }
    }
  }

  // 2. Words naming what's wanted. A word that is also an action may mean either: "paint" is paint or painters.
  // A word that only describes another ("nyama yemombe": meat of cattle) counts only if nothing else is named.
  const heads = meaning.filter((w) => !w.describes && !usedAsObject.has(w) && hasRole(w, STRONG_ROLES));
  const describing = (w: ReadWord) => !!w.describes && heads.length > 0;
  for (const w of meaning) {
    if (usedAsAction.has(w) || usedAsObject.has(w) || describing(w)) continue;
    const strong = w.senses.filter((s) => STRONG_ROLES.has(s.role));
    if (!strong.length) continue;
    const categories = new Set(strong.flatMap((s) => s.categories));
    for (const act of actionsOf(w)) for (const c of ACTION_DEFAULTS[act]) categories.add(c);
    evidence.push({ categories: [...categories], kind: "item", words: [w] });
  }

  // Weak and describing words narrow words with several meanings: "bhatiri remota" (a battery of
  // the car) is car parts, not solar.
  const weak = meaning.filter((w) => !usedAsObject.has(w) && !describing(w) && !hasRole(w, STRONG_ROLES) && hasRole(w, WEAK_ROLES));
  const contextWords = [...weak, ...meaning.filter((w) => !usedAsObject.has(w) && describing(w))];
  const contexts = (except?: ReadWord): Context[] =>
    contextWords
      .filter((w) => w !== except)
      .flatMap((w) =>
        w.senses.flatMap((s) => {
          const out: Context[] = [];
          if ((WEAK_ROLES.has(s.role) || STRONG_ROLES.has(s.role)) && s.family && FAMILY_CONTEXT[s.family]) {
            out.push({ word: w, categories: FAMILY_CONTEXT[s.family]! });
          }
          if (describing(w) && STRONG_ROLES.has(s.role) && s.categories.length) out.push({ word: w, categories: s.categories });
          return out;
        }),
      );
  for (const e of evidence) if (e.kind === "item") narrow(e, contexts());

  // 3. Nothing stronger: a brand, an occasion or a general word ("mota", a car) decides, weakly.
  if (!evidence.length) {
    for (const w of weak) {
      const e: Evidence = {
        categories: [...new Set(w.senses.filter((s) => WEAK_ROLES.has(s.role)).flatMap((s) => s.categories))],
        kind: "context",
        words: [w],
      };
      narrow(e, contexts(w));
      if (e.categories.length) evidence.push(e);
    }
  }

  // 4. Only an action: "ndoda kusona" (I want to sew) means tailors; "learn" + "drive" means driving schools.
  if (!evidence.length) {
    for (const w of meaning) {
      const categories = [...new Set(actionsOf(w).flatMap((a) => ACTION_DEFAULTS[a]))];
      if (categories.length) evidence.push({ categories, kind: "action", words: [w] });
    }
  }

  // What every part agrees on; failing that, everything any part suggests.
  evidence.sort((a, b) => EVIDENCE_ORDER.indexOf(a.kind) - EVIDENCE_ORDER.indexOf(b.kind));
  let candidates = evidence.reduce<string[] | null>((acc, e) => (acc ? acc.filter((c) => e.categories.includes(c)) : [...e.categories]), null) ?? [];
  if (!candidates.length) candidates = [...new Set(evidence.flatMap((e) => e.categories))];
  const deciding = evidence.filter((e) => e.categories.some((c) => candidates.includes(c)));
  const decidedBy = deciding[0]?.kind ?? "none";
  for (const e of deciding) {
    const why = e.words.map((w) => `"${w.text}"`).join(" + ");
    notes.push(`${e.categories.filter((c) => candidates.includes(c)).join("/")} from ${why}`);
  }

  const doubts = new Set<string>();
  for (const w of deciding.flatMap((e) => e.words)) {
    if (w.via === "spelling") doubts.add(`"${w.text}" read as "${w.key}"`);
    else if (w.senses.some((s) => !s.trusted && s.role !== "filler" && s.role !== "spec")) doubts.add(`"${w.text}" is a draft word nobody has approved yet`);
  }

  const unusedActions =
    decidedBy === "action"
      ? []
      : meaning
          .filter(
            (w) =>
              !usedAsAction.has(w) &&
              !hasRole(w, STRONG_ROLES) &&
              actionsOf(w).some((a) => !SOFT_ACTIONS.has(a)) &&
              !actionsOf(w).some((a) => ACTION_DEFAULTS[a].some((c) => candidates.includes(c))),
          )
          .map((w) => w.text);

  const blocked = meaning
    .flatMap((w) => w.senses.filter((s) => s.role !== "action").flatMap((s) => s.categories))
    .find((c) => taxonomy.get(c)?.risk === "blocked");
  // A business that sells what it repairs ("we sell and fix phones") is listed under both.
  // Spelling guesses don't count here: an owner's words are confirmed anyway.
  const selling = meaning.some((w) => actionsOf(w).includes("buy"));
  const sure = evidence.filter((e) => !e.words.some((w) => w.via === "spelling"));
  const mentioned = [
    ...new Set([
      ...candidates.filter((c) => sure.some((e) => e.categories.includes(c))),
      ...sure.flatMap((e) => e.categories),
      ...(selling ? [...usedAsObject].flatMap((w) => w.senses.filter((s) => STRONG_ROLES.has(s.role)).flatMap((s) => s.categories)) : []),
    ]),
  ];

  // Shona or Ndebele, by which has more of its own words (and giveaway words like "ndoda" or "ngifuna").
  const score = { sn: SHONA_HINT.test(norm) ? 1 : 0, nd: NDEBELE_HINT.test(norm) ? 1 : 0 };
  for (const w of words) {
    const langs = new Set(
      w.senses
        .filter((s) => s.language !== "en" && (!["filler", "spec"].includes(s.role) || (w.text.length > 3 && !isStopword(w.text))))
        .map((s) => s.language as "sn" | "nd"),
    );
    if (w.via === "shona") langs.add("sn");
    if (w.via === "ndebele") langs.add("nd");
    if (langs.size === 1) for (const l of langs) score[l]++;
  }
  const language = score.nd > score.sn ? "nd" : score.sn > 0 ? "sn" : "en";

  const query = words
    .filter((w) => w.kind === "unknown" || w.kind === "number" || (w.kind === "meaning" && !onlyBuying(w)))
    .map((w) => w.text)
    .join(" ")
    .split(" ")
    .slice(0, 8)
    .join(" ");

  return {
    words,
    area,
    candidates,
    decidedBy,
    blocked,
    mentioned,
    unknown: words.filter((w) => w.kind === "unknown").map((w) => w.text),
    doubts: [...doubts],
    unusedActions,
    language,
    query,
    notes,
  };
}

/**
 * The phrasebook key for a reading: its content words in dictionary form, sorted, without places,
 * numbers or details. "ndoda keke remuchato ku Budiriro" → "keke muchato". Phrases keep together
 * as one word ("honda_fit").
 */
export function signatureOf(reading: Reading): string | null {
  const keys = reading.words
    .filter((w) => w.kind === "unknown" || (w.kind === "meaning" && !w.senses.every((s) => s.role === "spec")))
    .map((w) => w.key.replace(/ /g, "_"));
  return keys.length ? [...new Set(keys)].sort().join(" ") : null;
}

function readWord(word: string, lexicon: Lexicon): ReadWord {
  if (/^\d+(?:\.\d+)?$/.test(word)) return { text: word, key: word, kind: "number", senses: [] };
  const exact = lexicon.word(word);
  if (exact) return recognised(word, exact[0]!.term, exact, "exact");
  if (word.length < 2 || isStopword(word)) return { text: word, key: word, kind: "filler", senses: [] };

  // Stretched letters: "pleease", "cakee".
  const squeezed = word.replace(/([a-z])\1+/g, "$1");
  if (squeezed !== word) {
    const senses = lexicon.word(squeezed);
    if (senses) return recognised(word, senses[0]!.term, senses, "form");
    if (isStopword(squeezed)) return { text: word, key: squeezed, kind: "filler", senses: [] };
  }
  for (const base of baseForms(word)) {
    const senses = lexicon.word(base);
    if (senses) return recognised(word, senses[0]!.term, senses, "form");
  }

  // Shona: a joining prefix ("remuchato"), the plural ma- on a borrowed word ("matyres"), a verb root ("anogadzira").
  const plural = withoutPlural(word);
  for (const { stem, describes } of [...withoutJoiner(word), ...(plural ? [{ stem: plural, describes: false }] : [])]) {
    const bare = withoutPlural(stem);
    const senses = lexicon.word(stem) ?? (bare ? lexicon.word(bare) : undefined);
    if (senses) return { ...recognised(word, senses[0]!.term, senses, "shona"), describes };
  }
  // Ndebele: "of"/"and" forms that swallow a vowel ("lomtshado"), e- for places, prefixes on borrowed words ("ifridge").
  for (const { stem, describes } of ndebeleStems(word)) {
    const senses = lexicon.word(stem);
    if (senses) return { ...recognised(word, senses[0]!.term, senses, "ndebele"), describes };
  }
  const root = lexicon.root(word);
  if (root) return recognised(word, root.root, root.senses, root.language === "nd" ? "ndebele" : "shona");
  const loose = lexicon.looseMatch(word);
  if (loose) return recognised(word, loose[0]!.term, loose, "shona");

  const guess = lexicon.closest(word);
  if (guess) return recognised(word, guess.term, guess.senses, "spelling");
  return { text: word, key: word, kind: "unknown", senses: [] };
}

function recognised(text: string, key: string, senses: Sense[], via: ReadWord["via"]): ReadWord {
  return { text, key, kind: senses.every((s) => s.role === "filler") ? "filler" : "meaning", senses, via };
}

function hasRole(w: ReadWord, roles: ReadonlySet<Role>): boolean {
  return w.senses.some((s) => roles.has(s.role));
}

function actionsOf(w: ReadWord): Action[] {
  return [...new Set(w.senses.flatMap((s) => (s.role === "action" && s.action ? [s.action] : [])))];
}

/** The kinds of thing a word names, for the action rules. */
function familiesOf(w: ReadWord): Family[] {
  return [...new Set(w.senses.flatMap((s) => (s.family && (STRONG_ROLES.has(s.role) || WEAK_ROLES.has(s.role)) ? [s.family] : [])))];
}

/** "buy", "sell", "kutenga": they don't belong in the search words. */
function onlyBuying(w: ReadWord): boolean {
  return w.senses.every((s) => s.role === "filler" || (s.role === "action" && s.action === "buy"));
}

/** Categories a weak or describing word points towards, to narrow others with. */
interface Context {
  word: ReadWord;
  categories: string[];
}

/**
 * Keep the categories a context agrees with, when it agrees with some but not all. A word that
 * narrowed the result helped decide it, so a draft or misspelt one casts doubt too.
 */
function narrow(e: Evidence, contexts: Context[]): void {
  for (const context of contexts) {
    const kept = e.categories.filter((c) => context.categories.includes(c));
    if (!kept.length || kept.length === e.categories.length) continue;
    e.categories = kept;
    if (!e.words.includes(context.word)) e.words.push(context.word);
  }
}
