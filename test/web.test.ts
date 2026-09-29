import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { productQuery, productsOf } from "../src/directory/products.js";
import { createServer, registerRoutes } from "../src/http/server.js";
import { adjustedPrice, parsePrice } from "../src/web/catalog.js";
import type { InboundContent } from "../src/whatsapp/types.js";
import { testApp, textOf, type TestApp } from "./helpers.js";

let app: TestApp;
let server: FastifyInstance;

beforeAll(async () => {
  app = await testApp();
  server = createServer({ logger: false });
  registerRoutes(server, app);
  await server.ready();
});
afterAll(async () => {
  await server.close();
  await app.close();
});

// ---------- WhatsApp, on our one number ----------

let seq = 0;
async function write(from: string, content: InboundContent): Promise<void> {
  await app.engine.enqueue({
    channel: "customer",
    route: true,
    waMessageId: `web-${++seq}`,
    from,
    phone: from,
    profileName: "Rudo",
    timestamp: app.clock.now,
    content,
  });
}
const say = (from: string, text: string) => write(from, { type: "text", text });
const inbox = (to: string) => app.sim.sinceAny(to, 0);
const lastText = (to: string) => textOf(inbox(to).at(-1)!.message);

async function tap(from: string, title: string): Promise<void> {
  for (const { message: m } of [...inbox(from)].reverse()) {
    if (m.kind === "buttons") {
      const b = m.buttons.find((x) => x.title === title);
      if (b) return write(from, { type: "button_reply", id: b.id, title: b.title });
    }
  }
  throw new Error(`No button "${title}" in messages to ${from}`);
}

async function registerOnWhatsApp(owner: string, name: string): Promise<void> {
  await say(owner, "I want to register a business");
  await say(owner, name);
  await say(owner, "We sell and install solar systems and inverters");
  await tap(owner, "Yes, that's right");
  await say(owner, "Borrowdale");
  await tap(owner, "This number");
  await tap(owner, "I agree");
  expect(lastText(owner)).toContain("You're listed!");
}

/** The token in the last sign-in link we sent this person. */
function tokenIn(text: string): string {
  const m = /\/app\/\?signin=([\w%-]+)/.exec(text);
  if (!m) throw new Error(`No sign-in link in: ${text}`);
  return decodeURIComponent(m[1]!);
}

async function linkFor(owner: string): Promise<string> {
  await say(owner, "dashboard");
  return tokenIn(lastText(owner));
}

const exchange = (token: string) => server.inject({ method: "POST", url: "/app/api/auth/exchange", payload: { token } });

async function signIn(owner: string): Promise<string> {
  const res = await exchange(await linkFor(owner));
  expect(res.statusCode).toBe(200);
  const cookie = [res.headers["set-cookie"]].flat().join("; ");
  return `dz_owner=${/dz_owner=([^;]+)/.exec(cookie)![1]}`;
}

/** Calls to the dashboard API as a signed-in owner. */
function as(cookie: string) {
  const call = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: unknown) =>
    server.inject({ method, url: `/app/api${url}`, headers: { cookie }, ...(payload === undefined ? {} : { payload: payload as object }) });
  return {
    get: (url: string) => call("GET", url),
    post: (url: string, payload: unknown = {}) => call("POST", url, payload),
    put: (url: string, payload: unknown) => call("PUT", url, payload),
    del: (url: string) => call("DELETE", url),
  };
}

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);
const photo = (bytes = JPEG) => ({ contentType: "image/jpeg", dataBase64: bytes.toString("base64") });

/** What a customer's search finds among a business's products, live. */
async function found(businessId: string, asked: string): Promise<string[]> {
  return (await productsOf(app.db, businessId, productQuery(asked, app.services.lexicon), 10)).map((m) => m.name);
}

// ---------- The owners in these tests ----------

const OWNER = "263776660001";
const OTHER = "263776660002";
let owner: ReturnType<typeof as>;
let other: ReturnType<typeof as>;
let bizId: string;
let otherBizId: string;

describe("signing in to the dashboard", () => {
  it("sends a one-time link on WhatsApp, and trades it for a session once", async () => {
    await registerOnWhatsApp(OWNER, "Rudo Hardware");
    expect(lastText(OWNER)).toContain("*dashboard*");

    const token = await linkFor(OWNER);
    expect(lastText(OWNER)).toContain("It works once, for 15 minutes");
    expect((await server.inject({ url: "/app/api/me" })).statusCode).toBe(401);

    const res = await exchange(token);
    expect(res.statusCode).toBe(200);
    const setCookie = [res.headers["set-cookie"]].flat().join("; ");
    expect(setCookie).toMatch(/dz_owner=[\w-]+/);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Path=/app");

    // The link is spent: a forwarded or previewed link can't sign anyone else in.
    expect((await exchange(token)).statusCode).toBe(401);
    expect((await exchange("not-a-real-token-at-all")).statusCode).toBe(401);

    owner = as(`dz_owner=${/dz_owner=([^;]+)/.exec(setCookie)![1]}`);
    const me = (await owner.get("/me")).json();
    expect(me.businesses).toHaveLength(1);
    expect(me.businesses[0]).toMatchObject({ name: "Rudo Hardware", status: "active", verification: "registered", area: "Borrowdale", products: 0 });
    expect(me.stalePriceDays).toBe(30);
    bizId = me.businesses[0].id;
  });

  it("lets a link expire after 15 minutes", async () => {
    const token = await linkFor(OWNER);
    app.clock.now = new Date(app.clock.now.getTime() + 16 * 60_000);
    expect((await exchange(token)).statusCode).toBe(401);
  });

  it("signs out", async () => {
    const cookie = await signIn(OWNER);
    const session = as(cookie);
    expect((await session.get("/me")).statusCode).toBe(200);
    const out = await session.post("/auth/logout");
    expect(out.statusCode).toBe(200);
    expect([out.headers["set-cookie"]].flat().join("; ")).toContain("Max-Age=0");
    expect((await session.get("/me")).statusCode).toBe(401);
  });

  it("keeps 'dashboard' a search for people without a listing", async () => {
    const stranger = "263776660009";
    await say(stranger, "dashboard");
    expect(inbox(stranger).every((m) => m.channel === "customer")).toBe(true);
    expect(inbox(stranger).some((m) => textOf(m.message).includes("signin="))).toBe(false);
  });

  it("sends the link from the sign-in page when WhatsApp lets us reply free, and always answers the same", async () => {
    const before = inbox(OWNER).length;
    const res = await server.inject({ method: "POST", url: "/app/api/auth/request", payload: { phone: "0776 660 001" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().whatsappLink).toMatch(/^https:\/\/wa\.me\/\d*\?text=dashboard$/);
    expect(inbox(OWNER).length).toBe(before + 1);
    expect(tokenIn(lastText(OWNER))).toBeTruthy();

    // A number we don't know gets the same answer, and nothing is sent.
    const unknown = await server.inject({ method: "POST", url: "/app/api/auth/request", payload: { phone: "0776 660 099" } });
    expect(unknown.json()).toEqual(res.json());
    expect(inbox("263776660099")).toHaveLength(0);

    const bad = await server.inject({ method: "POST", url: "/app/api/auth/request", payload: { phone: "12345" } });
    expect(bad.statusCode).toBe(400);
  });

  it("refuses changes posted from another website", async () => {
    const res = await server.inject({ method: "POST", url: "/app/api/auth/logout", headers: { origin: "https://evil.example" }, payload: {} });
    expect(res.statusCode).toBe(403);
  });
});

describe("one owner's businesses", () => {
  it("never shows another owner's business, products or photos", async () => {
    await registerOnWhatsApp(OTHER, "Chipo Paints");
    other = as(await signIn(OTHER));
    otherBizId = (await other.get("/me")).json().businesses[0].id;

    for (const url of [`/businesses/${otherBizId}`, `/businesses/${otherBizId}/products`, `/businesses/${otherBizId}/analytics`, "/businesses/not-a-uuid"]) {
      expect((await owner.get(url)).statusCode, url).toBe(404);
    }
    expect((await owner.post(`/businesses/${otherBizId}/products`, { name: "Sneaky" })).statusCode).toBe(404);
    expect((await owner.post(`/businesses/${otherBizId}/status`, { live: false })).statusCode).toBe(404);

    const added = (await other.post(`/businesses/${otherBizId}/photos`, { kind: "shopfront", ...photo() })).json();
    expect((await other.get(`/photos/${added.id}`)).statusCode).toBe(200);
    expect((await owner.get(`/photos/${added.id}`)).statusCode).toBe(404);
  });
});

describe("products", () => {
  let cementId: string;

  it("adds a product, keeps codes unique, and feeds its name to search", async () => {
    const res = await owner.post(`/businesses/${bizId}/products`, { name: "Cement 50kg", price: 11.5, unit: "bag", sku: "CEM-50", category: "Building materials" });
    expect(res.statusCode).toBe(201);
    const p = res.json();
    expect(p).toMatchObject({ name: "Cement 50kg", price: 11.5, unit: "bag", sku: "CEM-50", category: "Building materials", inStock: true, photoId: null, source: "dashboard" });
    expect(p.priceUpdatedAt).toBeTruthy();
    cementId = p.id;

    const dup = await owner.post(`/businesses/${bizId}/products`, { name: "Cement again", sku: "cem-50" });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error).toBe("Cement 50kg already uses the code CEM-50.");
    expect((await owner.post(`/businesses/${bizId}/products`, { name: "" })).statusCode).toBe(400);
    expect((await owner.post(`/businesses/${bizId}/products`, { name: "Free money", price: -5 })).statusCode).toBe(400);

    expect(await found(bizId, "do you have cement?")).toEqual(["Cement 50kg"]);
  });

  it("changes a price, dates it and keeps the history", async () => {
    const updated = (await owner.put(`/businesses/${bizId}/products/${cementId}`, { price: 12 })).json();
    expect(updated.price).toBe(12);
    await owner.put(`/businesses/${bizId}/products/${cementId}`, { price: 12, description: "Portland cement" }); // same price: no new entry
    const detail = (await owner.get(`/businesses/${bizId}/products/${cementId}`)).json();
    expect(detail.description).toBe("Portland cement");
    expect(detail.history.map((c: { oldPrice: number | null; newPrice: number | null; reason: string }) => [c.oldPrice, c.newPrice, c.reason])).toEqual([
      [11.5, 12, "edit"],
      [null, 11.5, "edit"],
    ]);

    // Clearing the price means "ask us".
    const cleared = (await owner.put(`/businesses/${bizId}/products/${cementId}`, { price: null })).json();
    expect(cleared.price).toBeNull();
    await owner.put(`/businesses/${bizId}/products/${cementId}`, { price: 12 });
  });

  it("finds products by name, code and category, and flags prices to confirm", async () => {
    await owner.post(`/businesses/${bizId}/products`, { name: "PVC pipe 2m", price: 4.2, sku: "PVC-2", category: "Plumbing" });
    await owner.post(`/businesses/${bizId}/products`, { name: "Tap washer", category: "Plumbing" });

    const byName = (await owner.get(`/businesses/${bizId}/products?q=pipe`)).json();
    expect(byName.items.map((p: { name: string }) => p.name)).toEqual(["PVC pipe 2m"]);
    const byCode = (await owner.get(`/businesses/${bizId}/products?q=cem-`)).json();
    expect(byCode.items.map((p: { name: string }) => p.name)).toEqual(["Cement 50kg"]);
    const byCategory = (await owner.get(`/businesses/${bizId}/products?category=Plumbing&sort=price`)).json();
    expect(byCategory.items.map((p: { name: string }) => p.name)).toEqual(["PVC pipe 2m", "Tap washer"]);
    expect(byCategory.total).toBe(2);

    // A price older than 30 days needs confirming.
    await app.db.query("UPDATE offerings SET price_updated_at = $2 WHERE id = $1", [cementId, new Date(app.clock.now.getTime() - 40 * 24 * 3600_000)]);
    const list = (await owner.get(`/businesses/${bizId}/products?needs=price`)).json();
    expect(list.items.map((p: { name: string }) => p.name).sort()).toEqual(["Cement 50kg", "Tap washer"]);
    expect(list.health).toMatchObject({ total: 3, noPrice: 1, stale: 1, outOfStock: 0, noPhoto: 3 });
    expect(list.health.categories).toEqual([
      { category: "Building materials", n: 1 },
      { category: "Plumbing", n: 2 },
    ]);

    const confirmed = (await owner.post(`/businesses/${bizId}/products/confirm-prices`, { ids: [cementId] })).json();
    expect(confirmed.confirmed).toBe(1);
    expect((await owner.get(`/businesses/${bizId}/products`)).json().health.stale).toBe(0);
    expect((await owner.get(`/businesses/${bizId}/products?limit=500`)).statusCode).toBe(400);
  });

  it("takes products out of stock and out of search, and back", async () => {
    await owner.post(`/businesses/${bizId}/products/stock`, { ids: [cementId], inStock: false });
    expect(await found(bizId, "cement")).toEqual([]);
    expect((await owner.get(`/businesses/${bizId}/products?stock=out`)).json().items).toHaveLength(1);

    await owner.put(`/businesses/${bizId}/products/${cementId}`, { inStock: true });
    expect(await found(bizId, "cement")).toEqual(["Cement 50kg"]);
  });

  it("removes products, and their photos", async () => {
    const res = await owner.post(`/businesses/${bizId}/products`, { name: "Old stock", price: 1 });
    const id = res.json().id;
    const { photoId } = (await owner.put(`/businesses/${bizId}/products/${id}/photo`, photo())).json();
    expect(await app.files.get(`photos/${bizId}/${photoId}.jpg`)).toBeTruthy();

    expect((await owner.post(`/businesses/${bizId}/products/archive`, { ids: [id] })).json().removed).toBe(1);
    expect((await owner.get(`/businesses/${bizId}/products/${id}`)).statusCode).toBe(404);
    expect(await found(bizId, "old stock")).toEqual([]);
    expect(await app.files.get(`photos/${bizId}/${photoId}.jpg`)).toBeUndefined();
    expect((await owner.get(`/photos/${photoId}`)).statusCode).toBe(404);
  });
});

describe("changing many prices at once", () => {
  it("rounds the way shops price", () => {
    expect(adjustedPrice(10, "percent", 10, "cents")).toBe(11);
    expect(adjustedPrice(19.99, "percent", 10, "0.05")).toBe(22);
    expect(adjustedPrice(4.2, "percent", -15, "0.10")).toBe(3.6);
    expect(adjustedPrice(12.34, "percent", 0, "1")).toBe(12);
    expect(adjustedPrice(7.3, "amount", 0.5, "0.50")).toBe(8);
    expect(adjustedPrice(1, "amount", -5, "cents")).toBe(0);
    expect(adjustedPrice(null, "percent", 10, "cents")).toBeNull();
    expect(adjustedPrice(null, "set", 5, "cents")).toBe(5);
  });

  it("previews, then applies, and records each change", async () => {
    const add = async (name: string, price: number | null) => (await owner.post(`/businesses/${bizId}/products`, { name, price, category: "Paint" })).json().id as string;
    const white = await add("White paint 5L", 20);
    const blue = await add("Blue paint 5L", 19.99);
    await add("Paint brush", null);

    const preview = (await owner.post(`/businesses/${bizId}/products/adjust-prices`, { scope: { category: "Paint" }, mode: "percent", value: 10, round: "0.05", dryRun: true })).json();
    expect(preview.count).toBe(2);
    expect(preview.skipped).toBe(1); // the brush has no price to raise
    expect(preview.preview).toEqual([
      { id: blue, name: "Blue paint 5L", oldPrice: 19.99, newPrice: 22 },
      { id: white, name: "White paint 5L", oldPrice: 20, newPrice: 22 },
    ]);
    expect((await owner.get(`/businesses/${bizId}/products/${white}`)).json().price).toBe(20); // nothing changed yet

    const done = (await owner.post(`/businesses/${bizId}/products/adjust-prices`, { scope: { category: "Paint" }, mode: "percent", value: 10, round: "0.05" })).json();
    expect(done.count).toBe(2);
    const detail = (await owner.get(`/businesses/${bizId}/products/${white}`)).json();
    expect(detail.price).toBe(22);
    expect(detail.history[0]).toMatchObject({ oldPrice: 20, newPrice: 22, reason: "bulk" });

    const cut = (await owner.post(`/businesses/${bizId}/products/adjust-prices`, { scope: { ids: [white] }, mode: "amount", value: -2 })).json();
    expect(cut.count).toBe(1);
    expect((await owner.get(`/businesses/${bizId}/products/${white}`)).json().price).toBe(20);

    // Another owner's product IDs change nothing here.
    const theirs = (await other.post(`/businesses/${otherBizId}/products`, { name: "Their paint", price: 10 })).json().id;
    const sneaky = (await owner.post(`/businesses/${bizId}/products/adjust-prices`, { scope: { ids: [theirs] }, mode: "set", value: 1 })).json();
    expect(sneaky.count).toBe(0);
    expect((await other.get(`/businesses/${otherBizId}/products/${theirs}`)).json().price).toBe(10);

    expect((await owner.post(`/businesses/${bizId}/products/adjust-prices`, { scope: { all: true }, mode: "double", value: 2 })).statusCode).toBe(400);
  });
});

describe("uploading a price list", () => {
  it("reads prices the ways people write them", () => {
    expect(parsePrice("$1,250.00")).toBe(1250);
    expect(parsePrice("US$ 12")).toBe(12);
    expect(parsePrice("12,50")).toBe(12.5);
    expect(parsePrice("1.234,56")).toBe(1234.56);
    expect(parsePrice("")).toBeNull();
    expect(parsePrice("POA")).toBeNull();
    expect(parsePrice("cheap")).toBeUndefined();
  });

  it("checks a list without changing anything, then imports it", async () => {
    const rows = [
      { name: "Roofing nails 1kg", price: "$3.50", sku: "NAIL-1", category: "Fasteners", inStock: "yes" },
      { name: "Hinges (pair)", price: "2,40", sku: "HNG-2" },
      { name: "Mystery item", price: "cheap" },
      { name: "", price: "1" },
      { name: "Nails again", price: "3", sku: "nail-1" },
      { name: "Gloves", price: "1", inStock: "maybe" },
    ];
    const before = (await owner.get(`/businesses/${bizId}/products`)).json().health.total;
    const check = (await owner.post(`/businesses/${bizId}/products/import`, { rows, dryRun: true })).json();
    expect(check).toMatchObject({ added: 2, updated: 0, unchanged: 0, errors: 4 });
    expect(check.rows.filter((r: { action: string }) => r.action === "error").map((r: { row: number; error: string }) => [r.row, r.error])).toEqual([
      [3, '"cheap" isn\'t a price'],
      [4, "No product name"],
      [5, "The code nail-1 is in the file twice"],
      [6, '"maybe" isn\'t yes or no'],
    ]);
    expect((await owner.get(`/businesses/${bizId}/products`)).json().health.total).toBe(before);

    const done = (await owner.post(`/businesses/${bizId}/products/import`, { rows })).json();
    expect(done).toMatchObject({ added: 2, errors: 4 });
    const nails = (await owner.get(`/businesses/${bizId}/products?q=NAIL-1`)).json().items[0];
    expect(nails).toMatchObject({ name: "Roofing nails 1kg", price: 3.5, category: "Fasteners", source: "import" });
    expect(await found(bizId, "roofing nails")).toEqual(["Roofing nails 1kg"]);
  });

  it("updates listed products by code or name, and leaves out columns alone", async () => {
    const nails = (await owner.get(`/businesses/${bizId}/products?q=NAIL-1`)).json().items[0];
    await owner.put(`/businesses/${bizId}/products/${nails.id}`, { description: "Galvanised", unit: "kg" });

    // A file with only names, codes and prices: the description, unit and category stay.
    const res = (
      await owner.post(`/businesses/${bizId}/products/import`, {
        rows: [
          { name: "Roofing nails 1kg", sku: "NAIL-1", price: "3.80" },
          { name: "Hinges (pair)", sku: "HNG-2", price: "2.40" },
          { name: "PVC PIPE 2M", price: "4.50" },
        ],
      })
    ).json();
    expect(res).toMatchObject({ added: 0, updated: 2, unchanged: 1, errors: 0 });
    const after = (await owner.get(`/businesses/${bizId}/products/${nails.id}`)).json();
    expect(after).toMatchObject({ price: 3.8, description: "Galvanised", unit: "kg", category: "Fasteners" });
    expect(after.history[0]).toMatchObject({ oldPrice: 3.5, newPrice: 3.8, reason: "import" });
    const pipe = (await owner.get(`/businesses/${bizId}/products?q=pvc`)).json().items[0];
    expect(pipe.price).toBe(4.5); // matched by name, whatever the case

    const untouched = (await owner.post(`/businesses/${bizId}/products/import`, { rows: [{ name: "Roofing nails 1kg", sku: "NAIL-1", price: "9" }], updateExisting: false })).json();
    expect(untouched).toMatchObject({ added: 0, updated: 0, unchanged: 1 });
    expect((await owner.get(`/businesses/${bizId}/products/${nails.id}`)).json().price).toBe(3.8);
  });

  it("takes at most 2,000 rows a request", async () => {
    const rows = Array.from({ length: 2001 }, (_, i) => ({ name: `Item ${i}` }));
    expect((await owner.post(`/businesses/${bizId}/products/import`, { rows })).statusCode).toBe(400);
  });
});

describe("photos", () => {
  it("attaches a product photo, replaces it, and serves it only to the owner", async () => {
    const id = (await owner.post(`/businesses/${bizId}/products`, { name: "Wheelbarrow", price: 45 })).json().id;
    const first = (await owner.put(`/businesses/${bizId}/products/${id}/photo`, photo())).json().photoId;
    const served = await owner.get(`/photos/${first}`);
    expect(served.statusCode).toBe(200);
    expect(served.headers["content-type"]).toBe("image/jpeg");
    expect(served.headers["cache-control"]).toContain("private");
    expect(served.rawPayload.equals(JPEG)).toBe(true);
    expect((await other.get(`/photos/${first}`)).statusCode).toBe(404);
    expect((await server.inject({ url: `/app/api/photos/${first}` })).statusCode).toBe(401);

    const second = (await owner.put(`/businesses/${bizId}/products/${id}/photo`, photo())).json().photoId;
    expect(second).not.toBe(first);
    expect(await app.files.get(`photos/${bizId}/${first}.jpg`)).toBeUndefined();
    expect((await owner.get(`/businesses/${bizId}/products/${id}`)).json().photoId).toBe(second);

    expect((await owner.del(`/businesses/${bizId}/products/${id}/photo`)).statusCode).toBe(200);
    expect((await owner.get(`/businesses/${bizId}/products/${id}`)).json().photoId).toBeNull();
  });

  it("refuses files that aren't photos", async () => {
    const id = (await owner.post(`/businesses/${bizId}/products`, { name: "Spade", price: 12 })).json().id;
    const res = await owner.put(`/businesses/${bizId}/products/${id}/photo`, { contentType: "image/jpeg", dataBase64: Buffer.from("<script>alert(1)</script>").toString("base64") });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("isn't a photo");
    const gif = await owner.put(`/businesses/${bizId}/products/${id}/photo`, { contentType: "image/gif", dataBase64: JPEG.toString("base64") });
    expect(gif.statusCode).toBe(400);
  });

  it("keeps up to eight shopfront and inside photos", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 8; i++) {
      const res = await owner.post(`/businesses/${bizId}/photos`, { kind: i % 2 ? "inside" : "shopfront", ...photo() });
      expect(res.statusCode).toBe(200);
      ids.push(res.json().id);
    }
    const ninth = await owner.post(`/businesses/${bizId}/photos`, { kind: "inside", ...photo() });
    expect(ninth.statusCode).toBe(400);
    expect((await owner.get(`/businesses/${bizId}`)).json().photos).toHaveLength(8);

    expect((await owner.del(`/businesses/${bizId}/photos/${ids[0]}`)).statusCode).toBe(200);
    expect((await owner.del(`/businesses/${bizId}/photos/${ids[0]}`)).statusCode).toBe(404);
    expect((await owner.get(`/businesses/${bizId}`)).json().photos).toHaveLength(7);
  });
});

describe("the business profile", () => {
  it("saves the details customers see", async () => {
    const options = (await owner.get("/options")).json();
    const mabelreign = options.areas.find((a: { name: string }) => a.name === "Mabelreign");
    const profile = (await owner.get(`/businesses/${bizId}`)).json();
    expect(profile).toMatchObject({ name: "Rudo Hardware", area: "Borrowdale", trade: "retail", verification: "registered" });

    const res = await owner.put(`/businesses/${bizId}`, {
      ...profile,
      name: "Rudo Hardware & Paint",
      areaId: mabelreign.id,
      lat: null,
      lng: null,
      hours: "Mon to Sat, 8am to 5pm",
      email: "sales@rudo.example",
      website: "rudo.example",
      address: "Shop 4, Mabelreign Centre",
      trade: "both",
    });
    expect(res.statusCode).toBe(200);
    const saved = (await owner.get(`/businesses/${bizId}`)).json();
    expect(saved).toMatchObject({ name: "Rudo Hardware & Paint", area: "Mabelreign", hours: "Mon to Sat, 8am to 5pm", email: "sales@rudo.example", trade: "both" });
    expect(saved.lat).toBeCloseTo(app.services.gazetteer.get(mabelreign.id)!.lat); // moved to the new area's centre

    expect((await owner.put(`/businesses/${bizId}`, { ...saved, email: "not an email" })).statusCode).toBe(400);
    expect((await owner.put(`/businesses/${bizId}`, { ...saved, categories: [] })).statusCode).toBe(400);
  });

  it("leaves a verified business's number to our team", async () => {
    await app.db.query("UPDATE businesses SET verification = 'verified' WHERE id = $1", [bizId]);
    const profile = (await owner.get(`/businesses/${bizId}`)).json();
    expect((await owner.put(`/businesses/${bizId}`, { ...profile, phone: "0771 999 888" })).statusCode).toBe(409);
    expect((await owner.put(`/businesses/${bizId}`, { ...profile, hours: "Every day" })).statusCode).toBe(200);
    await app.db.query("UPDATE businesses SET verification = 'registered' WHERE id = $1", [bizId]);
  });

  it("pauses and restarts the listing", async () => {
    expect((await owner.post(`/businesses/${bizId}/status`, { live: false })).json().status).toBe("paused");
    expect((await owner.get("/me")).json().businesses[0].status).toBe("paused");
    expect((await owner.post(`/businesses/${bizId}/status`, { live: true })).json().status).toBe("active");
  });
});

describe("analytics", () => {
  it("counts searches, customers and demand", async () => {
    // Our owner takes over the sample plumber, which customers find in Mabelreign.
    const [contact] = await app.db.query<{ id: string }>("SELECT id FROM contacts WHERE channel = 'business' AND wa_id = $1", [OWNER]);
    const [plumber] = await app.db.query<{ id: string }>("UPDATE businesses SET owner_contact_id = $1 WHERE name = 'QuickFix Plumbing (sample)' RETURNING id", [contact!.id]);

    const customer = "263776660050";
    await app.say("I need a plumber in Mabelreign", customer);
    await app.tap("I agree", "customer", customer);
    await app.tap("QuickFix", "customer", customer);
    await app.tap("Connect me", "customer", customer);

    const a = (await owner.get(`/businesses/${plumber!.id}/analytics?days=7`)).json();
    expect(a.days).toBe(7);
    expect(a.daily).toHaveLength(7);
    expect(a.kpis.shown).toBeGreaterThanOrEqual(1);
    expect(a.kpis.connections).toBe(1);
    expect(a.kpis.connectionRate).toBeGreaterThan(0);
    expect(a.daily.reduce((s: number, d: { connections: number }) => s + d.connections, 0)).toBe(1);
    expect(a.topAsks.length).toBeGreaterThanOrEqual(1);
    expect(a.market.requests).toBeGreaterThanOrEqual(1);
    expect(a.market.hours).toHaveLength(24);
    expect(a.catalogue).toMatchObject({ total: expect.any(Number), noPhoto: expect.any(Number) });

    const customers = (await owner.get(`/businesses/${plumber!.id}/customers?days=30`)).json();
    expect(customers).toHaveLength(1);
    expect(customers[0].ref).toMatch(/^[A-Z0-9]{5}$/);
    expect(customers[0].what).toContain("plumber");
    expect(JSON.stringify(customers)).not.toContain(customer); // never the customer's number

    expect((await owner.get(`/businesses/${plumber!.id}/analytics?days=5`)).statusCode).toBe(400);
  });
});

describe("registering on the website", () => {
  it("creates the listing when the owner sends the code from WhatsApp", async () => {
    const options = (await server.inject({ url: "/app/api/public/options" })).json();
    expect(options.brand).toBe("TestDir");
    const category = options.categories.find((c: { slug: string; name: string }) => /hardware/i.test(c.name)) ?? options.categories[0];
    const avondale = options.areas.find((a: { name: string }) => a.name === "Avondale");

    const form = {
      name: "Tino's Hardware",
      categories: [category.slug],
      description: "Tools, paint and building materials",
      areaId: avondale.id,
      address: "12 King George Road",
      phone: "0776 660 100",
      hours: "Mon to Fri, 8 to 5",
      email: "",
      website: "",
      trade: "retail",
      consent: true,
    };
    expect((await server.inject({ method: "POST", url: "/app/api/public/register", payload: { ...form, consent: false } })).statusCode).toBe(400);
    const res = await server.inject({ method: "POST", url: "/app/api/public/register", payload: form });
    expect(res.statusCode).toBe(200);
    const { code, whatsappLink } = res.json();
    expect(code).toMatch(/^REG-\d{6}$/);
    expect(decodeURIComponent(whatsappLink)).toContain(`Confirm my business registration ${code}`);

    const ownerPhone = "263776660101"; // the owner's own WhatsApp, not the shop's number
    await say(ownerPhone, `Confirm my business registration ${code}`);
    expect(inbox(ownerPhone).at(-1)!.channel).toBe("business");
    expect(lastText(ownerPhone)).toContain("*Tino's Hardware* is registered");
    const token = tokenIn(lastText(ownerPhone));

    const [biz] = await app.db.query<{ phone: string; source: string; status: string; hours: string; address: string; owner: string }>(
      `SELECT b.phone, b.source, b.status, b.hours, b.address, c.wa_id AS owner FROM businesses b JOIN contacts c ON c.id = b.owner_contact_id
        WHERE b.name = $1`,
      ["Tino's Hardware"],
    );
    expect(biz).toMatchObject({ phone: "263776660100", source: "self", status: "active", hours: "Mon to Fri, 8 to 5", address: "12 King George Road", owner: ownerPhone });

    // The form is cleared once it has done its job.
    const [reg] = await app.db.query<{ details: object; completed_at: Date | null }>("SELECT details, completed_at FROM web_registrations WHERE code = $1", [code]);
    expect(reg!.details).toEqual({});
    expect(reg!.completed_at).toBeTruthy();

    // The link in the reply signs the owner in.
    expect((await exchange(token)).statusCode).toBe(200);

    // The code works once.
    await say(ownerPhone, code);
    expect(lastText(ownerPhone)).toContain("That code has already been used");
    await say(ownerPhone, "REG-000000");
    expect(lastText(ownerPhone)).toContain("We couldn't find that registration code");
  });

  it("refuses categories that can't be listed and areas we don't know", async () => {
    const options = (await server.inject({ url: "/app/api/public/options" })).json();
    const base = { name: "Somewhere", categories: [options.categories[0].slug], areaId: options.areas[0].id, phone: "0776 660 200", consent: true };
    expect((await server.inject({ method: "POST", url: "/app/api/public/register", payload: { ...base, categories: ["no-such-category"] } })).statusCode).toBe(400);
    expect((await server.inject({ method: "POST", url: "/app/api/public/register", payload: { ...base, areaId: 999999 } })).statusCode).toBe(400);
    expect((await server.inject({ method: "POST", url: "/app/api/public/register", payload: { ...base, phone: "12" } })).statusCode).toBe(400);
  });

  it("lets a code expire after 48 hours", async () => {
    const options = (await server.inject({ url: "/app/api/public/options" })).json();
    const res = await server.inject({
      method: "POST",
      url: "/app/api/public/register",
      payload: { name: "Late Shop", categories: [options.categories[0].slug], areaId: options.areas[0].id, phone: "0776 660 300", consent: true },
    });
    const { code } = res.json();
    app.advanceHours(49);
    await say("263776660301", code);
    expect(lastText("263776660301")).toContain("That registration code has expired");
  });
});

describe("the website and app pages", () => {
  it("serves the home page, the registration form and the app", async () => {
    const home = await server.inject({ url: "/" });
    expect(home.statusCode).toBe(200);
    expect(home.headers["content-type"]).toContain("text/html");
    expect(home.body).toContain("TestDir");
    expect(home.body).not.toContain("{{brand}}");

    const register = await server.inject({ url: "/register" });
    expect(register.body).toContain("/assets/register.js");

    expect((await server.inject({ url: "/app" })).statusCode).toBe(302);
    const shell = await server.inject({ url: "/app/" });
    expect(shell.body).toContain('src="/app/app.js"');
    for (const url of ["/app/app.js", "/app/charts.js", "/app/sheets.js", "/app/app.css", "/assets/base.css", "/assets/site.css", "/assets/logo.svg"]) {
      expect((await server.inject({ url })).statusCode, url).toBe(200);
    }
    const template = await server.inject({ url: "/app/products-template.csv" });
    expect(template.headers["content-disposition"]).toContain("products-template.csv");
    expect(template.body.split("\n")[0]).toBe("name,price,unit,sku,category,description,in_stock");
  });

  it("stops sending sign-in links once the owner's free window has closed", async () => {
    app.advanceHours(25);
    const before = inbox(OTHER).length;
    const res = await server.inject({ method: "POST", url: "/app/api/auth/request", payload: { phone: OTHER } });
    expect(res.statusCode).toBe(200);
    expect(inbox(OTHER).length).toBe(before); // they tap the WhatsApp button instead, which is free
  });
});
