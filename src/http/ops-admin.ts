import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { App } from "../app.js";
import { one } from "../db/client.js";
import { getBusiness, isUuid } from "../directory/businesses.js";
import { logAction } from "../ops/accounts.js";
import { eraseBusiness, eraseContact, exportContact } from "../privacy.js";
import { normalizeZimPhone } from "../text.js";
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

  // Is everything working? Queues, failed sends, what's switched on, recent alerts.
  ops.get("/system", async () => {
    const { services, config } = app;
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
        interpreter: services.interpreter.name,
        photos: !!services.vision,
        foundOnline: !!services.finder,
        voiceNotes: services.speech?.name ?? null,
        alertsTo: config.alertWebhookUrl ? "webhook" : "log only",
      },
      limits: config.limits,
      retention: config.retention,
      ...health,
      alerts: services.alerts.recent,
    };
  });
}
