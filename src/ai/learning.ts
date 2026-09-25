import type { Db } from "../db/client.js";
import type { Gazetteer } from "../directory/gazetteer.js";
import type { Taxonomy } from "../directory/taxonomy.js";
import { isStopword, normalizeText } from "../text.js";
import { WordShapeClassifier } from "./classifier.js";
import { STRONG_ROLES, WEAK_ROLES, type Lexicon } from "./lexicon.js";
import { readRequest, signatureOf } from "./reading.js";

export interface TrainingSources {
  taxonomy: Taxonomy;
  lexicon: Lexicon;
  gazetteer?: Gazetteer;
  /** Adds what people taught: the phrasebook (the team, customers' picks, Claude) and the team's labels. */
  db?: Db;
}

/**
 * Train the word-shape classifier on every single word whose category we know: category words and
 * lexicon words (drafts included: the classifier only suggests), and the words in the phrasebook's
 * wordings and the team's labels. Words only known as part of a phrase are left out ("machine" in
 * "washing machine" says nothing on its own), and so are place names, so "Mabelreign" doesn't come
 * to mean plumbing. Only searchable categories are learnt: it never suggests a blocked one.
 */
export async function trainClassifier(src: TrainingSources): Promise<WordShapeClassifier> {
  const searchable = new Set(src.taxonomy.searchable().map((c) => c.slug));
  const placeWords = new Set(
    (src.gazetteer?.areas ?? []).flatMap((a) => [a.name, ...a.aliases].flatMap((n) => normalizeText(n).split(" "))),
  );
  const examples: { words: string[]; category: string }[] = [];
  /** Keys are single words, or phrases joined by "_" (skipped: the rules already know them). */
  const add = (keys: string[], category: string | null) => {
    if (!category || !searchable.has(category)) return;
    const words = keys.filter((w) => w.length >= 3 && !w.includes("_") && !/^\d/.test(w) && !isStopword(w) && !placeWords.has(w));
    if (words.length) examples.push({ words, category });
  };
  const single = (term: string) => {
    const t = normalizeText(term);
    return t && !t.includes(" ") ? [t] : [];
  };

  for (const c of src.taxonomy.searchable()) for (const term of [c.name, ...c.synonyms]) add(single(term), c.slug);
  for (const e of src.lexicon.entries) {
    if (e.root || e.status === "rejected" || !(STRONG_ROLES.has(e.role) || WEAK_ROLES.has(e.role))) continue;
    for (const category of e.categories) add(single(e.term), category);
  }
  if (src.db) {
    const phrases = await src.db.query<{ signature: string; category_slug: string }>(
      "SELECT signature, category_slug FROM phrasebook WHERE category_slug IS NOT NULL AND intent = 'search'",
    );
    for (const p of phrases) add(p.signature.split(" "), p.category_slug);
    const labels = await src.db.query<{ raw_text: string; category_slug: string }>(
      `SELECT r.raw_text, l.category_slug FROM request_labels l JOIN requests r ON r.id = l.request_id
        WHERE l.intent = 'search' AND l.category_slug IS NOT NULL AND r.raw_text <> '' AND left(r.raw_text, 1) <> '📷'`,
    );
    for (const l of labels) {
      const signature = signatureOf(readRequest(l.raw_text, { taxonomy: src.taxonomy, gazetteer: src.gazetteer, lexicon: src.lexicon }));
      add(signature ? signature.split(" ") : [], l.category_slug);
    }
  }
  return WordShapeClassifier.train(examples);
}
