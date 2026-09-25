import type { Db } from "../db/client.js";
import { one } from "../db/client.js";
import type { RequestInterpretation } from "./types.js";

export { signatureOf } from "./reading.js";

export type PhraseSource = "claude" | "customer" | "team";

export interface PhraseEntry {
  signature: string;
  intent: RequestInterpretation["intent"];
  category_slug: string | null;
  query: string;
  language: string | null;
  source: PhraseSource;
  hits: number;
}

/** A previous answer for this wording, if any. */
export async function lookup(db: Db, signature: string): Promise<PhraseEntry | undefined> {
  return one<PhraseEntry>(db, "SELECT * FROM phrasebook WHERE signature = $1", [signature]);
}

/** Count a reuse of a remembered answer. */
export async function markUsed(db: Db, signature: string): Promise<void> {
  await db.query("UPDATE phrasebook SET hits = hits + 1, last_used_at = now() WHERE signature = $1", [signature]);
}

/**
 * Keep an answer for next time. A person's answer outranks a customer's tap, which outranks
 * Claude's; a lower-ranked source never overwrites a higher one.
 */
export async function remember(db: Db, signature: string, i: RequestInterpretation, source: PhraseSource): Promise<void> {
  if (i.intent === "unclear" || i.intent === "human" || i.clarifying_question) return;
  if (i.intent === "search" && !i.category_slug) return;
  await db.query(
    `INSERT INTO phrasebook (signature, intent, category_slug, query, language, source)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (signature) DO UPDATE SET intent = excluded.intent, category_slug = excluded.category_slug,
       query = excluded.query, language = excluded.language, source = excluded.source
     WHERE ${rank("excluded.source")} >= ${rank("phrasebook.source")}`,
    [signature, i.intent, i.category_slug, i.query.slice(0, 80), i.language, source],
  );
}

function rank(column: string): string {
  return `CASE ${column} WHEN 'team' THEN 3 WHEN 'customer' THEN 2 ELSE 1 END`;
}

/** The remembered meaning, with this message's own place, budget and timing. */
export function fromPhrasebook(entry: PhraseEntry, local: RequestInterpretation): RequestInterpretation {
  return {
    ...local,
    intent: entry.intent,
    category_slug: entry.category_slug,
    query: entry.query || local.query,
    language: (entry.language as RequestInterpretation["language"] | null) ?? local.language,
    clarifying_question: null,
  };
}
