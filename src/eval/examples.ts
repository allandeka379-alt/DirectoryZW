import type { Db } from "../db/client.js";
import type { EvalExample } from "./score.js";

/**
 * Real requests as eval examples. Those the team labelled (ops console: Label requests) carry the
 * label and count as reviewed; the rest carry what the app decided at the time, for someone to check.
 * Photo requests are left out: their words are our description of the photo.
 */
export async function realExamples(db: Db, opts: { labelled: boolean; days: number; limit: number }): Promise<EvalExample[]> {
  const rows = await db.query<{
    id: string;
    raw_text: string;
    interpretation: { intent?: string; language?: string };
    category_slug: string | null;
    area: string | null;
    label_intent: string | null;
    label_category: string | null;
  }>(
    `SELECT r.id, r.raw_text, r.interpretation, r.category_slug, a.name AS area,
            l.intent AS label_intent, l.category_slug AS label_category
       FROM requests r
       LEFT JOIN areas a ON a.id = r.area_id
       LEFT JOIN request_labels l ON l.request_id = r.id
      WHERE r.raw_text <> '' AND left(r.raw_text, 1) <> '📷'
        AND ($3 OR r.created_at > now() - make_interval(days => $1))
        AND (NOT $3 OR l.request_id IS NOT NULL)
      ORDER BY random() LIMIT $2`,
    [opts.days, opts.labelled ? 100_000 : opts.limit, opts.labelled],
  );
  return rows.map((r): EvalExample => {
    const id = `real-${r.id.slice(0, 8)}`;
    const language = r.interpretation.language ?? "en";
    // The team's label is the answer. It doesn't cover the place, so the area isn't scored.
    if (r.label_intent) return { id, text: r.raw_text, language, expect: { intent: r.label_intent, category: r.label_category }, source: "real", reviewed: true };
    return {
      id,
      text: r.raw_text,
      language,
      expect: { intent: r.interpretation.intent ?? "search", category: r.category_slug, ...(r.area ? { area: r.area } : {}) },
      source: "real",
      reviewed: false,
    };
  });
}
