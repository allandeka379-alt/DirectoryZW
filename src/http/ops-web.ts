import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { App } from "../app.js";
import { one } from "../db/client.js";
import { getBusiness, isUuid } from "../directory/businesses.js";
import { productsChanged } from "../conversation/alerts.js";
import { logAction } from "../ops/accounts.js";
import { archiveProducts, catalogHealth, deletePhoto, listProducts, ProductQuery } from "../web/catalog.js";
import { createLoginLink, ownerContactFor, signInUrl, TEAM_LINK_HOURS } from "../web/owner-auth.js";
import { listWebRegistration } from "../web/registration.js";
import { catalogStatus, markAllForCatalog } from "../whatsapp/catalog.js";
import { actorOf, refuseUnlessAdmin } from "./ops-auth.js";

const Id = z.object({ id: z.string().refine(isUuid, "Not a valid ID") });

/** "2026-09-29" in Harare (UTC+2 all year). */
function harareDate(d: Date): string {
  return new Date(d.getTime() + 2 * 3600_000).toISOString().slice(0, 10);
}

interface RegistrationRow {
  id: string;
  code: string;
  details: { name?: string; phone?: string; areaId?: number; categories?: string[] };
  created_at: Date;
  expires_at: Date;
  completed_at: Date | null;
  business_id: string | null;
  business_name: string | null;
}

/**
 * What the admin portal needs from the website and the business dashboard: registrations started on
 * the website, each business's catalogue and photos (to take down anything that shouldn't be there),
 * owners' dashboard sessions, and day-by-day activity for the overview.
 */
export function registerWebAdminRoutes(ops: FastifyInstance, app: App): void {
  const now = () => app.services.now();

  // Registrations waiting for the owner's WhatsApp code, finished ones, or ones whose code ran out.
  ops.get("/web-registrations", async (req, reply) => {
    const q = z.object({ status: z.enum(["pending", "completed", "expired", "all"]).default("pending") }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "Pick pending, completed, expired or all" });
    const where = {
      pending: "w.completed_at IS NULL AND w.expires_at > $1",
      expired: "w.completed_at IS NULL AND w.expires_at <= $1",
      completed: "w.completed_at IS NOT NULL AND $1::timestamptz IS NOT NULL",
      all: "$1::timestamptz IS NOT NULL",
    }[q.data.status];
    const rows = await app.db.query<RegistrationRow>(
      `SELECT w.id, w.code, w.details, w.created_at, w.expires_at, w.completed_at, w.business_id, b.name AS business_name
         FROM web_registrations w LEFT JOIN businesses b ON b.id = w.business_id
        WHERE ${where} ORDER BY w.created_at DESC LIMIT 300`,
      [now()],
    );
    const { gazetteer, taxonomy } = app.services;
    // A finished registration's form was cleared when the business was created: it points to the business.
    return rows.map((r) => ({
      id: r.id,
      code: r.code,
      name: r.business_name ?? r.details.name ?? null,
      phone: r.details.phone ?? null,
      area: r.details.areaId ? (gazetteer.get(r.details.areaId)?.name ?? null) : null,
      categories: (r.details.categories ?? []).map((s) => taxonomy.get(s)?.name ?? s),
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      completedAt: r.completed_at,
      businessId: r.business_id,
    }));
  });

  // Before launch (or when an owner can't send their code), the team lists a sign-up after calling
  // the owner. Nobody manages it until its number messages us on WhatsApp, or the team sends a link.
  ops.post("/web-registrations/:id/list", async (req, reply) => {
    const params = Id.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "Not a valid ID" });
    const result = await listWebRegistration({ db: app.db, gazetteer: app.services.gazetteer }, params.data.id, now());
    if (result.status === "unknown") return reply.code(404).send({ error: "Sign-up not found" });
    if (!("businessId" in result)) return reply.code(409).send({ error: "This sign-up is already listed" });
    await logAction(app.db, actorOf(req), "registration.list", result.businessId, { name: result.name, existed: result.status === "exists" });
    return { businessId: result.businessId, name: result.name, created: result.status === "created" };
  });

  // ----- A business's catalogue, for moderation -----

  const exists = async (id: string) => Boolean(await one(app.db, "SELECT 1 FROM businesses WHERE id = $1", [id]));

  ops.get("/businesses/:id/products", async (req, reply) => {
    const params = Id.safeParse(req.params);
    const q = ProductQuery.safeParse(req.query);
    if (!params.success || !q.success) return reply.code(400).send({ error: "Give a business ID and a valid search" });
    if (!(await exists(params.data.id))) return reply.code(404).send({ error: "Business not found" });
    const [list, health] = await Promise.all([listProducts(app.db, params.data.id, q.data, now()), catalogHealth(app.db, params.data.id, now())]);
    return { ...list, health };
  });

  // Takes products down (with their photos): offensive, illegal, or not what the business sells.
  ops.post("/businesses/:id/products/archive", async (req, reply) => {
    const params = Id.safeParse(req.params);
    const body = z.object({ ids: z.array(z.string()).min(1).max(1000), reason: z.string().trim().max(300).optional() }).safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "Give a business ID and the products to take down" });
    if (!(await exists(params.data.id))) return reply.code(404).send({ error: "Business not found" });
    const removed = await archiveProducts(app.db, app.store, params.data.id, body.data.ids, now());
    await logAction(app.db, actorOf(req), "product.remove", params.data.id, { count: removed, reason: body.data.reason });
    await productsChanged(app.services, params.data.id);
    return { removed };
  });

  ops.delete("/businesses/:id/photos/:photoId", async (req, reply) => {
    const params = z.object({ id: z.string().refine(isUuid), photoId: z.string().refine(isUuid) }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "Not a valid ID" });
    // A product's photo is taken off the product first.
    await app.db.query("UPDATE offerings SET photo_id = NULL, updated_at = $3, catalog_dirty = true WHERE business_id = $1 AND photo_id = $2", [
      params.data.id,
      params.data.photoId,
      now(),
    ]);
    if (!(await deletePhoto(app.db, app.store, params.data.id, params.data.photoId))) return reply.code(404).send({ error: "Photo not found" });
    await logAction(app.db, actorOf(req), "photo.remove", params.data.id);
    await productsChanged(app.services, params.data.id);
    return { ok: true };
  });

  // A one-time dashboard link for the business's owner, for the team to hand over: before launch, or
  // when the owner can't get one on WhatsApp. It works once, for a day; the owner is the business's number.
  ops.post("/businesses/:id/owner/link", async (req, reply) => {
    if (refuseUnlessAdmin(req, reply)) return;
    const params = Id.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "Not a valid ID" });
    const b = await getBusiness(app.db, params.data.id);
    if (!b || b.status === "removed") return reply.code(404).send({ error: "Business not found" });
    const contactId = await ownerContactFor(app.db, b);
    const token = await createLoginLink(app.db, contactId, now(), TEAM_LINK_HOURS * 60);
    await logAction(app.db, actorOf(req), "owner.link", b.id);
    return { url: signInUrl(app.config.publicBaseUrl, token), expiresAt: new Date(now().getTime() + TEAM_LINK_HOURS * 3600_000) };
  });

  // Signs the owner out of the dashboard everywhere: a lost phone, or someone else had the link.
  ops.post("/businesses/:id/owner/sign-out", async (req, reply) => {
    const params = Id.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "Not a valid ID" });
    const b = await one<{ owner_contact_id: string | null }>(app.db, "SELECT owner_contact_id FROM businesses WHERE id = $1", [params.data.id]);
    if (!b) return reply.code(404).send({ error: "Business not found" });
    if (!b.owner_contact_id) return reply.code(409).send({ error: "Nobody manages this business from WhatsApp yet" });
    const ended = await app.db.query("DELETE FROM owner_sessions WHERE contact_id = $1 RETURNING token_hash", [b.owner_contact_id]);
    await app.db.query("UPDATE owner_login_links SET used_at = $2 WHERE contact_id = $1 AND used_at IS NULL", [b.owner_contact_id, now()]);
    await logAction(app.db, actorOf(req), "owner.sign_out", params.data.id, { sessions: ended.length });
    return { ended: ended.length };
  });

  // ----- Products on WhatsApp -----

  // The WhatsApp catalog and product alerts: what's in it, what's waiting, what Meta refused.
  ops.get("/catalog", async () => {
    const catalog = app.services.catalog;
    const alerts = await one<{ week: number; off: number }>(
      app.db,
      `SELECT (SELECT count(*)::int FROM product_alerts WHERE created_at > $1) AS week,
              (SELECT count(*)::int FROM contacts WHERE alerts_off_at IS NOT NULL) AS off`,
      [new Date(now().getTime() - 7 * 24 * 3600_000)],
    );
    return {
      enabled: Boolean(catalog),
      kind: catalog?.name ?? null,
      catalogId: catalog?.catalogId ?? null,
      cards: app.config.products.cards,
      alerts: { on: app.config.products.alerts, sent7d: alerts?.week ?? 0, switchedOff: alerts?.off ?? 0 },
      ...(catalog ? await catalogStatus(app.db) : {}),
    };
  });

  // Send every product again: a new catalog, or after fixing a setting.
  ops.post("/catalog/sync", async (req, reply) => {
    if (refuseUnlessAdmin(req, reply)) return;
    if (!app.services.catalog) return reply.code(409).send({ error: "There's no WhatsApp catalog set up (WHATSAPP_CATALOG_ID)." });
    const marked = await markAllForCatalog(app.db);
    await app.services.jobs.enqueueOnce("catalog_sync", "all", {}, now());
    await logAction(app.db, actorOf(req), "catalog.resync", null, { products: marked });
    return { marked };
  });

  // ----- Day by day, for the overview -----

  ops.get("/trends", async (req, reply) => {
    const q = z.object({ days: z.coerce.number().int().min(7).max(90).default(30) }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "Pick between 7 and 90 days" });
    const since = new Date(now().getTime() - q.data.days * 24 * 3600_000);
    const day = (col: string) => `((${col} AT TIME ZONE 'UTC') + interval '2 hours')::date::text`;
    const count = (table: string, col = "created_at") =>
      app.db.query<{ d: string; n: number }>(`SELECT ${day(col)} AS d, count(*)::int AS n FROM ${table} WHERE ${col} >= $1 GROUP BY 1`, [since]);
    const [requests, connections, businesses, signUps] = await Promise.all([
      count("requests"),
      count("introductions"),
      count("businesses"),
      count("web_registrations"),
    ]);
    const map = (rows: { d: string; n: number }[]) => new Map(rows.map((r) => [r.d, r.n]));
    const [r, c, b, w] = [map(requests), map(connections), map(businesses), map(signUps)];
    return Array.from({ length: q.data.days }, (_, i) => {
      const date = harareDate(new Date(now().getTime() - (q.data.days - 1 - i) * 24 * 3600_000));
      return { date, requests: r.get(date) ?? 0, connections: c.get(date) ?? 0, businesses: b.get(date) ?? 0, webSignUps: w.get(date) ?? 0 };
    });
  });
}
