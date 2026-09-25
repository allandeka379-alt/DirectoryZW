import { isStopword, normalizeMessage } from "../text.js";

/** A category the words look like: how similar the closest known word is (0 to 1), and which word. */
export interface Guess {
  category: string;
  score: number;
  like: string;
}

/** Letter sequences of 3 to 5 characters, with the word's start and end marked: "tyre" → "<ty", "tyr", "yre", "re>", "<tyr"… */
export function shapesOf(word: string): string[] {
  const w = `<${word}>`;
  const out: string[] = [];
  for (let n = 3; n <= 5; n++) for (let i = 0; i + n <= w.length; i++) out.push(w.slice(i, i + n));
  return out;
}

/** The words worth learning from, or guessing on: no fillers, numbers or very short words. */
export function contentWords(text: string): string[] {
  return normalizeMessage(text)
    .split(" ")
    .filter((w) => w.length >= 3 && !/^\d/.test(w) && !isStopword(w));
}

interface KnownWord {
  word: string;
  categories: Set<string>;
  shapes: Set<string>;
  weight: number;
}

/** Letter patterns found in more known words than this say nothing about which word it is. */
const COMMON = 150;

/**
 * A second opinion for words the rules don't know, such as misspellings beyond one letter
 * ("fotographer", "boreholl"). It finds the known word most like each one, by shared letter
 * patterns (rare patterns count more), among words of about the same length, so "controller"
 * isn't taken for "control". Its categories are the guess. It learns every word whose category is
 * known: category words, the lexicon, the phrasebook and the team's labels (see learning.ts).
 *
 * It only ever suggests: its guesses become "Did you mean…?" options, never a straight answer.
 */
export class WordShapeClassifier {
  private constructor(
    private readonly known: KnownWord[],
    private readonly index: Map<string, number[]>,
    private readonly rarity: Map<string, number>,
    private readonly maxRarity: number,
    readonly size: number,
  ) {}

  static train(examples: { words: string[]; category: string }[]): WordShapeClassifier {
    const byWord = new Map<string, Set<string>>();
    for (const { words, category } of examples) {
      for (const word of words) byWord.set(word, (byWord.get(word) ?? new Set()).add(category));
    }
    const words = [...byWord].map(([word, categories]) => ({ word, categories, shapes: new Set(shapesOf(word)) }));
    const seenIn = new Map<string, number>();
    for (const w of words) for (const s of w.shapes) seenIn.set(s, (seenIn.get(s) ?? 0) + 1);
    const rarity = new Map([...seenIn].map(([s, n]) => [s, Math.log((words.length + 1) / (n + 1)) + 1]));
    const maxRarity = Math.log(words.length + 1) + 1;
    const known = words.map((w) => ({ ...w, weight: [...w.shapes].reduce((t, s) => t + rarity.get(s)!, 0) }));
    const index = new Map<string, number[]>();
    known.forEach((w, i) => {
      for (const s of w.shapes) if (seenIn.get(s)! <= COMMON) index.set(s, [...(index.get(s) ?? []), i]);
    });
    const categories = new Set(examples.map((e) => e.category));
    return new WordShapeClassifier(known, index, rarity, maxRarity, categories.size);
  }

  /** Categories the words look like, best first; for each, the closest known word and how close. */
  guess(words: string[]): Guess[] {
    const best = new Map<string, Guess>();
    for (const word of words) {
      if (word.length < 4) continue;
      const shapes = new Set(shapesOf(word));
      const weightOf = (s: string) => this.rarity.get(s) ?? this.maxRarity;
      const mine = [...shapes].reduce((t, s) => t + weightOf(s), 0);
      const candidates = new Set([...shapes].flatMap((s) => this.index.get(s) ?? []));
      for (const i of candidates) {
        const other = this.known[i]!;
        const ratio = word.length / other.word.length;
        if (ratio < 0.75 || ratio > 1.34) continue;
        let shared = 0;
        for (const s of shapes) if (other.shapes.has(s)) shared += weightOf(s);
        const score = (2 * shared) / (mine + other.weight);
        for (const category of other.categories) {
          const prev = best.get(category);
          if (!prev || score > prev.score) best.set(category, { category, score, like: other.word });
        }
      }
    }
    return [...best.values()].sort((a, b) => b.score - a.score);
  }
}
