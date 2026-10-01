import fs from "node:fs/promises";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { App } from "../app.js";
import { one } from "../db/client.js";
import { categoriesOf, isUuid, markCatalogDirty, setBusinessStatus, TRADES, type Business } from "../directory/businesses.js";
import { normalizeZimPhone } from "../text.js";
import { businessAnalytics, businessCustomers } from "../web/analytics.js";
import {
  addBusinessPhoto,
  adjustPrices,
  archiveProducts,
  businessPhotos,
  CatalogError,
  catalogHealth,
  confirmPrices,
  createProduct,
  deletePhoto,
  getProduct,
  ImportRequest,
  importProducts,
  productIndex,
  listProducts,
  PhotoUpload,
  PriceAdjustment,
  priceHistory,
  ProductInput,
  ProductPatch,
  ProductQuery,
  removeProductPhoto,
  setProductPhoto,
  setStock,
  STALE_PRICE_DAYS,
  updateProduct,
} from "../web/catalog.js";
import {
  createLoginLink,
  createOwnerSession,
  endOwnerSession,
  ownerForSession,
  readCookie,
  SESSION_COOKIE,
  sessionCookie,
  signInUrl,
  useLoginLink,
  type Owner,
} from "../web/owner-auth.js";
import { clearFailedPhotoLinks, photoLinkStatus, retryPhotoLinks } from "../web/photo-links.js";
import { privacyPage, termsPage, type LegalValues } from "../web/legal.js";
import { REGISTRATION_HOURS, startWebRegistration, WebRegistration } from "../web/registration.js";
import { productsChanged } from "../conversation/alerts.js";
import * as copy from "../conversation/copy.js";
import type { Contact } from "../conversation/store.js";
import { PUBLIC_DIR, serveAssetFolder, serveFile } from "./static.js";

declare module "fastify" {
  interface FastifyRequest {
    owner?: Owner;
  }
}

/** A small in-memory limiter: at most `max` hits per key in `windowMs`. */
class Limiter {
  private hits = new Map<string, number[]>();
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => Date,
  ) {}
  allow(key: string): boolean {
    const t = this.now().getTime();
    const recent = (this.hits.get(key) ?? []).filter((x) => t - x < this.windowMs);
    if (recent.length >= this.max) return false;
    recent.push(t);
    this.hits.set(key, recent);
    if (this.hits.size > 10_000) this.hits.clear();
    return true;
  }
}

function clientIp(req: FastifyRequest): string {
  const forwarded = req.headers["x-forwarded-for"];
  return (typeof forwarded === "string" ? forwarded.split(",")[0]!.trim() : "") || req.ip;
}

function problem(err: z.ZodError): string {
  return err.issues.map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message)).join("; ");
}

const Profile = z.object({
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(300),
  keywords: z.string().trim().max(200).default(""),
  categories: z.array(z.string().max(60)).min(1).max(3),
  areaId: z.number().int().positive(),
  address: z.string().trim().max(200).default(""),
  lat: z.number().min(-90).max(90).nullable().optional(),
  lng: z.number().min(-180).max(180).nullable().optional(),
  phone: z.string().min(9).max(20),
  hours: z.string().trim().max(120).default(""),
  email: z.union([z.string().trim().email().max(200), z.literal("")]).default(""),
  website: z.string().trim().max(200).default(""),
  trade: z.enum(TRADES),
});

/** The public website, the business web app, and the app's JSON API. */
export function registerWeb(server: FastifyInstance, app: App): void {
  // ----- Pages and files -----
  servePage(server, app, "/", "site/index.html");
  servePage(server, app, "/register", "site/register.html");
  // The privacy notice and business terms, with the retention periods from the settings.
  const legal = (): LegalValues => ({
    brand: app.config.brandName,
    contactEmail: app.config.contactEmail,
    whatsappNumber: app.config.whatsapp.transport === "off" ? undefined : app.config.whatsapp.number,
    messageDays: app.config.retention.messageDays,
    requestDays: app.config.retention.requestDays,
    year: app.services.now().getFullYear(),
  });
  server.get("/privacy", async (_req, reply) => reply.type("text/html; charset=utf-8").header("Cache-Control", "no-cache").send(privacyPage(legal())));
  server.get("/terms", async (_req, reply) => reply.type("text/html; charset=utf-8").header("Cache-Control", "no-cache").send(termsPage(legal())));
  serveFile(server, "/assets/base.css", "web/base.css");
  serveFile(server, "/assets/site.css", "site/site.css");
  serveFile(server, "/assets/register.js", "site/register.js");
  serveFile(server, "/assets/theme.js", "web/theme.js");
  serveFile(server, "/assets/ui.js", "web/ui.js");
  serveFile(server, "/assets/logo.svg", "web/logo.svg");
  // The website's illustrations, photos and script.
  serveAssetFolder(server, "/assets/site", "site/assets");
  serveFile(server, "/favicon.svg", "web/logo.svg");
  server.get("/app", async (_req, reply) => reply.redirect("/app/"));
  serveFile(server, "/app/", "app/index.html");
  serveFile(server, "/app/app.css", "app/app.css");
  serveFile(server, "/app/app.js", "app/app.js");
  serveFile(server, "/app/charts.js", "app/charts.js");
  serveFile(server, "/app/sheets.js", "app/sheets.js");
  serveFile(server, "/app/photos.js", "app/photos.js");
  serveFile(server, "/app/products-template.csv", "app/products-template.csv", {
    "Content-Disposition": 'attachment; filename="products-template.csv"',
  });

  const now = () => app.services.now();
  const secure = app.config.publicBaseUrl.startsWith("https://");
  const linkByPhone = new Limiter(5, 3600_000, now);
  const linkByIp = new Limiter(30, 3600_000, now);
  const registerByIp = new Limiter(10, 3600_000, now);
  const waLink = (text: string) => `https://wa.me/${app.config.whatsapp.number}?text=${encodeURIComponent(text)}`;
  // Before launch WhatsApp is off: sign-ups wait for the team to call, and sign-in links come from the team.
  const live = app.config.whatsapp.transport !== "off";

  server.register(
    async (api) => {
      // Changes must come from our own pages. Cookies are SameSite=Lax too.
      api.addHook("onRequest", async (req, reply) => {
        if (req.method === "GET" || req.method === "HEAD") return;
        const origin = req.headers.origin;
        if (origin && origin !== `${secure ? "https" : req.protocol}://${req.headers.host}` && origin !== app.config.publicBaseUrl) {
          return reply.code(403).send({ error: "Not allowed from another site" });
        }
      });

      // ----- Public: what the registration form needs, and registering -----

      api.get("/public/options", async () => options(app));

      api.post("/public/register", async (req, reply) => {
        if (!registerByIp.allow(clientIp(req))) return reply.code(429).send({ error: "Too many registrations from here. Try again in an hour." });
        const body = WebRegistration.safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: problem(body.error) });
        const deps = { db: app.db, taxonomy: app.services.taxonomy, gazetteer: app.services.gazetteer };
        const result = await startWebRegistration(deps, body.data, now(), live ? REGISTRATION_HOURS : PRELAUNCH_REGISTRATION_HOURS);
        if (!result.ok) return reply.code(400).send({ error: result.error });
        if (!live) return { code: result.code, expiresAt: result.expiresAt.toISOString(), preLaunch: true };
        return {
          code: result.code,
          expiresAt: result.expiresAt.toISOString(),
          whatsappNumber: app.config.whatsapp.number,
          whatsappLink: waLink(`Confirm my business registration ${result.code}`),
        };
      });

      // ----- Signing in -----

      // Always the same answer, so it doesn't tell anyone which numbers are registered. The link is sent
      // on WhatsApp only when it's free (the owner messaged us in the last day); otherwise they tap the button.
      api.post("/auth/request", async (req, reply) => {
        const body = z.object({ phone: z.string().min(9).max(20) }).safeParse(req.body);
        const phone = body.success ? normalizeZimPhone(body.data.phone) : null;
        if (!phone) return reply.code(400).send({ error: "That doesn't look like a phone number. Use a number like 0771 234 567." });
        if (!live) return { ok: true, preLaunch: true };
        const answer = { ok: true, whatsappLink: waLink("dashboard") };
        if (!linkByIp.allow(clientIp(req)) || !linkByPhone.allow(phone)) return answer;
        const contact = await one<Contact>(app.db, "SELECT * FROM contacts WHERE channel = 'business' AND (wa_id = $1 OR phone = $1) LIMIT 1", [phone]);
        // Replies inside the owner's 24-hour window are free; outside it they tap the button instead.
        if (!contact || contact.is_blocked || !app.services.messenger.windowClosesAt(contact)) return answer;
        const owns = await one(app.db, "SELECT 1 FROM businesses WHERE owner_contact_id = $1 AND status <> 'removed'", [contact.id]);
        if (!owns) return answer;
        const token = await createLoginLink(app.db, contact.id, now());
        await app.services.messenger.reply(contact, copy.dashboardLink(signInUrl(app.config.publicBaseUrl, token)));
        return answer;
      });

      api.post("/auth/exchange", async (req, reply) => {
        const body = z.object({ token: z.string().min(10).max(200) }).safeParse(req.body);
        const contactId = body.success ? await useLoginLink(app.db, body.data.token, now()) : undefined;
        if (!contactId) {
          const again = live ? "Send *dashboard* to us on WhatsApp for a new one." : "Ask our team for a new one.";
          return reply.code(401).send({ error: `This sign-in link has expired or was already used. ${again}` });
        }
        const token = await createOwnerSession(app.db, contactId, now());
        return reply.header("Set-Cookie", sessionCookie(token, secure)).send({ ok: true });
      });

      api.post("/auth/logout", async (req, reply) => {
        await endOwnerSession(app.db, readCookie(req.headers.cookie, SESSION_COOKIE));
        return reply.header("Set-Cookie", sessionCookie("", secure, 0)).send({ ok: true });
      });

      // ----- Everything else needs a signed-in owner -----

      api.register(async (owner) => {
        owner.addHook("onRequest", async (req, reply) => {
          const found = await ownerForSession(app.db, readCookie(req.headers.cookie, SESSION_COOKIE), now());
          if (!found) return reply.code(401).send({ error: "Please sign in" });
          req.owner = found;
        });
        // Products, prices, stock or the business changed: customers waiting for it hear, and the
        // WhatsApp catalog is sent the changes, within seconds (checks and previews change nothing).
        owner.addHook("onResponse", async (req, reply) => {
          if (req.method === "GET" || reply.statusCode >= 300) return;
          const id = (req.params as { id?: string } | undefined)?.id;
          if (!id || !isUuid(id) || !/\/businesses\/:id(\/status|\/products.*)?$/.test(req.routeOptions.url ?? "")) return;
          if ((req.body as { dryRun?: boolean } | undefined)?.dryRun) return;
          await productsChanged(app.services, id).catch((err: unknown) => req.log.error({ err: String(err) }, "Couldn't queue product updates"));
        });
        registerOwnerRoutes(owner, app);
      });
    },
    { prefix: "/app/api" },
  );
}

const escapeHtml = (v: string) => v.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** A website page with {{brand}}, {{wa}}, {{terms}}, {{privacy}} and {{year}} filled in from the settings. */
function servePage(server: FastifyInstance, app: App, route: string, file: string): void {
  server.get(route, async (_req, reply) => {
    const html = await fs.readFile(new URL(file, PUBLIC_DIR), "utf8");
    const values: Record<string, string> = {
      brand: app.config.brandName,
      // "off" before launch: the pages hide what needs WhatsApp.
      whatsapp: app.config.whatsapp.transport === "off" ? "off" : "on",
      wa: app.config.whatsapp.number,
      terms: app.config.businessTermsUrl,
      privacy: app.config.privacyUrl,
      year: String(app.services.now().getFullYear()),
    };
    const page = html.replace(/\{\{(\w+)\}\}/g, (m, key: string) => (key in values ? escapeHtml(values[key]!) : m));
    return reply.type("text/html; charset=utf-8").header("Cache-Control", "no-cache").send(page);
  });
}

/** Before launch, a website sign-up waits this long for the team to call and list it. */
const PRELAUNCH_REGISTRATION_HOURS = 60 * 24;

function options(app: App) {
  const live = app.config.whatsapp.transport !== "off";
  return {
    brand: app.config.brandName,
    whatsapp: live,
    whatsappNumber: live ? app.config.whatsapp.number : null,
    termsUrl: app.config.businessTermsUrl,
    privacyUrl: app.config.privacyUrl,
    categories: app.services.taxonomy
      .searchable()
      .filter((c) => c.risk !== "restricted" && c.risk !== "blocked")
      // Synonyms let the pickers find "fridge" under Home appliances.
      .map((c) => ({ slug: c.slug, name: c.name, group: c.group, synonyms: c.synonyms.slice(0, 25) })),
    areas: app.services.gazetteer.areas.map((a) => ({ id: a.id, name: a.name, city: a.city })),
  };
}

function registerOwnerRoutes(api: FastifyInstance, app: App): void {
  const now = () => app.services.now();
  const { db, store } = app;

  /** The business in the URL, if this owner manages it. Otherwise a 404, so IDs can't be probed. */
  async function mine(req: FastifyRequest, reply: FastifyReply): Promise<Business | undefined> {
    const id = (req.params as { id?: string }).id ?? "";
    const b = isUuid(id)
      ? await one<Business>(db, "SELECT * FROM businesses WHERE id = $1 AND owner_contact_id = $2 AND status <> 'removed'", [id, req.owner!.contactId])
      : undefined;
    if (!b) void reply.code(404).send({ error: "Business not found" });
    return b;
  }

  async function guard<T>(reply: FastifyReply, fn: () => Promise<T>): Promise<T | FastifyReply> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof CatalogError) return reply.code(err.status).send({ error: err.message });
      throw err;
    }
  }

  api.get("/me", async (req) => {
    const businesses = await db.query<{ id: string; name: string; verification: string; status: string; paused_by: string | null; area_id: number | null; products: number }>(
      `SELECT b.id, b.name, b.verification, b.status, b.paused_by, b.area_id,
              (SELECT count(*)::int FROM offerings o WHERE o.business_id = b.id AND o.archived_at IS NULL) AS products
         FROM businesses b WHERE b.owner_contact_id = $1 AND b.status <> 'removed' ORDER BY b.created_at`,
      [req.owner!.contactId],
    );
    return {
      owner: { phone: req.owner!.phone, name: req.owner!.name },
      businesses: businesses.map((b) => ({ ...b, area: app.services.gazetteer.get(b.area_id)?.name ?? null })),
      stalePriceDays: STALE_PRICE_DAYS,
    };
  });

  api.get("/options", async () => options(app));

  // ----- Profile -----

  api.get("/businesses/:id", async (req, reply) => {
    const b = await mine(req, reply);
    if (!b) return;
    const row = await one<Record<string, unknown>>(db, "SELECT address, hours, email, website FROM businesses WHERE id = $1", [b.id]);
    return {
      id: b.id,
      name: b.name,
      description: b.description,
      keywords: b.keywords,
      phone: b.phone,
      areaId: b.area_id,
      area: app.services.gazetteer.get(b.area_id)?.name ?? null,
      lat: b.lat,
      lng: b.lng,
      trade: b.trade,
      verification: b.verification,
      verifiedAt: b.verified_at,
      status: b.status,
      categories: await categoriesOf(db, b.id),
      address: row?.address ?? "",
      hours: row?.hours ?? "",
      email: row?.email ?? "",
      website: row?.website ?? "",
      photos: (await businessPhotos(db, b.id)).map((p) => ({ id: p.id, kind: p.kind })),
    };
  });

  api.put("/businesses/:id", async (req, reply) => {
    const b = await mine(req, reply);
    if (!b) return;
    const body = Profile.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: problem(body.error) });
    const p = body.data;
    const phone = normalizeZimPhone(p.phone);
    if (!phone) return reply.code(400).send({ error: "The phone number doesn't look right." });
    // A checked business's number is what customers trust, so our team changes it, not the dashboard.
    if (b.verification === "verified" && phone !== b.phone) {
      return reply.code(409).send({ error: "This business is verified, so its number can only be changed by our team. Message us on WhatsApp." });
    }
    const bad = p.categories.filter((s) => {
      const c = app.services.taxonomy.get(s);
      return !c || c.risk === "blocked" || c.risk === "restricted";
    });
    if (bad.length) return reply.code(400).send({ error: "One of the categories can't be listed. Pick another." });
    const area = app.services.gazetteer.get(p.areaId);
    if (!area) return reply.code(400).send({ error: "Pick your area from the list." });
    const moved = p.areaId !== b.area_id;
    const lat = p.lat ?? (moved || b.lat == null ? area.lat : b.lat);
    const lng = p.lng ?? (moved || b.lng == null ? area.lng : b.lng);
    await db.transaction(async (tx) => {
      await tx.query(
        `UPDATE businesses SET name = $2, description = $3, keywords = $4, phone = $5, area_id = $6, lat = $7, lng = $8,
                address = $9, hours = $10, email = $11, website = $12, trade = $13, updated_at = now()
          WHERE id = $1`,
        [b.id, p.name, p.description, p.keywords, phone, area.id, lat, lng, p.address || null, p.hours, p.email || null, p.website || null, p.trade],
      );
      await tx.query("DELETE FROM business_categories WHERE business_id = $1", [b.id]);
      for (const slug of new Set(p.categories)) {
        await tx.query("INSERT INTO business_categories (business_id, category_slug) VALUES ($1, $2)", [b.id, slug]);
      }
    });
    // Its name and place are on its products in the WhatsApp catalog.
    await markCatalogDirty(db, b.id);
    return { ok: true };
  });

  api.post("/businesses/:id/status", async (req, reply) => {
    const b = await mine(req, reply);
    if (!b) return;
    const body = z.object({ live: z.boolean() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "Say whether the listing is live" });
    // A pause after customer reports or a check by our team is for our team to lift.
    if (body.data.live && b.status === "paused" && b.paused_by && b.paused_by !== "owner") {
      return reply.code(409).send({ error: "Our team paused this listing, so only our team can switch it back on. Contact us if you think it's a mistake." });
    }
    await setBusinessStatus(db, b.id, body.data.live ? "active" : "paused", "owner");
    return { ok: true, status: body.data.live ? "active" : "paused" };
  });

  api.post("/businesses/:id/photos", { bodyLimit: 4 * 1024 * 1024 }, async (req, reply) => {
    const b = await mine(req, reply);
    if (!b) return;
    const body = PhotoUpload.extend({ kind: z.enum(["shopfront", "inside"]) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: problem(body.error) });
    return guard(reply, async () => ({ id: await addBusinessPhoto(db, store, b.id, body.data.kind, body.data) }));
  });

  api.delete("/businesses/:id/photos/:photoId", async (req, reply) => {
    const b = await mine(req, reply);
    if (!b) return;
    const ok = await deletePhoto(db, store, b.id, (req.params as { photoId: string }).photoId);
    return ok ? { ok: true } : reply.code(404).send({ error: "Photo not found" });
  });

  // Photos are private: served only to the owner of the business they belong to.
  api.get("/photos/:photoId", async (req, reply) => {
    const id = (req.params as { photoId: string }).photoId;
    const photo = isUuid(id)
      ? await one<{ storage_key: string; content_type: string }>(
          db,
          `SELECT p.storage_key, p.content_type FROM business_photos p JOIN businesses b ON b.id = p.business_id
            WHERE p.id = $1 AND b.owner_contact_id = $2`,
          [id, req.owner!.contactId],
        )
      : undefined;
    const data = photo ? await store.get(photo.storage_key) : undefined;
    if (!photo || !data) return reply.code(404).send({ error: "Photo not found" });
    return reply.type(photo.content_type).header("Cache-Control", "private, max-age=86400").send(data);
  });

  // ----- Analytics and customers -----

  const Days = z.object({ days: z.coerce.number().int().refine((d) => [7, 30, 90].includes(d)).default(30) });

  api.get("/businesses/:id/analytics", async (req, reply) => {
    const b = await mine(req, reply);
    if (!b) return;
    const q = Days.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "Pick 7, 30 or 90 days" });
    const [analytics, catalogue] = await Promise.all([businessAnalytics(db, b, q.data.days, now()), catalogHealth(db, b.id, now())]);
    return { ...analytics, catalogue };
  });

  api.get("/businesses/:id/customers", async (req, reply) => {
    const b = await mine(req, reply);
    if (!b) return;
    const q = Days.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "Pick 7, 30 or 90 days" });
    return businessCustomers(db, b.id, q.data.days, now());
  });

  // ----- Products -----

  api.get("/businesses/:id/products", async (req, reply) => {
    const b = await mine(req, reply);
    if (!b) return;
    const q = ProductQuery.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: problem(q.error) });
    const [list, health] = await Promise.all([listProducts(db, b.id, q.data, now()), catalogHealth(db, b.id, now())]);
    return { ...list, health };
  });

  api.post("/businesses/:id/products", async (req, reply) => {
    const b = await mine(req, reply);
    if (!b) return;
    const body = ProductInput.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: problem(body.error) });
    return guard(reply, async () => reply.code(201).send(await createProduct(db, b.id, body.data, now())));
  });

  api.get("/businesses/:id/products/:pid", async (req, reply) => {
    const b = await mine(req, reply);
    if (!b) return;
    const pid = (req.params as { pid: string }).pid;
    const product = await getProduct(db, b.id, pid);
    if (!product) return reply.code(404).send({ error: "Product not found" });
    return { ...product, history: await priceHistory(db, b.id, pid) };
  });

  api.put("/businesses/:id/products/:pid", async (req, reply) => {
    const b = await mine(req, reply);
    if (!b) return;
    const body = ProductPatch.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: problem(body.error) });
    return guard(reply, () => updateProduct(db, b.id, (req.params as { pid: string }).pid, body.data, now()));
  });

  const Ids = z.object({ ids: z.array(z.string()).min(1).max(25_000) });

  api.post("/businesses/:id/products/archive", async (req, reply) => {
    const b = await mine(req, reply);
    if (!b) return;
    const body = Ids.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "Choose the products to remove" });
    return { removed: await archiveProducts(db, store, b.id, body.data.ids, now()) };
  });

  api.post("/businesses/:id/products/stock", async (req, reply) => {
    const b = await mine(req, reply);
    if (!b) return;
    const body = Ids.extend({ inStock: z.boolean() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "Choose the products, and in or out of stock" });
    return { updated: await setStock(db, b.id, body.data.ids, body.data.inStock, now()) };
  });

  api.post("/businesses/:id/products/confirm-prices", async (req, reply) => {
    const b = await mine(req, reply);
    if (!b) return;
    const body = z.union([Ids, z.object({ all: z.literal(true) })]).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "Choose the products whose prices are still right" });
    return { confirmed: await confirmPrices(db, b.id, "all" in body.data ? "all" : body.data.ids, now()) };
  });

  api.post("/businesses/:id/products/adjust-prices", async (req, reply) => {
    const b = await mine(req, reply);
    if (!b) return;
    const body = PriceAdjustment.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: problem(body.error) });
    return adjustPrices(db, b.id, body.data, now());
  });

  api.post("/businesses/:id/products/import", { bodyLimit: 8 * 1024 * 1024 }, async (req, reply) => {
    const b = await mine(req, reply);
    if (!b) return;
    const body = ImportRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: problem(body.error) });
    const result = await importProducts(db, b.id, body.data, now());
    // Photos from links arrive in the background, a few at a time.
    if (!body.data.dryRun && result.photos.fetch) await app.services.jobs.enqueueOnce("photo_fetches", "all", {}, now());
    return result;
  });

  // Photos from the links in uploads: how many are still coming, and which links didn't work.
  api.get("/businesses/:id/photo-links", async (req, reply) => {
    const b = await mine(req, reply);
    if (!b) return;
    return photoLinkStatus(db, b.id);
  });

  api.post("/businesses/:id/photo-links/retry", async (req, reply) => {
    const b = await mine(req, reply);
    if (!b) return;
    const retrying = await retryPhotoLinks(db, b.id, now());
    if (retrying) await app.services.jobs.enqueueOnce("photo_fetches", "all", {}, now());
    return { retrying };
  });

  api.post("/businesses/:id/photo-links/clear", async (req, reply) => {
    const b = await mine(req, reply);
    if (!b) return;
    return { cleared: await clearFailedPhotoLinks(db, b.id) };
  });

  // Every product's name and code, to match many photo files to products at once.
  api.get("/businesses/:id/products/index", async (req, reply) => {
    const b = await mine(req, reply);
    if (!b) return;
    return productIndex(db, b.id);
  });

  api.put("/businesses/:id/products/:pid/photo", { bodyLimit: 4 * 1024 * 1024 }, async (req, reply) => {
    const b = await mine(req, reply);
    if (!b) return;
    const body = PhotoUpload.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: problem(body.error) });
    return guard(reply, async () => ({ photoId: await setProductPhoto(db, store, b.id, (req.params as { pid: string }).pid, body.data, now()) }));
  });

  api.delete("/businesses/:id/products/:pid/photo", async (req, reply) => {
    const b = await mine(req, reply);
    if (!b) return;
    return guard(reply, async () => {
      await removeProductPhoto(db, store, b.id, (req.params as { pid: string }).pid, now());
      return { ok: true };
    });
  });
}
