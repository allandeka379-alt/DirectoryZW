/**
 * Ndebele word shapes, so a word the engine knows is still recognised in a sentence:
 * - nouns carry a prefix: "ifriji" (a fridge), "amathende" (tents), "isitulo/izitulo" (chair/chairs)
 * - "of" and "and" join words and swallow the next word's first vowel: "ikhekhe lomtshado" is
 *   la + umtshado (cake of a wedding); "inyama yenkomo" is ya + inkomo (meat of cattle)
 * - places take e- (at, in) and sometimes -ini: "eNkulumane", "emtshadweni" (at the wedding)
 * - verbs have prefixes and endings around a root: "olungisa" (who repairs), "ukuqasha" (to hire),
 *   "umthengisi" (a seller)
 *
 * As with Shona (shona.ts), a split only counts when what's left is a word or root in the lexicon.
 * Written from Ndebele grammar by the development team; native speakers should check it.
 */

/** A shorter form of a word to look up, and whether it describes another word ("yenkomo", of cattle). */
export interface Stem {
  stem: string;
  describes: boolean;
}

/** The consonant part of "of" (and "and") forms: ya-, wa-, la-, sa-, za-, ba-, kwa-, lwa-… */
const JOIN_CONSONANTS = ["kw", "lw", "w", "y", "l", "s", "z", "b", "k", ""];

/** A joining vowel stands for the swallowed first vowel of the next word: o for u, e for i, a for a. */
const RESTORE: Record<string, string> = { o: "u", e: "i", a: "a" };

/** Borrowed and everyday nouns with their prefix attached: "ifridge", "amatyres", "umechanic". */
const NOUN_PREFIXES = ["izin", "ama", "aba", "isi", "izi", "imi", "umu", "um", "i", "u"];

/**
 * Shorter forms of a word to look up:
 * - without "of"/"and" and with the swallowed vowel back: "lomtshado" → umtshado, "yenkomo" → inkomo
 * - without "e-" (at) and "-ini": "esitolo" → isitolo, "emtshadweni" → umtshado
 * - without a noun prefix on a borrowed word: "ifridge" → fridge, "amatyres" → tyres
 * "La-", "le-" and "lo-" also mean "and", so those words don't count as only describing.
 */
export function ndebeleStems(word: string): Stem[] {
  const out: Stem[] = [];
  const add = (stem: string, describes: boolean) => {
    if (stem.length >= 3 && !out.some((s) => s.stem === stem)) out.push({ stem, describes });
  };
  for (const c of JOIN_CONSONANTS) {
    for (const [vowel, restored] of Object.entries(RESTORE)) {
      const joiner = c + vowel;
      if (!word.startsWith(joiner) || word.length - joiner.length < 3) continue;
      const rest = word.slice(joiner.length);
      add(restored + rest, c !== "l");
      // Locative e- + noun + -ini: "emtshadweni" → umtshado, "edolobheni" → idolobha.
      if (joiner === "e") for (const noun of withoutIni(rest)) for (const augment of ["u", "i", "a"]) add(augment + noun, true);
    }
  }
  for (const prefix of NOUN_PREFIXES) {
    const rest = word.slice(prefix.length);
    if (word.startsWith(prefix) && rest.length >= (prefix.length === 1 ? 4 : 3)) add(rest, false);
  }
  return out;
}

/** The noun inside a locative ending: -weni was -o, -wini was -u, -eni was -a or -e, -ini was -i. */
function withoutIni(rest: string): string[] {
  if (rest.endsWith("weni")) return [`${rest.slice(0, -4)}o`];
  if (rest.endsWith("wini")) return [`${rest.slice(0, -4)}u`];
  if (rest.endsWith("eni")) return [`${rest.slice(0, -3)}a`, `${rest.slice(0, -3)}e`];
  if (rest.endsWith("ini")) return [`${rest.slice(0, -3)}i`];
  return [];
}

/**
 * Pieces that come before a verb root: the infinitive (uku-/ukw-), the subject (ngi- I, u- you,
 * u-/a- he or she, si- we, li- you all, ba- they, i-/zi-/ku-… it), "who" (o-, aba-, e-, esi-…),
 * the tense (-ya- now, -za- will, -nga- could, -sa- still), "not" (a-, nga-), the object (-ngi-
 * me, -m-/-mu- him or her, -ba- them…), and um-/aba- for people who do it (umthengisi, a seller).
 */
const VERB_PREFIX_PARTS = [
  "uku", "ukw", "ngi", "ng", "si", "li", "ba", "zi", "ku", "kw", "lu", "bu", "i", "u", "a", "o", "e", "w", "y",
  "aba", "esi", "ezi", "eli", "olu", "obu", "oku", "ya", "za", "nga", "sa", "ka", "m", "mu", "um", "umu",
];

/**
 * What can follow a verb root: extensions (-el- for, -is- make or have done, -w- passive, -ek- can
 * be, -an- each other), the final vowel (a; e for "so that"; i for "not" and for people: umthengisi),
 * then -yo ("who does it": olungisayo) or -ni (you all).
 */
const VERB_ENDING = /^(?:el|is|isis|w|ek|an|elel)*(?:a|e|i)(?:yo|ni)?$/;

const MAX_PREFIX_PARTS = 5;

function isVerbPrefix(s: string, parts = 0): boolean {
  if (!s) return true;
  if (parts >= MAX_PREFIX_PARTS) return false;
  return VERB_PREFIX_PARTS.some((p) => s.startsWith(p) && isVerbPrefix(s.slice(p.length), parts + 1));
}

/**
 * Find a known Ndebele verb root inside a word: "olungisa" → lungis, "ukuqasha" → qash,
 * "umthengisi" → theng. Roots of 4 letters or fewer need a prefix. `roots` longest first.
 */
export function findNdebeleRoot(word: string, roots: readonly string[]): { root: string; prefix: string; ending: string } | undefined {
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

/** Example forms of a verb root, so reviewers can see what it will match. */
export function ndebeleForms(root: string): string[] {
  const vowelFirst = /^[aeiou]/.test(root);
  return [`${vowelFirst ? "ukw" : "uku"}${root}a`, `o${vowelFirst ? "w" : ""}${root}a`, `ngi${root}a`, `${vowelFirst ? "ukw" : "uku"}${root}ela`, `um${root}i`];
}
