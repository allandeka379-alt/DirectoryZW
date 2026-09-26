import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { App } from "../app.js";
import { one } from "../db/client.js";
import { getBusiness, isUuid } from "../directory/businesses.js";
import { logAction } from "../ops/accounts.js";
import { eraseBusiness, eraseContact, exportContact } from "../privacy.js";
import { normalizeZimPhone } from "../text.js";
import { harareStartOfDay } from "../time.js";
import { STARTED_AT, VERSION } from "../version.js";
import { actorOf, refuseUnlessAdmin } from "./ops-auth.js";

const Id = z.object({ id: z.string().refine(isUuid, "Not a valid ID") });

/** People (find a number, block it, export or delete their data) and the system status page. */
export function registerAdminRoutes(ops: FastifyInstance, app: App): void {
  // Everyone we've talked to on either number, found by phone number.
  ops.get("/contacts", async (req, reply) => {
    const raw = String((req.query as { phone?: string }).phone ?? "");
    const phone = normalizeZimPhone(raw) ?? raw.replace(/\D/g, "");
    if (phone.length < 7) return reply.code(400).send({ error: "Give a phone number" });
    return app.db.query(
      `SELECT c.id, c.channel, c.wa_id, c.phone, c.profile_name, c.consent_at, c.last_inbound_at, c.is_blocked,
              c.blocked_reason, c.created_at,
              (SELECT count(*)::int FROM messages m WHERE m.contact_id = c.id) AS messages,
              (SELECT count(*)::int FROM requests r WHERE r.contact_id = c.id) AS requests,
              (SELECT count(*)::int FROM businesses b WHERE b.owner_contact_id = c.id AND b.status <> 'removed') AS businesses
         FROM contacts c
        WHERE c.wa_id = $1 OR c.phone = $1
        ORDER BY c.channel`,
      [phone],
    );
  });

  ops.post("/contacts/:id/block", async (req, reply) => {
    const params = Id.safeParse(req.params);
    const body = z.object({ blocked: z.boolean(), reason: z.string().max(300).optional() }).safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "Give a contact ID and blocked true/false" });
    const rows = await app.db.query("UPDATE contacts SET is_blocked = $2, blocked_reason = $3 WHERE id = $1 RETURNING id", [
      params.data.id,
      body.data.blocked,
      body.data.blocked ? (body.data.reason ?? null) : null,
    ]);
    if (!rows.length) return reply.code(404).send({ error: "Contact not found" });
    await logAction(app.db, actorOf(req), body.data.blocked ? "contact.block" : "contact.unblock", params.data.id);
    return { ok: true };
  });

  // A copy of everything held about someone, for a data request.
  ops.get("/contacts/:id/export", async (req, reply) => {
    if (refuseUnlessAdmin(req, reply)) return;
    const params = Id.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "Not a valid ID" });
    const data = await exportContact(app.db, params.data.id);
    if (!data) return reply.code(404).send({ error: "Contact not found" });
    await logAction(app.db, actorOf(req), "contact.export", params.data.id);
    return reply.header("Content-Disposition", `attachment; filename="contact-${params.data.id}.json"`).send(data);
  });

  ops.post("/contacts/:id/erase", async (req, reply) => {
    if (refuseUnlessAdmin(req, reply)) return;
    const params = Id.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "Not a valid ID" });
    const result = await eraseContact(app.db, params.data.id);
    if (!result) return reply.code(404).send({ error: "Contact not found" });
    await logAction(app.db, actorOf(req), "contact.erase", params.data.id, result);
    return { ok: true, ...result };
  });

  // Delete a listing completely (the owner asked us to forget them). "Remove" only hides it.
  ops.post("/businesses/:id/erase", async (req, reply) => {
    if (refuseUnlessAdmin(req, reply)) return;
    const params = Id.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "Not a valid ID" });
    const business = await getBusiness(app.db, params.data.id);
    if (!business) return reply.code(404).send({ error: "Business not found" });
    await eraseBusiness(app.db, app.store, business.id);
    await logAction(app.db, actorOf(req), "business.erase", business.id);
    return { ok: true };
  });

  // Is everything working? Queues, failed sends, what's switched on, Claude spend, recent alerts.
  ops.get("/system", async () => {
    const { services, config } = app;
    const now = services.now();
    const [claudeToday, claudeWeek, understood, matched, questions, precision, words, targets] = await Promise.all([
      app.db.query<{ feature: string; calls: number; usd: number }>(
        `SELECT feature, count(*)::int AS calls, COALESCE(sum(cost_usd), 0)::float8 AS usd
           FROM ai_usage WHERE created_at >= $1 GROUP BY feature ORDER BY feature`,
        [harareStartOfDay(now)],
      ),
      one<{ calls: number; usd: number }>(
        app.db,
        "SELECT count(*)::int AS calls, COALESCE(sum(cost_usd), 0)::float8 AS usd FROM ai_usage WHERE created_at >= $1",
        [new Date(now.getTime() - 7 * 24 * 3600_000)],
      ),
      // How requests were understood over the last week: locally, from the phrasebook, by Claude, or not at all.
      app.db.query<{ by: string; requests: number }>(
        `SELECT understood_by AS by, count(*)::int AS requests FROM requests
          WHERE understood_by IS NOT NULL AND created_at > now() - interval '7 days' GROUP BY 1 ORDER BY 2 DESC`,
      ),
      // Whether they found suppliers in their own category, only related ones, or went to a person.
      app.db.query<{ match: string; requests: number }>(
        `SELECT match, count(*)::int AS requests FROM requests
          WHERE match IS NOT NULL AND created_at > now() - interval '7 days' GROUP BY 1 ORDER BY 2 DESC`,
      ),
      // "Did you mean…?" questions this week, and what customers did with them.
      one<{ asked: number; picked: number; something_else: number; flagged: number }>(
        app.db,
        `SELECT count(*)::int AS asked,
                count(*) FILTER (WHERE chosen IS NOT NULL AND chosen <> 'other')::int AS picked,
                count(*) FILTER (WHERE chosen = 'other')::int AS something_else,
                -- requests customers said we got wrong
                (SELECT count(*)::int FROM requests WHERE flagged_at > now() - interval '7 days') AS flagged
           FROM clarifications WHERE created_at > now() - interval '7 days'`,
      ),
      // The weekly check of answers the engine gave on its own, over four weeks.
      one<{ reviewed: number; right: number; wrong: number; should_ask: number }>(
        app.db,
        `SELECT count(*)::int AS reviewed,
                count(*) FILTER (WHERE verdict = 'right')::int AS right,
                count(*) FILTER (WHERE verdict = 'wrong')::int AS wrong,
                count(*) FILTER (WHERE verdict = 'should_ask')::int AS should_ask
           FROM understanding_reviews WHERE created_at > now() - interval '28 days'`,
      ),
      app.db.query<{ language: string; status: string; words: number }>(
        "SELECT language, status, count(*)::int AS words FROM lexicon GROUP BY 1, 2 ORDER BY 1, 2",
      ),
      // The Phase 3 targets (docs/UNDERSTANDING.md): the last 7 days, and the labels so far.
      one<{
        requests: number;
        without_claude: number;
        claude_calls: number;
        handoffs: number;
        labelled: number;
        labelled_right: number;
      }>(
        app.db,
        `SELECT
           (SELECT count(*)::int FROM requests WHERE understood_by IS NOT NULL AND created_at > now() - interval '7 days') AS requests,
           (SELECT count(*)::int FROM requests WHERE understood_by IN ('local', 'phrasebook', 'customer')
               AND created_at > now() - interval '7 days') AS without_claude,
           (SELECT count(*)::int FROM ai_usage WHERE feature = 'request' AND created_at > now() - interval '7 days') AS claude_calls,
           (SELECT count(*)::int FROM requests WHERE status = 'handoff' AND created_at > now() - interval '7 days') AS handoffs,
           (SELECT count(*)::int FROM request_labels) AS labelled,
           (SELECT count(*)::int FROM request_labels l JOIN requests r ON r.id = l.request_id
             WHERE (l.intent = 'search' AND r.interpretation->>'intent' = 'search' AND l.category_slug IS NOT DISTINCT FROM r.category_slug)
                OR (l.intent <> 'search' AND l.intent = r.interpretation->>'intent')) AS labelled_right`,
      ),
    ]);
    const health = await one<Record<string, unknown>>(
      app.db,
      `SELECT
         (SELECT count(*)::int FROM jobs WHERE status = 'queued' AND run_at <= now()) AS jobs_due,
         (SELECT count(*)::int FROM jobs WHERE status = 'failed' AND created_at > now() - interval '1 day') AS jobs_failed_24h,
         (SELECT count(*)::int FROM messages WHERE direction = 'in' AND processed_at IS NULL) AS inbound_unprocessed,
         (SELECT count(*)::int FROM messages WHERE direction = 'out' AND status = 'retrying') AS outbound_retrying,
         (SELECT count(*)::int FROM messages WHERE direction = 'out' AND status = 'failed'
             AND created_at > now() - interval '1 day') AS outbound_failed_24h,
         (SELECT max(created_at) FROM messages WHERE direction = 'in') AS last_inbound_at,
         (SELECT max(created_at) FROM messages WHERE direction = 'out' AND status = 'sent') AS last_sent_at`,
    );
    return {
      version: VERSION,
      env: config.env,
      startedAt: STARTED_AT,
      database: config.databaseUrl ? "postgres" : "pglite (embedded)",
      whatsapp: config.whatsapp.transport,
      storage: app.store.name,
      features: {
        understanding: services.understanding.description,
        alertsTo: config.alertWebhookUrl ? "webhook" : "log only",
      },
      claude: {
        dailyBudgetUsd: config.claudeBudget.dailyUsd,
        perNumberPerDay: config.claudeBudget.perNumberPerDay,
        today: claudeToday,
        last7Days: claudeWeek,
      },
      understood7d: understood,
      matched7d: matched,
      questions7d: questions,
      precision28d: precision,
      lexicon: { trustDrafts: config.lexiconTrustDrafts, words },
      targets,
      local: config.local,
      limits: config.limits,
      retention: config.retention,
      ...health,
      alerts: services.alerts.recent,
    };
  });
}
