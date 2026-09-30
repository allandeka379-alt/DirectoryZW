import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, registerRoutes } from "../src/http/server.js";
import type { InboundContent } from "../src/whatsapp/types.js";
import { testApp, textOf, type TestApp } from "./helpers.js";

let app: TestApp;
let server: FastifyInstance;
const TOKEN = "admin-portal-test-token";

beforeAll(async () => {
  app = await testApp({ OPS_TOKEN: TOKEN });
  server = createServer({ logger: false });
  registerRoutes(server, app);
  await server.ready();
});
afterAll(async () => {
  await server.close();
  await app.close();
});

// ---------- The team, and business owners ----------

const ops = {
  get: (url: string) => server.inject({ method: "GET", url: `/ops/api${url}`, headers: { authorization: `Bearer ${TOKEN}` } }),
  post: (url: string, payload: unknown = {}) =>
    server.inject({ method: "POST", url: `/ops/api${url}`, headers: { authorization: `Bearer ${TOKEN}` }, payload: payload as object }),
  del: (url: string) => server.inject({ method: "DELETE", url: `/ops/api${url}`, headers: { authorization: `Bearer ${TOKEN}` } }),
};

let seq = 0;
async function write(from: string, content: InboundContent): Promise<void> {
  await app.engine.enqueue({ channel: "customer", route: true, waMessageId: `adm-${++seq}`, from, phone: from, profileName: "Farai", timestamp: app.clock.now, content });
}
const say = (from: string, text: string) => write(from, { type: "text", text });
const lastText = (to: string) => textOf(app.sim.sinceAny(to, 0).at(-1)!.message);
const tokenIn = (text: string) => decodeURIComponent(/\/app\/#signin=([\w%-]+)/.exec(text)![1]!);

async function ownerCookie(owner: string): Promise<string> {
  await say(owner, "dashboard");
  const res = await server.inject({ method: "POST", url: "/app/api/auth/exchange", payload: { token: tokenIn(lastText(owner)) } });
  return `dz_owner=${/dz_owner=([^;]+)/.exec([res.headers["set-cookie"]].flat().join("; "))![1]}`;
}
const asOwner = (cookie: string) => ({
  get: (url: string) => server.inject({ method: "GET", url: `/app/api${url}`, headers: { cookie } }),
  post: (url: string, payload: unknown) => server.inject({ method: "POST", url: `/app/api${url}`, headers: { cookie }, payload: payload as object }),
  put: (url: string, payload: unknown) => server.inject({ method: "PUT", url: `/app/api${url}`, headers: { cookie }, payload: payload as object }),
});

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);
const photo = { contentType: "image/jpeg", dataBase64: JPEG.toString("base64") };

const OWNER = "263779990001";
let code: string;
let bizId: string;
let cookie: string;

describe("the admin portal's pages", () => {
  it("lives at /admin, and the old console address leads there", async () => {
    expect((await server.inject({ url: "/admin" })).headers.location).toBe("/admin/");
    const page = await server.inject({ url: "/admin/" });
    expect(page.headers["content-type"]).toContain("text/html");
    expect(page.body).toContain('src="/admin/admin.js"');
    expect(page.body).toContain('src="/assets/theme.js"');
    for (const url of ["/admin/admin.js", "/admin/admin.css", "/assets/ui.js", "/assets/theme.js"]) {
      expect((await server.inject({ url })).statusCode, url).toBe(200);
    }
    expect((await server.inject({ url: "/ops" })).headers.location).toBe("/admin/");
    expect((await server.inject({ url: "/ops/classic" })).body).toContain("Ops console");
  });

  it("keeps the team's API behind the team's own sign-in, not the owners' dashboard cookie", async () => {
    expect((await server.inject({ url: "/ops/api/summary" })).statusCode).toBe(401);
    expect((await server.inject({ url: "/ops/api/summary", headers: { authorization: "Bearer wrong" } })).statusCode).toBe(401);
    expect((await ops.get("/summary")).statusCode).toBe(200);
  });
});

describe("website sign-ups", () => {
  it("shows registrations waiting for their WhatsApp code, then the listing they became", async () => {
    const options = (await server.inject({ url: "/app/api/public/options" })).json();
    const category = options.categories.find((c: { name: string }) => /hardware/i.test(c.name)) ?? options.categories[0];
    const area = options.areas.find((a: { name: string }) => a.name === "Borrowdale");
    const res = await server.inject({
      method: "POST",
      url: "/app/api/public/register",
      payload: { name: "Farai Tools", categories: [category.slug], areaId: area.id, phone: "0779 990 001", consent: true },
    });
    code = res.json().code;

    const pending = (await ops.get("/web-registrations")).json();
    expect(pending).toEqual([
      expect.objectContaining({ code, name: "Farai Tools", phone: "263779990001", area: "Borrowdale", categories: [category.name], completedAt: null, businessId: null }),
    ]);
    expect((await ops.get("/summary")).json().web_registrations_pending).toBe(1);

    await say(OWNER, `Confirm my business registration ${code}`);
    expect(lastText(OWNER)).toContain("*Farai Tools* is registered");
    expect((await ops.get("/web-registrations")).json()).toEqual([]);
    const done = (await ops.get("/web-registrations?status=completed")).json();
    // The form was cleared once the listing existed: the row points to the business instead.
    expect(done[0]).toMatchObject({ code, name: "Farai Tools", phone: null, businessId: expect.any(String) });
    bizId = done[0].businessId;
    expect((await ops.get("/web-registrations?status=soon")).statusCode).toBe(400);
  });
});

describe("a business, as the team sees it", () => {
  it("shows the owner, their dashboard use, and the catalogue", async () => {
    cookie = await ownerCookie(OWNER);
    const owner = asOwner(cookie);
    await owner.post(`/businesses/${bizId}/products`, { name: "Claw hammer", price: 8.5, category: "Tools" });
    await owner.post(`/businesses/${bizId}/products`, { name: "Knock-off designer watch", price: 15 });

    const b = (await ops.get(`/businesses/${bizId}`)).json();
    expect(b.owner).toMatchObject({ wa_id: OWNER, dashboard_sessions: 1, is_blocked: false });
    expect(b.owner.last_dashboard_sign_in).toBeTruthy();
    expect(b.catalogue).toMatchObject({ total: 2, noPrice: 0, noPhoto: 2 });

    const list = (await ops.get(`/businesses?q=Farai`)).json();
    expect(list[0]).toMatchObject({ name: "Farai Tools", products: 2, has_owner: true, source: "self" });
    expect((await ops.get(`/businesses?q=Farai&source=field`)).json()).toEqual([]);

    const s = (await ops.get("/summary")).json();
    expect(s).toMatchObject({ products_listed: 2, businesses_with_products: 1, owners_on_dashboard_30d: 1, to_verify: expect.any(Number) });
  });

  it("takes down a product, with the reason kept in the activity log", async () => {
    const found = (await ops.get(`/businesses/${bizId}/products?q=designer`)).json();
    expect(found.items).toHaveLength(1);
    const res = await ops.post(`/businesses/${bizId}/products/archive`, { ids: [found.items[0].id], reason: "Counterfeit goods" });
    expect(res.json()).toEqual({ removed: 1 });

    const ownerView = (await asOwner(cookie).get(`/businesses/${bizId}/products`)).json();
    expect(ownerView.items.map((p: { name: string }) => p.name)).toEqual(["Claw hammer"]);
    const [logged] = (await ops.get("/activity?limit=1")).json();
    expect(logged).toMatchObject({ actor: "ops token", action: "product.remove", target: bizId, details: { count: 1, reason: "Counterfeit goods" } });

    expect((await ops.get(`/businesses/00000000-0000-4000-8000-000000000000/products`)).statusCode).toBe(404);
  });

  it("deletes a photo, taking it off the product it belonged to", async () => {
    const owner = asOwner(cookie);
    const hammer = (await owner.get(`/businesses/${bizId}/products?q=hammer`)).json().items[0];
    const { photoId } = (await owner.put(`/businesses/${bizId}/products/${hammer.id}/photo`, photo)).json();
    const shopfront = (await owner.post(`/businesses/${bizId}/photos`, { kind: "shopfront", ...photo })).json().id;

    expect((await ops.get(`/photos/${photoId}`)).statusCode).toBe(200);
    expect((await ops.del(`/businesses/${bizId}/photos/${photoId}`)).statusCode).toBe(200);
    expect((await owner.get(`/businesses/${bizId}/products/${hammer.id}`)).json().photoId).toBeNull();
    expect(await app.files.get(`photos/${bizId}/${photoId}.jpg`)).toBeUndefined();

    expect((await ops.del(`/businesses/${bizId}/photos/${shopfront}`)).statusCode).toBe(200);
    expect((await ops.del(`/businesses/${bizId}/photos/${shopfront}`)).statusCode).toBe(404);
    expect((await ops.get("/activity?limit=1")).json()[0]).toMatchObject({ action: "photo.remove", target: bizId });
  });

  it("signs the owner out of the dashboard everywhere, and spoils unused links", async () => {
    await say(OWNER, "dashboard");
    const unused = tokenIn(lastText(OWNER));
    expect((await asOwner(cookie).get("/me")).statusCode).toBe(200);

    const res = await ops.post(`/businesses/${bizId}/owner/sign-out`);
    expect(res.json()).toEqual({ ended: 1 });
    expect((await asOwner(cookie).get("/me")).statusCode).toBe(401);
    expect((await server.inject({ method: "POST", url: "/app/api/auth/exchange", payload: { token: unused } })).statusCode).toBe(401);
    expect((await ops.get(`/businesses/${bizId}`)).json().owner.dashboard_sessions).toBe(0);
    expect((await ops.get("/activity?limit=1")).json()[0]).toMatchObject({ action: "owner.sign_out", details: { sessions: 1 } });

    // A listing nobody manages from WhatsApp has nobody to sign out.
    const [unowned] = await app.db.query<{ id: string }>("SELECT id FROM businesses WHERE owner_contact_id IS NULL LIMIT 1");
    expect((await ops.post(`/businesses/${unowned!.id}/owner/sign-out`)).statusCode).toBe(409);
  });
});

describe("the overview", () => {
  it("counts each day, in Harare time", async () => {
    const trend = (await ops.get("/trends?days=7")).json();
    expect(trend).toHaveLength(7);
    expect(Object.keys(trend[0]).sort()).toEqual(["businesses", "connections", "date", "requests", "webSignUps"]);
    expect(trend.reduce((n: number, d: { webSignUps: number }) => n + d.webSignUps, 0)).toBe(1);
    expect(trend.reduce((n: number, d: { businesses: number }) => n + d.businesses, 0)).toBeGreaterThanOrEqual(1);
    expect((await ops.get("/trends?days=5")).statusCode).toBe(400);
  });

  it("lists codes that ran out", async () => {
    const options = (await server.inject({ url: "/app/api/public/options" })).json();
    await server.inject({
      method: "POST",
      url: "/app/api/public/register",
      payload: { name: "Slow Shop", categories: [options.categories[0].slug], areaId: options.areas[0].id, phone: "0779 990 002", consent: true },
    });
    app.advanceHours(49);
    const expired = (await ops.get("/web-registrations?status=expired")).json();
    expect(expired.map((r: { name: string }) => r.name)).toEqual(["Slow Shop"]);
    expect((await ops.get("/web-registrations?status=all")).json()).toHaveLength(2);
  });
});
