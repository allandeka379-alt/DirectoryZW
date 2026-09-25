import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { App } from "../app.js";
import * as copy from "../conversation/copy.js";
import { getContactById, loadState, saveState } from "../conversation/store.js";
import { one } from "../db/client.js";
import {
  categoriesOf,
  createBusiness,
  getBusiness,
  isUuid,
  setBusinessStatus,
  verifyBusiness,
} from "../directory/businesses.js";
import { RECOMMENDATION_STATUSES, setRecommendationStatus } from "../directory/recommendations.js";
import { agentStats, createAgent, resetAgentToken, setAgentActive, setupUrl } from "../field/agents.js";
import { AUDIT_OUTCOMES, auditQueue, recordAudit } from "../field/audits.js";
import { logAction } from "../ops/accounts.js";
import { normalizeText, normalizeZimPhone } from "../text.js";
import { registerAdminRoutes } from "./ops-admin.js";
import { actorOf, opsAuthHook, refuseUnlessAdmin, registerAccountRoutes } from "./ops-auth.js";
import { serveFile } from "./static.js";

const FieldRegistration = z.object({
  name: z.string().min(2).max(80),
  phone: z.string().min(9).max(20),
  categories: z.array(z.string()).min(1).max(3),
  description: z.string().max(300).optional(),
  keywords: z.string().max(200).optional(),
  area: z.string().max(60).optional(),
  lat: z.number().optional(),
  lng: z.number().optional(),
  /** The owner agreed, in person, to be listed and contacted. */
  consent: z.literal(true),
  /** Checked ID or registration and saw the premises. */
  verified: z.boolean().default(false),
  /** Who checked; defaults to the signed-in person. */
  agent: z.string().min(1).max(60).optional(),
});

const Id = z.object({ id: z.string().refine(isUuid, "Not a valid ID") });

/**
 * JSON API for the ops console. People sign in with their own accounts (admin or staff);
 * scripts can use OPS_TOKEN. The console page itself is public; it asks them to sign in.
 */
export function registerOps(server: FastifyInstance, app: App): void {
  serveFile(server, "/ops", "ops/index.html");
  serveFile(server, "/ops/app.js", "ops/app.js");
  serveFile(server, "/ops/app.css", "ops/app.css");

  server.register(
    async (ops) => {
      ops.addHook("onRequest", opsAuthHook(app));
      registerAccountRoutes(ops, app);
      registerAdminRoutes(ops, app);

      // ----- Overview -----

      ops.get("/summary", async () =>
        one(
          app.db,
          `SELECT
             (SELECT count(*)::int FROM businesses WHERE status = 'active' AND verification = 'verified') AS verified_businesses,
             (SELECT count(*)::int FROM businesses WHERE status = 'active' AND verification = 'registered') AS registered_businesses,
             (SELECT count(*)::int FROM requests WHERE created_at > now() - interval '7 days') AS requests_7d,
             (SELECT count(*)::int FROM requests WHERE created_at > now() - interval '7 days' AND status = 'no_results') AS no_results_7d,
             (SELECT count(*)::int FROM introductions WHERE created_at > now() - interval '7 days') AS introductions_7d,
             (SELECT count(*)::int FROM sessions WHERE state->>'stage' = 'handoff') AS open_handoffs,
             (SELECT count(*)::int FROM reports WHERE status = 'open') AS open_reports,
             (SELECT count(*)::int FROM agents WHERE active) AS active_agents,
             (SELECT count(*)::int FROM recommendations WHERE status = 'new') AS new_recommendations`,
        ),
      );

      ops.get("/requests", async (req) => {
        const q = req.query as { status?: string; limit?: string };
        const limit = Math.min(Number(q.limit) || 50, 200);
        return app.db.query(
          `SELECT r.id, r.created_at, r.status, r.match, r.understood_by, r.raw_text, r.query, r.category_slug, a.name AS area,
                  r.result_count, c.wa_id
             FROM requests r JOIN contacts c ON c.id = r.contact_id LEFT JOIN areas a ON a.id = r.area_id
            WHERE ($1::text IS NULL OR r.status = $1)
            ORDER BY r.created_at DESC LIMIT $2`,
          [q.status ?? null, limit],
        );
      });

      // What people ask for that we can't answer from their own category: where field teams go next.
      ops.get("/supply-gaps", async (req) => {
        const days = Math.min(Number((req.query as { days?: string }).days) || 7, 90);
        return app.db.query(
          `SELECT COALESCE(r.category_slug, '(unknown)') AS category, COALESCE(a.name, '(no area)') AS area,
                  count(*)::int AS requests, (array_agg(r.raw_text ORDER BY r.created_at DESC))[1:3] AS examples
             FROM requests r LEFT JOIN areas a ON a.id = r.area_id
            WHERE (r.status IN ('no_results', 'asked_around', 'handoff') OR r.match IN ('related', 'none'))
              AND r.created_at > now() - make_interval(days => $1)
            GROUP BY 1, 2 ORDER BY requests DESC LIMIT 100`,
          [days],
        );
      });

      // ----- Handoffs -----

      ops.get("/handoffs", async () =>
        app.db.query(
          `SELECT c.id AS contact_id, c.wa_id, c.profile_name, s.updated_at,
                  (SELECT json_agg(m ORDER BY m.created_at) FROM (
                     SELECT direction, body, notes, created_at FROM messages WHERE contact_id = c.id
                      ORDER BY created_at DESC LIMIT 20) m) AS recent_messages
             FROM sessions s JOIN contacts c ON c.id = s.contact_id
            WHERE s.state->>'stage' = 'handoff' ORDER BY s.updated_at DESC`,
        ),
      );

      ops.post("/contacts/:id/reply", async (req, reply) => {
        const params = Id.safeParse(req.params);
        const body = z.object({ text: z.string().min(1).max(4096) }).safeParse(req.body);
        if (!params.success || !body.success) return reply.code(400).send({ error: "Give a contact ID and some text" });
        const contact = await getContactById(app.db, params.data.id);
        if (!contact) return reply.code(404).send({ error: "Contact not found" });
        await app.services.messenger.reply(contact, { kind: "text", text: body.data.text });
        await logAction(app.db, actorOf(req), "contact.reply", contact.id);
        return { ok: true };
      });

      ops.post("/contacts/:id/release", async (req, reply) => {
        const params = Id.safeParse(req.params);
        if (!params.success) return reply.code(400).send({ error: "Not a valid ID" });
        const contact = await getContactById(app.db, params.data.id);
        if (!contact) return reply.code(404).send({ error: "Contact not found" });
        const state = await loadState<Record<string, unknown>>(app.db, contact.id);
        delete state.stage;
        await saveState(app.db, contact.id, state);
        await app.db.query("UPDATE requests SET status = 'closed' WHERE contact_id = $1 AND status = 'handoff'", [contact.id]);
        await app.services.messenger.reply(contact, copy.welcomeBack());
        await logAction(app.db, actorOf(req), "contact.release", contact.id);
        return { ok: true };
      });

      // ----- Reports -----

      ops.get("/reports", async () =>
        app.db.query(
          `SELECT rp.id, rp.created_at, rp.reason, rp.status, rp.had_introduction, b.id AS business_id,
                  b.name AS business, b.verification, b.status AS business_status
             FROM reports rp JOIN businesses b ON b.id = rp.business_id
            WHERE rp.status = 'open' ORDER BY rp.created_at DESC LIMIT 200`,
        ),
      );

      ops.post("/reports/:id/status", async (req, reply) => {
        const params = Id.safeParse(req.params);
        const body = z.object({ status: z.enum(["open", "reviewed", "actioned"]) }).safeParse(req.body);
        if (!params.success || !body.success) return reply.code(400).send({ error: "Give a report ID and a status" });
        const rows = await app.db.query("UPDATE reports SET status = $2 WHERE id = $1 RETURNING id", [params.data.id, body.data.status]);
        if (!rows.length) return reply.code(404).send({ error: "Report not found" });
        await logAction(app.db, actorOf(req), "report.status", params.data.id, { status: body.data.status });
        return { ok: true };
      });

      // ----- Businesses -----

      ops.get("/businesses", async (req) => {
        const q = req.query as { q?: string; verification?: string; status?: string; limit?: string };
        const limit = Math.min(Number(q.limit) || 50, 200);
        return app.db.query(
          `SELECT b.id, b.name, b.phone, b.verification, b.status, b.source, b.audit_status, b.created_at,
                  a.name AS area, ag.name AS agent
             FROM businesses b LEFT JOIN areas a ON a.id = b.area_id LEFT JOIN agents ag ON ag.id = b.registered_by
            WHERE ($1::text IS NULL OR b.name ILIKE '%' || $1 || '%' OR b.phone LIKE '%' || $1 || '%')
              AND ($2::text IS NULL OR b.verification = $2)
              AND ($3::text IS NULL OR b.status = $3)
            ORDER BY b.created_at DESC LIMIT $4`,
          [q.q?.trim() || null, q.verification || null, q.status || null, limit],
        );
      });

      ops.get("/businesses/:id", async (req, reply) => {
        const params = Id.safeParse(req.params);
        if (!params.success) return reply.code(400).send({ error: "Not a valid ID" });
        const b = await getBusiness(app.db, params.data.id);
        if (!b) return reply.code(404).send({ error: "Business not found" });
        const [photos, audits, categories, offerings] = await Promise.all([
          app.db.query("SELECT id, kind, content_type, bytes, created_at FROM business_photos WHERE business_id = $1 ORDER BY created_at", [b.id]),
          app.db.query("SELECT outcome, note, audited_by, created_at FROM audits WHERE business_id = $1 ORDER BY created_at DESC", [b.id]),
          categoriesOf(app.db, b.id),
          app.db.query("SELECT name, price_usd, price_text, created_at FROM offerings WHERE business_id = $1 ORDER BY name LIMIT 200", [b.id]),
        ]);
        return { ...b, area: app.services.gazetteer.get(b.area_id)?.name ?? null, categories, photos, audits, offerings };
      });

      ops.get("/photos/:id", async (req, reply) => {
        const params = Id.safeParse(req.params);
        if (!params.success) return reply.code(400).send({ error: "Not a valid ID" });
        const photo = await one<{ storage_key: string; content_type: string }>(
          app.db,
          "SELECT storage_key, content_type FROM business_photos WHERE id = $1",
          [params.data.id],
        );
        const data = photo ? await app.store.get(photo.storage_key) : undefined;
        if (!photo || !data) return reply.code(404).send({ error: "Photo not found" });
        return reply.type(photo.content_type).header("Cache-Control", "private, max-age=3600").send(data);
      });

      // Manual registration (imports, data fixes). Agents use the field app instead.
      ops.post("/businesses", async (req, reply) => {
        const parsed = FieldRegistration.safeParse(req.body);
        if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues });
        const b = parsed.data;
        const phone = normalizeZimPhone(b.phone);
        if (!phone) return reply.code(400).send({ error: "Invalid phone number" });
        const unknown = b.categories.filter((s) => {
          const c = app.services.taxonomy.get(s);
          return !c || c.risk === "blocked" || c.risk === "restricted";
        });
        if (unknown.length) return reply.code(400).send({ error: `Unknown or blocked categories: ${unknown.join(", ")}` });
        const { gazetteer } = app.services;
        const area = b.area ? gazetteer.match(b.area) : b.lat != null && b.lng != null ? gazetteer.nearest(b.lat, b.lng) : undefined;
        if (!area && (b.lat == null || b.lng == null)) return reply.code(400).send({ error: "Give an area we know, or lat and lng" });
        const id = await createBusiness(app.db, {
          name: b.name,
          description: b.description,
          keywords: b.keywords,
          phone,
          areaId: area?.id ?? null,
          lat: b.lat ?? area?.lat ?? null,
          lng: b.lng ?? area?.lng ?? null,
          categories: b.categories,
          source: "field",
          verified: b.verified,
          verifiedBy: b.agent ?? actorOf(req).name,
          optedIn: true,
        });
        await logAction(app.db, actorOf(req), "business.create", id, { verified: b.verified });
        return reply.code(201).send({ id });
      });

      ops.post("/businesses/:id/verify", async (req, reply) => {
        const params = Id.safeParse(req.params);
        const body = z.object({ agent: z.string().min(1).max(60).optional() }).safeParse(req.body ?? {});
        if (!params.success || !body.success) return reply.code(400).send({ error: "Give a business ID" });
        if (!(await getBusiness(app.db, params.data.id))) return reply.code(404).send({ error: "Business not found" });
        await verifyBusiness(app.db, params.data.id, body.data.agent ?? actorOf(req).name);
        await logAction(app.db, actorOf(req), "business.verify", params.data.id);
        return { ok: true };
      });

      ops.post("/businesses/:id/status", async (req, reply) => {
        const params = Id.safeParse(req.params);
        const body = z.object({ status: z.enum(["active", "paused", "removed"]) }).safeParse(req.body);
        if (!params.success || !body.success) return reply.code(400).send({ error: "Give a business ID and a status" });
        if (body.data.status === "removed" && refuseUnlessAdmin(req, reply)) return;
        if (!(await getBusiness(app.db, params.data.id))) return reply.code(404).send({ error: "Business not found" });
        await setBusinessStatus(app.db, params.data.id, body.data.status);
        await logAction(app.db, actorOf(req), "business.status", params.data.id, { status: body.data.status });
        return { ok: true };
      });

      // Self-registered businesses waiting for a field visit, oldest first.
      ops.get("/verification-queue", async () =>
        app.db.query(
          `SELECT b.id, b.name, b.phone, b.description, b.created_at, a.name AS area, a.city
             FROM businesses b LEFT JOIN areas a ON a.id = b.area_id
            WHERE b.verification = 'registered' AND b.status = 'active' AND b.source = 'self'
            ORDER BY a.city NULLS LAST, a.name NULLS LAST, b.created_at LIMIT 300`,
        ),
      );

      // ----- Field agents -----

      ops.get("/agents", async () => agentStats(app.db));

      ops.post("/agents", async (req, reply) => {
        if (refuseUnlessAdmin(req, reply)) return;
        const body = z
          .object({ name: z.string().trim().min(2).max(60), phone: z.string().max(20).optional(), city: z.string().max(40).optional() })
          .safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: body.error.issues });
        const phone = body.data.phone ? normalizeZimPhone(body.data.phone) : null;
        const { agent, token } = await createAgent(app.db, { name: body.data.name, phone, city: body.data.city ?? null });
        await logAction(app.db, actorOf(req), "agent.create", agent.id);
        return reply.code(201).send({ agent, setupUrl: setupUrl(app.config.publicBaseUrl, token) });
      });

      ops.post("/agents/:id/token", async (req, reply) => {
        if (refuseUnlessAdmin(req, reply)) return;
        const params = Id.safeParse(req.params);
        if (!params.success) return reply.code(400).send({ error: "Not a valid ID" });
        const token = await resetAgentToken(app.db, params.data.id);
        if (!token) return reply.code(404).send({ error: "Agent not found" });
        await logAction(app.db, actorOf(req), "agent.new_link", params.data.id);
        return { setupUrl: setupUrl(app.config.publicBaseUrl, token) };
      });

      ops.post("/agents/:id/active", async (req, reply) => {
        if (refuseUnlessAdmin(req, reply)) return;
        const params = Id.safeParse(req.params);
        const body = z.object({ active: z.boolean() }).safeParse(req.body);
        if (!params.success || !body.success) return reply.code(400).send({ error: "Give an agent ID and active true/false" });
        if (!(await setAgentActive(app.db, params.data.id, body.data.active))) return reply.code(404).send({ error: "Agent not found" });
        await logAction(app.db, actorOf(req), body.data.active ? "agent.activate" : "agent.deactivate", params.data.id);
        return { ok: true };
      });

      // ----- Customer recommendations -----

      ops.get("/recommendations", async (req) => {
        const q = req.query as { status?: string };
        return app.db.query(
          `SELECT r.id, r.name, r.what, r.category_slug, c.name AS category, COALESCE(a.name, r.area_text) AS area, a.city,
                  r.phone, r.status, r.created_at,
                  (SELECT count(*)::int FROM recommendations r2 WHERE r2.phone = r.phone) AS times_recommended,
                  EXISTS (SELECT 1 FROM businesses b WHERE b.phone = r.phone AND b.status <> 'removed') AS already_listed
             FROM recommendations r LEFT JOIN areas a ON a.id = r.area_id LEFT JOIN categories c ON c.slug = r.category_slug
            WHERE ($1::text IS NULL OR r.status = $1)
            ORDER BY r.created_at DESC LIMIT 300`,
          [q.status || null],
        );
      });

      ops.post("/recommendations/:id/status", async (req, reply) => {
        const params = Id.safeParse(req.params);
        const body = z.object({ status: z.enum(RECOMMENDATION_STATUSES) }).safeParse(req.body);
        if (!params.success || !body.success) return reply.code(400).send({ error: "Give a recommendation ID and a status" });
        if (!(await setRecommendationStatus(app.db, params.data.id, body.data.status))) {
          return reply.code(404).send({ error: "Recommendation not found" });
        }
        await logAction(app.db, actorOf(req), "tip.status", params.data.id, { status: body.data.status });
        return { ok: true };
      });

      // ----- Vocabulary -----

      // Searches we couldn't put in a category: words to add as synonyms, or categories we're missing.
      ops.get("/unmatched", async (req) => {
        const days = Math.min(Number((req.query as { days?: string }).days) || 30, 180);
        const rows = await app.db.query<{ query: string }>(
          `SELECT lower(r.query) AS query, count(*)::int AS requests,
                  count(*) FILTER (WHERE r.status = 'no_results')::int AS no_results,
                  max(r.created_at) AS last_seen,
                  (array_agg(r.raw_text ORDER BY r.created_at DESC))[1:3] AS examples
             FROM requests r
            WHERE r.category_slug IS NULL AND r.interpretation->>'intent' = 'search' AND r.query <> ''
              AND r.created_at > now() - make_interval(days => $1)
            GROUP BY lower(r.query) ORDER BY requests DESC, last_seen DESC LIMIT 200`,
          [days],
        );
        // Words the categories now understand drop off the list.
        return rows.filter((r) => !app.services.taxonomy.match(r.query).length);
      });

      ops.get("/categories", async () =>
        app.db.query("SELECT slug, name, group_name, risk, synonyms, extra_synonyms FROM categories ORDER BY group_name, name"),
      );

      // Teach the keyword matcher (and Claude's category list) new words for a category. Takes effect immediately.
      ops.post("/categories/:slug/synonyms", async (req, reply) => {
        const slug = String((req.params as { slug?: string }).slug ?? "");
        const body = z
          .object({ add: z.array(z.string().max(60)).max(50).default([]), remove: z.array(z.string().max(60)).max(50).default([]) })
          .safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: "Give words to add or remove" });
        const row = await one<{ synonyms: string[]; extra_synonyms: string[] }>(
          app.db,
          "SELECT synonyms, extra_synonyms FROM categories WHERE slug = $1",
          [slug],
        );
        if (!row) return reply.code(404).send({ error: "Category not found" });
        const clean = (words: string[]) => words.map(normalizeText).filter((w) => w.length >= 2);
        const remove = new Set(clean(body.data.remove));
        const seeded = new Set(row.synonyms.map(normalizeText));
        const extra = [...new Set([...row.extra_synonyms, ...clean(body.data.add)])].filter((w) => !remove.has(w) && !seeded.has(w));
        await app.db.query("UPDATE categories SET extra_synonyms = $2 WHERE slug = $1", [slug, extra]);
        await app.reloadTaxonomy();
        await logAction(app.db, actorOf(req), "category.words", slug, { add: clean(body.data.add), remove: [...remove] });
        return { slug, extra_synonyms: extra };
      });

      // ----- Call-back audits -----

      ops.get("/audits/queue", async (req) => {
        const q = req.query as { days?: string; percent?: string; limit?: string };
        return auditQueue(app.db, {
          days: Math.min(Number(q.days) || 14, 90),
          percent: Math.min(Math.max(Number(q.percent) || 10, 1), 100),
          limit: Math.min(Number(q.limit) || 100, 500),
        });
      });

      ops.post("/businesses/:id/audit", async (req, reply) => {
        const params = Id.safeParse(req.params);
        const body = z
          .object({ outcome: z.enum(AUDIT_OUTCOMES), note: z.string().max(500).optional(), by: z.string().min(1).max(60).optional() })
          .safeParse(req.body);
        if (!params.success || !body.success) return reply.code(400).send({ error: "Give a business ID and an outcome" });
        const audit = { ...body.data, by: body.data.by ?? actorOf(req).name };
        if (!(await recordAudit(app.db, params.data.id, audit))) return reply.code(404).send({ error: "Business not found" });
        await logAction(app.db, actorOf(req), "business.callback", params.data.id, { outcome: audit.outcome });
        return { ok: true };
      });
    },
    { prefix: "/ops/api" },
  );
}
