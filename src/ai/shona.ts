/**
 * Shona word shapes, so a word the engine knows is still recognised with the prefixes and endings
 * it takes in a sentence:
 * - "keke remuchato" (wedding cake): "re-" joins "muchato" (wedding) to "keke"
 * - "matende nemacheya" (tents and chairs): "ne-" means "and" or "with"
 * - "anogadzira" (who repairs), "kugadzirisa" (to fix): prefixes and endings around the root "gadzir"
 * - "kuMabelreign", "muHarare", "paMbare": to, in and at a place
 *
 * A split only counts when what's left is a word or root in the lexicon, so these lists can be
 * generous. Written from Shona grammar by the development team: native speakers should check
 * them along with the word list.
 */

/**
 * Joining prefixes: "re-", "ye-", "we-", "dze-" (of), "ne-/na-" (and, with), "pa-", "ku-" (at, to).
 * Not "mu-" (in): before a verb it makes a word for a person ("mupendi", a painter), which matters more.
 */
export const JOINERS = [
  "dze", "zve", "rwe", "kwe", "che", "dza", "zva", "rwa", "cha", "kwa",
  "we", "ye", "re", "ne", "na", "no", "se", "sa", "pe", "pa", "me", "wa", "ya", "ra", "za", "ku", "e", "a", "o",
];

/** "Ku-" (to), "kwa-" (at the place of), "mu-" (in), "pa-" (at), and Ndebele "e-"/"ko-". */
export const LOCATIVES = ["kwa", "ku", "ko", "mu", "pa", "e"];

/**
 * Pieces that come before a verb root: a joiner when the verb acts as a noun ("yekuroja", for
 * hire), the subject (ndi- I, u- you, a- he or she, ti- we, mu- you all, va- they, i-/ri-/chi-/zvi-
 * it), the tense (-no- does, -riku- is doing, -cha- will, -ka-/-a- did, -nga- could, ha-/-sa- not)
 * and the object (-ndi- me, -mu- him or her, -va- them…). "ku-" makes the infinitive.
 */
const VERB_PREFIX_PARTS = [
  "dze", "zve", "rwe", "kwe", "che", "we", "ye", "re", "ne", "e",
  "ndi", "nd", "u", "w", "a", "ti", "t", "mu", "va", "v", "i", "ri", "chi", "zvi", "ka", "tu", "ru", "hu", "ku", "kw",
  "no", "riku", "cha", "nga", "ha", "sa", "si",
];

/**
 * What can follow a verb root: extensions (-ir- for, -is-/-es- make or have done, -w- passive,
 * -ik- can be, -an- each other), the final vowel (a, e, or i for people who do it: mugadziri),
 * then "-wo" (please), "-i" (you all) or "-pi" (where).
 */
const VERB_ENDING = /^(?:ir|er|is|es|isis|eses|irir|erer|iw|ew|w|ik|ek|an)*(?:a|e|i)(?:i|wo|yi)?(?:pi|po|ko|mo)?$/;

const MAX_PREFIX_PARTS = 5;

function isVerbPrefix(s: string, parts = 0): boolean {
  if (!s) return true;
  if (parts >= MAX_PREFIX_PARTS) return false;
  return VERB_PREFIX_PARTS.some((p) => s.startsWith(p) && isVerbPrefix(s.slice(p.length), parts + 1));
}

export interface RootMatch {
  root: string;
  prefix: string;
  ending: string;
}

/**
 * Find a known verb root inside a word: "anogadzira" → gadzir, "yekuroja" → roj, "vanotengesa" →
 * teng. Short roots (4 letters or fewer) need a prefix, so "tama" or "wachi" (a watch) don't count.
 * `roots` must be sorted longest first.
 */
export function findRoot(word: string, roots: readonly string[]): RootMatch | undefined {
  for (const root of roots) {
    let at = word.indexOf(root);
    while (at >= 0) {
      const prefix = word.slice(0, at);
      const ending = word.slice(at + root.length);
      if ((prefix || root.length >= 5) && VERB_ENDING.test(ending) && isVerbPrefix(prefix)) return { root, prefix, ending };
      at = word.indexOf(root, at + 1);
    }
  }
  return undefined;
}

/**
 * Joiners that make the word describe another ("of", "at", "like"): "nyama yemombe" is meat (of
 * cattle), not cattle. "ne-", "na-" and "no-" (and, with) join equals: "matende nemacheya".
 */
const DESCRIBING = new Set(JOINERS.filter((j) => !["ne", "na", "no"].includes(j)));

/**
 * The word without a joining prefix, when enough is left: "remuchato" → muchato (describing),
 * "nemacheya" → macheya.
 */
export function withoutJoiner(word: string): { stem: string; describes: boolean }[] {
  return JOINERS.filter((j) => word.startsWith(j) && word.length - j.length >= 3).map((j) => ({
    stem: word.slice(j.length),
    describes: DESCRIBING.has(j),
  }));
}

/** Borrowed nouns take the plural prefix "ma-": "matyres", "maplumber". */
export function withoutPlural(word: string): string | undefined {
  return word.startsWith("ma") && word.length >= 5 ? word.slice(2) : undefined;
}

/**
 * A spelling-tolerant key for Shona words. People often drop the h of bh, dh and vh ("bazi" for
 * "bhazi"), the v of zv and sv ("zigaro" for "zvigaro"), and swap l and r in borrowed words.
 */
export function looseKey(word: string): string {
  return word.replace(/([bdv])h/g, "$1").replace(/([sz])v/g, "$1").replace(/l/g, "r");
}

/** Example forms of a verb root, so reviewers can see what it will match. */
export function exampleForms(root: string): string[] {
  return [`ku${root}a`, `ano${root}a`, `ndino${root}a`, `ku${root}ira`, `mu${root}i`];
}
