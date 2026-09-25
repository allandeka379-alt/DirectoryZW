import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { App } from "../app.js";
import * as copy from "../conversation/copy.js";
import { getContactById, loadState, saveState } from "../conversation/store.js";
import { createBusiness, getBusiness, isUuid, setBusinessStatus, verifyBusiness } from "../directory/businesses.js";
import { normalizeZimPhone } from "../text.js";

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
  agent: z.string().min(1).max(60),
});

/**
 * JSON API for the ops team and, later, the field app. Protected by OPS_TOKEN
 * (open in development when no token is set).
 */
export function registerOps(server: FastifyInstance, app: App): void {
  server.register(
    async (ops) => {
      ops.addHook("onRequest", async (req, reply) => {
        const token = app.config.opsToken;
        if (!token) {
          if (app.config.env !== "production") return;
          return reply.code(503).send({ error: "OPS_TOKEN is not configured" });
        }
        if (req.headers.authorization !== `Bearer ${token}`) return reply.code(401).send({ error: "Unauthorized" });
      });

      ops.get("/summary", async () => {
        const [row] = await app.db.query(
          `SELECT
             (SELECT count(*)::int FROM businesses WHERE status = 'active' AND verification = 'verified') AS verified_businesses,
             (SELECT count(*)::int FROM businesses WHERE status = 'active' AND verification = 'registered') AS registered_businesses,
             (SELECT count(*)::int FROM requests WHERE created_at > now() - interval '7 days') AS requests_7d,
             (SELECT count(*)::int FROM requests WHERE created_at > now() - interval '7 days' AND status = 'no_results') AS no_results_7d,
             (SELECT count(*)::int FROM introductions WHERE created_at > now() - interval '7 days') AS introductions_7d,
             (SELECT count(*)::int FROM requests WHERE status = 'handoff') AS open_handoffs,
             (SELECT count(*)::int FROM reports WHERE status = 'open') AS open_reports`,
        );
        return row;
      });

      ops.get("/requests", async (req) => {
        const q = req.query as { status?: string; limit?: string };
        const limit = Math.min(Number(q.limit) || 50, 200);
        return app.db.query(
          `SELECT r.id, r.created_at, r.status, r.raw_text, r.query, r.category_slug, a.name AS area, r.result_count, c.wa_id
             FROM requests r JOIN contacts c ON c.id = r.contact_id LEFT JOIN areas a ON a.id = r.area_id
            WHERE ($1::text IS NULL OR r.status = $1)
            ORDER BY r.created_at DESC LIMIT $2`,
          [q.status ?? null, limit],
        );
      });

      // What people ask for that we can't answer: where field teams should go next.
      ops.get("/supply-gaps", async (req) => {
        const days = Math.min(Number((req.query as { days?: string }).days) || 7, 90);
        return app.db.query(
          `SELECT COALESCE(r.category_slug, '(unknown)') AS category, COALESCE(a.name, '(no area)') AS area,
                  count(*)::int AS requests, (array_agg(r.raw_text ORDER BY r.created_at DESC))[1:3] AS examples
             FROM requests r LEFT JOIN areas a ON a.id = r.area_id
            WHERE r.status IN ('no_results', 'asked_around', 'handoff')
              AND r.created_at > now() - make_interval(days => $1)
            GROUP BY 1, 2 ORDER BY requests DESC LIMIT 100`,
          [days],
        );
      });

      ops.get("/handoffs", async () =>
        app.db.query(
          `SELECT c.id AS contact_id, c.wa_id, c.profile_name, s.updated_at,
                  (SELECT json_agg(m ORDER BY m.created_at) FROM (
                     SELECT direction, body, created_at FROM messages WHERE contact_id = c.id
                      ORDER BY created_at DESC LIMIT 20) m) AS recent_messages
             FROM sessions s JOIN contacts c ON c.id = s.contact_id
            WHERE s.state->>'stage' = 'handoff' ORDER BY s.updated_at DESC`,
        ),
      );

      ops.post("/contacts/:id/reply", async (req, reply) => {
        const { id } = req.params as { id: string };
        const body = z.object({ text: z.string().min(1).max(4096) }).safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: body.error.issues });
        const contact = await getContactById(app.db, id);
        if (!contact) return reply.code(404).send({ error: "Contact not found" });
        await app.services.messenger.reply(contact, { kind: "text", text: body.data.text });
        return { ok: true };
      });

      ops.post("/contacts/:id/release", async (req, reply) => {
        const { id } = req.params as { id: string };
        const contact = await getContactById(app.db, id);
        if (!contact) return reply.code(404).send({ error: "Contact not found" });
        const state = await loadState<Record<string, unknown>>(app.db, contact.id);
        delete state.stage;
        await saveState(app.db, contact.id, state);
        await app.db.query("UPDATE requests SET status = 'closed' WHERE contact_id = $1 AND status = 'handoff'", [contact.id]);
        await app.services.messenger.reply(contact, copy.welcomeBack());
        return { ok: true };
      });

      ops.get("/reports", async () =>
        app.db.query(
          `SELECT rp.id, rp.created_at, rp.reason, rp.status, b.id AS business_id, b.name AS business, b.verification
             FROM reports rp JOIN businesses b ON b.id = rp.business_id
            WHERE rp.status = 'open' ORDER BY rp.created_at DESC LIMIT 200`,
        ),
      );

      // Field-agent registration (the field app will call this).
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
          verifiedBy: b.agent,
          optedIn: true,
        });
        return reply.code(201).send({ id });
      });

      ops.post("/businesses/:id/verify", async (req, reply) => {
        const { id } = req.params as { id: string };
        const body = z.object({ agent: z.string().min(1).max(60) }).safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: body.error.issues });
        if (!isUuid(id) || !(await getBusiness(app.db, id))) return reply.code(404).send({ error: "Business not found" });
        await verifyBusiness(app.db, id, body.data.agent);
        return { ok: true };
      });

      ops.post("/businesses/:id/status", async (req, reply) => {
        const { id } = req.params as { id: string };
        const body = z.object({ status: z.enum(["active", "paused", "removed"]) }).safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: body.error.issues });
        if (!isUuid(id) || !(await getBusiness(app.db, id))) return reply.code(404).send({ error: "Business not found" });
        await setBusinessStatus(app.db, id, body.data.status);
        return { ok: true };
      });
    },
    { prefix: "/ops/api" },
  );
}
