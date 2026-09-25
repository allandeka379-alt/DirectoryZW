import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { remember, signatureOf } from "../ai/phrasebook.js";
import type { RequestInterpretation } from "../ai/types.js";
import type { App } from "../app.js";
import { one } from "../db/client.js";
import { isUuid } from "../directory/businesses.js";
import { logAction } from "../ops/accounts.js";
import { actorOf } from "./ops-auth.js";

/** About this many labelled real requests are enough to tune the thresholds and choose Claude's model. */
export const LABEL_TARGET = 300;

const Id = z.object({ id: z.string().refine(isUuid, "Not a valid ID") });
const INTENTS = ["search", "greeting", "help", "human", "out_of_scope", "blocked", "unclear"] as const;

/**
 * Labelling real requests (Phase 3): the team says what customers actually wanted, for a random
 * sample. The labels are the answer key for `npm run eval` (tuning thresholds, choosing Claude's
 * model), they show how often each step of the ladder gets it right, and a correction also
 * teaches the phrasebook.
 */
export function registerLabelRoutes(ops: FastifyInstance, app: App): void {
  // A random batch of real requests nobody has labelled yet, with what the assistant made of them.
  ops.get("/labels/next", async (req) => {
    const q = req.query as { days?: string; limit?: string };
    const days = Math.min(Math.max(Number(q.days) || 90, 1), 365);
    const limit = Math.min(Math.max(Number(q.limit) || 20, 1), 100);
    const [requests, progress] = await Promise.all([
      app.db.query(
        `SELECT r.id, r.raw_text, r.category_slug, c.name AS category_name, r.understood_by, r.reading->>'band' AS band,
                r.interpretation->>'intent' AS intent, r.interpretation->>'language' AS language, a.name AS area, r.created_at
           FROM requests r
           LEFT JOIN categories c ON c.slug = r.category_slug
           LEFT JOIN areas a ON a.id = r.area_id
          WHERE r.raw_text <> '' AND left(r.raw_text, 1) <> '📷'
            AND r.created_at > now() - make_interval(days => $1)
            AND NOT EXISTS (SELECT 1 FROM request_labels l WHERE l.request_id = r.id)
          ORDER BY random() LIMIT $2`,
        [days, limit],
      ),
      one<{ labelled: number }>(app.db, "SELECT count(*)::int AS labelled FROM request_labels"),
    ]);
    return { target: LABEL_TARGET, labelled: progress?.labelled ?? 0, requests };
  });

  ops.post("/requests/:id/label", async (req, reply) => {
    const params = Id.safeParse(req.params);
    const body = z.object({ intent: z.enum(INTENTS), category: z.string().nullable().optional() }).safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "Give a request ID and what they wanted" });
    const { intent } = body.data;
    const category = body.data.category ? app.services.taxonomy.get(body.data.category) : undefined;
    if (body.data.category && !category) return reply.code(400).send({ error: "There's no such category" });
    const request = await one<{ id: string; raw_text: string; category_slug: string | null; interpretation: RequestInterpretation }>(
      app.db,
      "SELECT id, raw_text, category_slug, interpretation FROM requests WHERE id = $1",
      [params.data.id],
    );
    if (!request) return reply.code(404).send({ error: "Request not found" });
    const actor = actorOf(req);
    await app.db.query(
      `INSERT INTO request_labels (request_id, intent, category_slug, labelled_by) VALUES ($1, $2, $3, $4)
       ON CONFLICT (request_id) DO UPDATE SET intent = excluded.intent, category_slug = excluded.category_slug,
         labelled_by = excluded.labelled_by, created_at = now()`,
      [request.id, intent, intent === "search" || intent === "blocked" ? (category?.slug ?? null) : null, actor.name],
    );
    // A correction teaches the phrasebook, so this wording is read right from now on.
    const corrected = intent === "search" && category && category.slug !== request.category_slug && request.raw_text && !request.raw_text.startsWith("📷");
    if (corrected) {
      const { keywords, taxonomy, gazetteer, lexicon } = app.services;
      const signature = signatureOf(keywords.read(request.raw_text, { taxonomy, gazetteer, lexicon }));
      if (signature) {
        await remember(app.db, signature, { ...request.interpretation, intent: "search", category_slug: category.slug, clarifying_question: null }, "team");
      }
    }
    await logAction(app.db, actor, "request.label", request.id, { intent, category: category?.slug ?? null });
    return { ok: true, corrected: !!corrected };
  });

  // How often each step of the ladder got it right, on the labelled requests.
  ops.get("/labels/summary", async () => {
    const rows = await app.db.query<{ by: string | null; labelled: number; right: number }>(
      `SELECT r.understood_by AS by, count(*)::int AS labelled,
              count(*) FILTER (WHERE
                (l.intent = 'search' AND r.interpretation->>'intent' = 'search' AND l.category_slug IS NOT DISTINCT FROM r.category_slug)
                OR (l.intent <> 'search' AND l.intent = r.interpretation->>'intent'))::int AS right
         FROM request_labels l JOIN requests r ON r.id = l.request_id
        GROUP BY 1 ORDER BY 2 DESC`,
    );
    const labelled = rows.reduce((t, r) => t + r.labelled, 0);
    const right = rows.reduce((t, r) => t + r.right, 0);
    return { target: LABEL_TARGET, labelled, right, byStep: rows };
  });
}
