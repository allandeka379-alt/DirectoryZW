import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ACTIONS, FAMILIES, LANGUAGES, ROLES, STATUSES, type Lang, type LexiconStatus } from "../ai/lexicon.js";
import { remember, signatureOf } from "../ai/phrasebook.js";
import { exampleForms } from "../ai/shona.js";
import type { RequestInterpretation } from "../ai/types.js";
import type { App } from "../app.js";
import { one } from "../db/client.js";
import { isUuid } from "../directory/businesses.js";
import { logAction } from "../ops/accounts.js";
import { normalizeText } from "../text.js";
import { actorOf } from "./ops-auth.js";

const Id = z.object({ id: z.string().refine(isUuid, "Not a valid ID") });

const WordInput = z.object({
  term: z.string().trim().min(2).max(60),
  language: z.enum(LANGUAGES),
  role: z.enum(ROLES),
  categories: z.array(z.string()).max(3).default([]),
  family: z.enum(FAMILIES).nullable().default(null),
  action: z.enum(ACTIONS).nullable().default(null),
  root: z.boolean().default(false),
  gloss: z.string().trim().max(200).default(""),
});

interface WordRow {
  id: number;
  term: string;
  language: Lang;
  role: string;
  categories: string[];
  family: string | null;
  action: string | null;
  is_root: boolean;
  gloss: string;
  source: string;
  status: LexiconStatus;
  reviewed_by: string | null;
  reviewed_at: Date | null;
  confirmed: number;
}

/**
 * The lexicon (what words mean to the local engine) and the understanding checks:
 * - native speakers review the draft Shona words, and the team adds words
 * - words customers used that the engine doesn't know, with what they turned out to mean
 * - teaching the engine from a handoff, and the weekly check of answers it gave on its own
 */
export function registerWordRoutes(ops: FastifyInstance, app: App): void {
  const listWords = async (q: { language?: string; status?: string; q?: string }) => {
    const language = LANGUAGES.find((l) => l === q.language) ?? "sn";
    const status = STATUSES.find((s) => s === q.status) ?? null;
    const search = normalizeText(q.q ?? "");
    const rows = await app.db.query<WordRow>(
      `SELECT l.id, l.term, l.language, l.role, l.categories, l.family, l.action, l.is_root, l.gloss, l.source, l.status,
              l.reviewed_by, l.reviewed_at,
              -- customers who picked this word's category when we asked "Did you mean…?" about wording with it
              (SELECT count(*)::int FROM clarifications c
                WHERE c.chosen = ANY(l.categories) AND (' ' || c.signature || ' ') LIKE ('% ' || replace(l.term, ' ', '_') || ' %')) AS confirmed
         FROM lexicon l
        WHERE l.language = $1 AND ($2::text IS NULL OR l.status = $2)
          AND ($3 = '' OR l.term LIKE '%' || $3 || '%' OR lower(l.gloss) LIKE '%' || $3 || '%')
        ORDER BY l.status = 'draft' DESC, l.role, l.term
        LIMIT 2000`,
      [language, status, search],
    );
    return rows.map((r) => ({
      ...r,
      category_names: r.categories.map((c) => app.services.taxonomy.get(c)?.name ?? c),
      forms: r.is_root ? exampleForms(r.term) : [],
    }));
  };

  // The word list, drafts first: what each word means to the engine and whether a person has checked it.
  ops.get("/lexicon", async (req) => listWords(req.query as Record<string, string>));

  // A spreadsheet for reviewers who'd rather work offline.
  ops.get("/lexicon/export.csv", async (req, reply) => {
    const q = req.query as Record<string, string>;
    const rows = await listWords({ ...q, status: q.status ?? "" });
    const cell = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const lines = [
      ["ID", "Word", "Role", "Meaning (English)", "Points to", "Action", "Example forms", "Status", "Your correction"],
      ...rows.map((r) => [r.id, r.term, r.is_root ? `${r.role} (verb root)` : r.role, r.gloss, r.category_names.join("; "), r.action ?? "", r.forms.join(", "), r.status, ""]),
    ].map((line) => line.map(cell).join(","));
    const language = LANGUAGES.find((l) => l === q.language) ?? "sn";
    return reply
      .header("Content-Type", "text/csv; charset=utf-8")
      .header("Content-Disposition", `attachment; filename="word-list-${language}.csv"`)
      .send(`﻿${lines.join("\r\n")}\r\n`);
  });

  // Add a word, or change what one means. A person's word counts as approved straight away.
  ops.post("/lexicon", async (req, reply) => {
    const body = WordInput.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues[0]?.message ?? "Check the word" });
    const w = body.data;
    const unknown = w.categories.find((c) => !app.services.taxonomy.get(c));
    if (unknown) return reply.code(400).send({ error: `There's no category "${unknown}"` });
    if (w.role === "action" && !w.action) return reply.code(400).send({ error: "Say which action the word is" });
    if ((w.role === "service" || w.role === "product") && !w.categories.length) {
      return reply.code(400).send({ error: "Pick the category the word points to" });
    }
    const term = w.root ? w.term.toLowerCase().replace(/[^a-z]/g, "") : normalizeText(w.term);
    if (term.length < 2) return reply.code(400).send({ error: "The word is too short" });
    const actor = actorOf(req);
    const row = await one<WordRow>(
      app.db,
      `INSERT INTO lexicon (term, language, role, categories, family, action, is_root, gloss, source, status, reviewed_by, reviewed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'team', 'approved', $9, now())
       ON CONFLICT (term, language, role) DO UPDATE SET categories = excluded.categories, family = excluded.family,
         action = excluded.action, is_root = excluded.is_root, gloss = excluded.gloss, status = 'approved',
         reviewed_by = excluded.reviewed_by, reviewed_at = now()
       RETURNING *`,
      [term, w.language, w.role, w.categories, w.family, w.role === "action" ? w.action : null, w.root, w.gloss, actor.name],
    );
    await app.reloadLexicon();
    await logAction(app.db, actor, "lexicon.save", term, { language: w.language, role: w.role, categories: w.categories, action: w.action });
    return row;
  });

  // Approve, reject or reopen words, one or a page at a time.
  ops.post("/lexicon/review", async (req, reply) => {
    const body = z
      .object({ ids: z.array(z.number().int().positive()).min(1).max(1000), status: z.enum(STATUSES) })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "Give word IDs and a status" });
    const actor = actorOf(req);
    const rows = await app.db.query<{ id: number; term: string }>(
      `UPDATE lexicon SET status = $2, reviewed_by = $3, reviewed_at = now() WHERE id = ANY($1::bigint[]) RETURNING id, term`,
      [body.data.ids, body.data.status, actor.name],
    );
    await app.reloadLexicon();
    await logAction(app.db, actor, `lexicon.${body.data.status}`, null, { words: rows.map((r) => r.term).slice(0, 50), count: rows.length });
    return { updated: rows.length };
  });

  // Words customers used that the engine didn't know, with the categories they turned out to mean
  // (from the phrasebook: people, customers' own picks and Claude). Consistent ones are worth adding.
  ops.get("/vocabulary/suggestions", async () => {
    const { lexicon, taxonomy } = app.services;
    const rows = await app.db.query<{ signature: string; category_slug: string; source: string; hits: number }>(
      "SELECT signature, category_slug, source, hits FROM phrasebook WHERE category_slug IS NOT NULL AND intent = 'search'",
    );
    const words = new Map<string, { uses: number; byCategory: Map<string, number>; examples: string[] }>();
    for (const r of rows) {
      const weight = r.hits + 1;
      for (const word of r.signature.split(" ")) {
        if (lexicon.knows(word) || word.length < 3) continue;
        const entry = words.get(word) ?? { uses: 0, byCategory: new Map<string, number>(), examples: [] };
        entry.uses += weight;
        entry.byCategory.set(r.category_slug, (entry.byCategory.get(r.category_slug) ?? 0) + weight);
        if (entry.examples.length < 3) entry.examples.push(r.signature.replace(/_/g, " "));
        words.set(word, entry);
      }
    }
    return [...words]
      .map(([word, e]) => {
        const [category, count] = [...e.byCategory].sort((a, b) => b[1] - a[1])[0]!;
        return {
          word,
          uses: e.uses,
          category,
          category_name: taxonomy.get(category)?.name ?? category,
          agreement: Math.round((100 * count) / e.uses),
          examples: e.examples,
        };
      })
      .filter((s) => s.uses >= 2)
      .sort((a, b) => b.uses - a.uses || b.agreement - a.agreement)
      .slice(0, 100);
  });

  // What a customer in a handoff actually wanted. Corrects the request, and the phrasebook answers
  // the same wording by itself next time.
  ops.post("/requests/:id/teach", async (req, reply) => {
    const params = Id.safeParse(req.params);
    const body = z.object({ category: z.string() }).safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "Give a request ID and a category" });
    const category = app.services.taxonomy.get(body.data.category);
    if (!category) return reply.code(400).send({ error: "There's no such category" });
    const taught = await teach(params.data.id, category.slug);
    if (!taught) return reply.code(404).send({ error: "Request not found" });
    await logAction(app.db, actorOf(req), "request.teach", params.data.id, { category: category.slug });
    return { ok: true, signature: taught.signature };
  });

  // The weekly check: a random sample of answers the local engine gave on its own.
  ops.get("/review/sample", async (req) => {
    const q = req.query as { days?: string; limit?: string };
    const days = Math.min(Math.max(Number(q.days) || 7, 1), 90);
    const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 200);
    return app.db.query(
      `SELECT r.id, r.raw_text, r.category_slug, c.name AS category_name, a.name AS area, r.reading, r.created_at
         FROM requests r
         JOIN categories c ON c.slug = r.category_slug
         LEFT JOIN areas a ON a.id = r.area_id
        WHERE r.understood_by = 'local' AND r.reading->>'band' = 'high'
          AND r.created_at > now() - make_interval(days => $1)
          AND NOT EXISTS (SELECT 1 FROM understanding_reviews v WHERE v.request_id = r.id)
        ORDER BY random() LIMIT $2`,
      [days, limit],
    );
  });

  ops.post("/requests/:id/review", async (req, reply) => {
    const params = Id.safeParse(req.params);
    const body = z
      .object({ verdict: z.enum(["right", "wrong", "should_ask"]), category: z.string().optional() })
      .safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "Give a request ID and a verdict" });
    const { verdict } = body.data;
    const category = body.data.category ? app.services.taxonomy.get(body.data.category) : undefined;
    if (body.data.category && !category) return reply.code(400).send({ error: "There's no such category" });
    const actor = actorOf(req);
    const saved = await one<{ request_id: string }>(
      app.db,
      `INSERT INTO understanding_reviews (request_id, verdict, category_slug, reviewed_by)
       SELECT id, $2, $3, $4 FROM requests WHERE id = $1
       ON CONFLICT (request_id) DO UPDATE SET verdict = excluded.verdict, category_slug = excluded.category_slug,
         reviewed_by = excluded.reviewed_by, created_at = now()
       RETURNING request_id`,
      [params.data.id, verdict, verdict === "wrong" ? (category?.slug ?? null) : null, actor.name],
    );
    if (!saved) return reply.code(404).send({ error: "Request not found" });
    // A wrong answer with the right category is fixed for that wording straight away.
    if (verdict === "wrong" && category) await teach(params.data.id, category.slug);
    await logAction(app.db, actor, "request.review", params.data.id, { verdict, category: category?.slug });
    return { ok: true };
  });

  /** Set a request's category and remember it for its wording, as a person's answer. */
  async function teach(requestId: string, categorySlug: string): Promise<{ signature: string | null } | undefined> {
    const request = await one<{ id: string; raw_text: string; interpretation: RequestInterpretation }>(
      app.db,
      "SELECT id, raw_text, interpretation FROM requests WHERE id = $1",
      [requestId],
    );
    if (!request) return undefined;
    await app.db.query("UPDATE requests SET category_slug = $2 WHERE id = $1", [request.id, categorySlug]);
    // Photo requests hold our description of the photo, not the customer's words.
    if (request.raw_text.startsWith("📷")) return { signature: null };
    const { keywords, taxonomy, gazetteer, lexicon } = app.services;
    const signature = signatureOf(keywords.read(request.raw_text, { taxonomy, gazetteer, lexicon }));
    if (signature) {
      const interpretation: RequestInterpretation = { ...request.interpretation, intent: "search", category_slug: categorySlug, clarifying_question: null };
      await remember(app.db, signature, interpretation, "team");
    }
    return { signature };
  }
}
