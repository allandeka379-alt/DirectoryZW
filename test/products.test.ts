import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MATCH_THRESHOLD,
  productQuery,
  productTokens,
  productWords,
  scoreProduct,
  searchProducts,
  wordsToMatch,
  type ProductSearch,
} from "../src/directory/products.js";
import { createServer, registerRoutes } from "../src/http/server.js";
import { MemoryCatalog, syncCatalog, type CatalogClient } from "../src/whatsapp/catalog.js";
import { normalize, toCloudPayload, type OutboundMessage } from "../src/whatsapp/outbound.js";
import { testApp, textOf, type TestApp } from "./helpers.js";
import { dashboardOf, newCustomer, photo } from "./shops.js";

const catalog = new MemoryCatalog("test-catalog");
let app: TestApp;
let server: FastifyInstance;

beforeAll(async () => {
  app = await testApp({}, { catalog });
  server = createServer({ logger: false });
  registerRoutes(server, app);
  await server.ready();
});
afterAll(async () => {
  await server.close();
  await app.close();
});

type More = { category?: string; description?: string };
const score = (asked: string, name: string, more: More = {}) =>
  scoreProduct(productQuery(asked, app.services.lexicon), productWords({ name, ...more })).score;
const matches = (asked: string, name: string, more: More = {}) => score(asked, name, more) >= MATCH_THRESHOLD;

/** Background jobs, a minute on, as they'd run. */
async function aMinuteLater(): Promise<void> {
  app.advanceHours(1 / 60);
  await app.runJobs();
}

/** What a results list says under each business. */
function rowsOf(m: OutboundMessage): string[] {
  if (m.kind !== "list") throw new Error(`Expected a list, got ${m.kind}`);
  return m.sections.flatMap((s) => s.rows.map((r) => r.description ?? ""));
}

const idOf = async (name: string) => (await app.db.query<{ id: string }>("SELECT id FROM businesses WHERE name = $1", [name]))[0]!.id;

/** A product put straight into the database, as an import would. */
async function listed(businessId: string, p: { name: string; price?: number | null; inStock?: boolean; archived?: boolean }): Promise<string> {
  const rows = await app.db.query<{ id: string }>(
    `INSERT INTO offerings (business_id, name, price_usd, in_stock, archived_at, source, price_updated_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, 'import', $6, $6) RETURNING id`,
    [businessId, p.name, p.price ?? null, p.inStock ?? true, p.archived ? app.clock.now : null, app.clock.now],
  );
  return rows[0]!.id;
}

describe("reading product names", () => {
  it("writes sizes and units one way", () => {
    const words = (s: string) =>
      productTokens(s).map((t) => (t.unit && !t.num ? `[${t.unit}]` : t.num ? `${t.num}${t.unit ? `(${t.unit})` : ""}` : t.text));
    expect(words('Samsung 55" Smart TV')).toEqual(["samsung", "55(inch)", "[inch]", "smart", "tv"]);
    expect(words("Samsung 55-inch smart TV")).toEqual(["samsung", "55(inch)", "[inch]", "smart", "tv"]);
    expect(words("Fridge 300L")).toEqual(["fridge", "300(l)", "[l]"]);
    expect(words("fridge 300 litres")).toEqual(["fridge", "300(l)", "[l]"]);
    expect(words("Generator 2.5 kVA")).toEqual(["generator", "2.5(kva)", "[kva]"]);
    expect(words("PPC Cement 50kg")).toEqual(["ppc", "cement", "50(kg)", "[kg]"]);
    expect(words("Washing machine 7kg")).toEqual(["washingmachine", "7(kg)", "[kg]"]);
    expect(words("Mealie meal 10kg")).toEqual(["mealiemeal", "10(kg)", "[kg]"]);
  });

  it("notes what comes with a product and what it's made for", () => {
    const flags = (s: string) => productTokens(s).map((t) => `${t.text}${t.bundled ? "+" : ""}${t.fitsOther ? ">" : ""}`);
    expect(flags("Samsung TV with free wall bracket")).toEqual(["samsung", "tv", "wall+", "bracket+"]);
    expect(flags("Samsung TV + bracket")).toEqual(["samsung", "tv", "bracket+"]);
    expect(flags("Bracket for Samsung TV")).toEqual(["bracket", "samsung>", "tv>"]);
  });
});

describe("matching what customers ask for", () => {
  it("finds the item in the owner's words, singular or plural, and other names for it", () => {
    expect(matches("fridge", "LG Fridge 250L")).toBe(true);
    expect(matches("fridges", "LG Fridge 250L")).toBe(true);
    expect(matches("fridge", "Defy refrigerator, double door")).toBe(true);
    expect(matches("refrigerator", "Hisense fridge 300 litres")).toBe(true);
    expect(matches("television", "Samsung 43 inch TV")).toBe(true);
    expect(matches("cellphone", "Tecno Spark 20 smartphone")).toBe(true);
    expect(matches("tyres", "Bridgestone tyre 195/65 R15")).toBe(true);
    expect(matches("washing machine", "LG washing machine 7kg")).toBe(true);
  });

  it("forgives a typo", () => {
    expect(matches("refrigirator", "LG Refrigerator 250L")).toBe(true);
    expect(matches("generater", "Honda generator 2.5kVA")).toBe(true);
  });

  it("reads Shona item words through their English meaning", () => {
    expect(matches("firiji", "Capri fridge 300L")).toBe(true);
  });

  it("puts the brand asked for first, and never passes off another size", () => {
    const asked = "samsung 55 inch tv";
    expect(score(asked, 'Samsung 55" Smart TV')).toBeGreaterThan(score(asked, "Hisense 55 inch TV"));
    expect(matches(asked, "Hisense 55 inch TV")).toBe(true);
    expect(matches(asked, "Samsung 43 inch TV")).toBe(false);
    expect(matches("2 plate stove", "Defy 4 plate stove")).toBe(false);
    // Near enough is the same size.
    expect(matches("fridge 300 litres", "Defy fridge 305L")).toBe(true);
  });

  it("doesn't pass off an accessory for the item, or another item", () => {
    expect(matches("samsung tv", "Samsung TV wall bracket")).toBe(false);
    expect(matches("tv", "TV stand, glass")).toBe(false);
    expect(matches("tv", "Bracket for 55 inch TV")).toBe(false);
    expect(matches("fridge", "Fridge magnet set")).toBe(false);
    expect(matches("samsung tv", "Samsung washing machine 7kg")).toBe(false);
    expect(matches("washing machine", "Singer sewing machine")).toBe(false);
  });

  it("knows a word before the item describes it, and a bundle is still the item", () => {
    expect(matches("fan", "Stand fan 16 inch")).toBe(true);
    expect(matches("eggs", "Tray of 30 eggs")).toBe(true);
    expect(matches("coke", "Case of 24 Coke 330ml")).toBe(true);
    expect(matches("fridge", "Repair of fridges")).toBe(false);
    expect(matches("samsung tv", "Samsung 55 inch TV with free wall bracket")).toBe(true);
    expect(matches("samsung tv", "Samsung 55 inch TV + bracket")).toBe(true);
  });

  it("gives the accessory when that's what was asked for", () => {
    expect(matches("tv stand", "TV stand, glass")).toBe(true);
    expect(matches("tv stand", "Samsung 43 inch TV")).toBe(false);
    expect(matches("phone charger", "Samsung phone charger 25W")).toBe(true);
  });

  it("reads the owner's category, and the description when the name is only a model", () => {
    expect(matches("fridge", "Capri CF300", { category: "Fridges" })).toBe(true);
    expect(matches("fridge", "Capri CF300", { category: "Refrigeration" })).toBe(true);
    expect(matches("fridge", "Capri CF300", { description: "300 litre fridge, silver" })).toBe(true);
    expect(matches("fridge", "Capri CF300")).toBe(false);
    // A freezer that mentions fridges isn't a fridge.
    expect(matches("fridge", "Capri deep freezer", { description: "Colder than any fridge" })).toBe(false);
  });

  it("looks for what was asked, not the place it was asked in", () => {
    const places = app.services.gazetteer;
    expect(wordsToMatch("Fridge in Avondale", "", null, places)).not.toContain("avondale");
    expect(wordsToMatch("Fridge in Avondale", null, "Avondale", places)).toContain("fridge");
    expect(wordsToMatch("fridge in Avondale", "defy fridge", "Avondale", places)).toBe("defy fridge");
  });

  it("asks the database for every way an item is written", () => {
    const q = productQuery("washing machine", app.services.lexicon, 400);
    expect(q.budgetUsd).toBe(400);
    expect(q.tsquery).toContain("(washing:* & machine:*)");
    expect(productQuery("fridge", app.services.lexicon).tsquery).toContain("refrigerator:*");
    // A misspelled brand still reaches the right one.
    expect(productQuery("samsang tv", app.services.lexicon).tsquery).toContain("sams:*");
  });
});

describe("finding products in the database", () => {
  const here = () => app.services.gazetteer.match("Avondale")!;
  const find = async (asked: string, s: Partial<ProductSearch> = {}) =>
    (await searchProducts(app.db, { query: productQuery(asked, app.services.lexicon), lat: here().lat, lng: here().lng, ...s })).map(
      (h) => `${h.name}: ${h.best.name} $${h.best.price}`,
    );

  it("finds only what customers can buy, from live stores near them", async () => {
    const avondale = await idOf("Avondale Electronics (sample)");
    const gulf = await idOf("Gulf Tech Traders (sample)");
    await listed(avondale, { name: "Hisense 43 inch smart TV", price: 289 });
    await listed(gulf, { name: "Hisense 43 inch TV", price: 279, archived: true });
    await listed(gulf, { name: "Hisense 43 inch TV (display model)", price: 250, inStock: false });
    await listed(await idOf("Harare Cement Distributors (sample)"), { name: "Hisense 43 inch TV", price: 200 });
    await listed(await idOf("Brightside Solar Bulawayo (sample)"), { name: "Hisense 43 inch TV", price: 260 });

    // Taken down, out of stock, wholesale only and 400 km away: none of them.
    expect(await find("hisense tv")).toEqual(["Avondale Electronics (sample): Hisense 43 inch smart TV $289"]);
    // A business buying stock sees the wholesaler.
    expect(await find("hisense tv", { trade: "wholesale" })).toEqual(["Harare Cement Distributors (sample): Hisense 43 inch TV $200"]);
    // Where distance doesn't matter, anywhere.
    expect(await find("hisense tv", { maxKm: 1e6 })).toContain("Brightside Solar Bulawayo (sample): Hisense 43 inch TV $260");
    // A paused store's products go with it.
    await app.db.query("UPDATE businesses SET status = 'paused' WHERE id = $1", [avondale]);
    expect(await find("hisense tv")).toEqual([]);
    await app.db.query("UPDATE businesses SET status = 'active' WHERE id = $1", [avondale]);
  });

  it("finds two-word items the database holds as two words", async () => {
    await listed(await idOf("Borrowdale Home Appliances (sample)"), { name: "LG Washing Machine 7kg front loader", price: 460 });
    expect(await find("washing machine")).toEqual(["Borrowdale Home Appliances (sample): LG Washing Machine 7kg front loader $460"]);
    expect(await find("sewing machine")).toEqual([]);
  });

  it("keeps a trade's search to that trade's own listings", async () => {
    await listed(await idOf("Gulf Tech Traders (sample)"), { name: "Tecno Spark 20 phone", price: 150 });
    expect(await find("tecno phone")).toEqual(["Gulf Tech Traders (sample): Tecno Spark 20 phone $150"]);
    // A phone repair request is for repairers' listed jobs, never phones for sale.
    expect(await find("tecno phone", { categorySlug: "electronics_repair" })).toEqual([]);
  });
});

describe("from the dashboard to WhatsApp, live", () => {
  it("answers with a product the moment it's listed, at the price set a moment ago", async () => {
    const shop = await dashboardOf(app, server, "Borrowdale Home Appliances (sample)");
    const c = newCustomer(app);
    await c.agree();
    const fridge = await shop.add({ name: "Defy 300L double door fridge", price: 589, category: "Fridges" });

    await c.say("defy fridge in Borrowdale");
    expect(textOf(c.last())).toMatch(/^I found \*.+\* at one store near Borrowdale, for \*\$589\*\. It's verified by our team ✅\./);
    expect(rowsOf(c.last())[0]).toMatch(/^\$589\.00 · Defy 300L double door fridge · ✅/);
    // WhatsApp shows 24 letters of a row's title: "Borrowdale Home Applian…".
    await c.tap("Borrowdale Home");
    expect(textOf(c.last())).toContain("• Defy 300L double door fridge: *$589.00* (updated today)");

    // The owner drops the price on the dashboard; the customer's next look shows it.
    await shop.change(fridge, { price: 569 });
    await c.tap("Other options");
    expect(textOf(c.last())).toContain("for *$569*");
    await c.tap("Borrowdale Home");
    expect(textOf(c.last())).toContain("• Defy 300L double door fridge: *$569.00*");

    // Sold out: the store stays in their list, without it.
    await shop.stock([fridge], false);
    await c.tap("Other options");
    expect(textOf(c.last())).not.toContain("$569");
    expect(rowsOf(c.last()).join(" ")).not.toContain("Defy 300L");
  });
});

describe("WhatsApp's own product cards", () => {
  let tv: string;
  let photoId: string;

  it("puts products with a photo and a price in our catalog, with pages Meta can read", async () => {
    const shop = await dashboardOf(app, server, "Avondale Electronics (sample)");
    tv = await shop.add({ name: "Hisense 65 inch UHD smart TV", price: 899, category: "TVs", description: "4K, Netflix and YouTube built in" });
    const noPhoto = await shop.add({ name: "Hisense 32 inch TV", price: 199 });
    const noPrice = await shop.add({ name: "Hisense soundbar" });
    photoId = await shop.photo(tv);
    await shop.photo(noPrice);
    await aMinuteLater();

    expect(catalog.items.get(tv)).toEqual({
      retailerId: tv,
      title: "Hisense 65 inch UHD smart TV",
      description: "4K, Netflix and YouTube built in. Sold by Avondale Electronics (sample) in Avondale, verified by our team.",
      availability: "in stock",
      condition: "new",
      price: "899.00 USD",
      link: `${app.config.publicBaseUrl}/p/${tv}`,
      imageLink: `${app.config.publicBaseUrl}/media/products/${photoId}`,
      brand: "Hisense",
    });
    expect(catalog.items.has(noPhoto)).toBe(false);
    expect(catalog.items.has(noPrice)).toBe(false);
  });

  it("keeps the catalog to what can be bought now", async () => {
    const shop = await dashboardOf(app, server, "Avondale Electronics (sample)");
    await shop.change(tv, { price: 849 });
    await aMinuteLater();
    expect(catalog.items.get(tv)?.price).toBe("849.00 USD");

    await shop.stock([tv], false);
    await aMinuteLater();
    expect(catalog.items.has(tv)).toBe(false);
    await shop.change(tv, { inStock: true });
    await aMinuteLater();
    expect(catalog.items.has(tv)).toBe(true);

    // The team pauses the store: everything it lists comes out, and goes back when it's live again.
    const ops = (status: string) => server.inject({ method: "POST", url: `/ops/api/businesses/${shop.id}/status`, payload: { status } });
    expect((await ops("paused")).statusCode).toBe(200);
    await aMinuteLater();
    expect(catalog.items.has(tv)).toBe(false);
    expect((await ops("active")).statusCode).toBe(200);
    await aMinuteLater();
    expect(catalog.items.has(tv)).toBe(true);
  });

  it("sends the cards after the results, and a message about one brings its store", async () => {
    const c = newCustomer(app);
    await c.agree();
    await c.say("hisense 65 inch tv in Avondale");
    const [results, cards] = c.all().slice(-2);
    expect(results!.kind).toBe("list");
    expect(textOf(results!)).toContain("for *$849*");
    if (cards?.kind !== "product_list") throw new Error(`Expected product cards, got ${cards?.kind}`);
    expect(cards.catalogId).toBe("test-catalog");
    expect(cards.sections).toEqual([
      {
        title: "Avondale Electronics (s…",
        products: [{ id: tv, name: "Hisense 65 inch UHD smart TV", price: "$849.00", image: `${app.config.publicBaseUrl}/media/products/${photoId}` }],
      },
    ]);

    // "Ask about this" on a card: WhatsApp sends their message with the product it's about.
    await c.send({ type: "text", text: "Is this available?" }, { referredProduct: { catalogId: "test-catalog", retailerId: tv } });
    expect(textOf(c.last())).toContain("*Avondale Electronics (sample)*");
    expect(textOf(c.last())).toContain("• Hisense 65 inch UHD smart TV: *$849.00*");
    await c.tap("Connect me");
    expect(c.texts().at(-1)).toContain("Avondale Electronics (sample)");

    // A cart from the cards: we don't take orders, the store does.
    await c.send({ type: "order", catalogId: "test-catalog", items: [{ retailerId: tv, quantity: 1 }] });
    const [said, card] = c.texts().slice(-2);
    expect(said).toContain("We don't take orders or payments here");
    expect(card).toContain("*Avondale Electronics (sample)*");

    // The code on a product's page does the same.
    await c.say(`Hi, I'm interested in Hisense 65 inch UHD smart TV (P-${tv.slice(0, 8)})`);
    expect(textOf(c.last())).toContain("*Avondale Electronics (sample)*");
  });

  it("waits for a changed product to reach the catalog before showing its card", async () => {
    const shop = await dashboardOf(app, server, "Avondale Electronics (sample)");
    await shop.change(tv, { price: 829 });
    const c = newCustomer(app);
    await c.agree();
    await c.say("hisense 65 inch tv in Avondale");
    // The reply has the new price at once; the card, which shows Meta's copy, waits for the sync.
    expect(textOf(c.last())).toContain("for *$829*");
    expect(c.all().some((m) => m.kind === "product_list")).toBe(false);
    await aMinuteLater();
    await c.say("hisense 65 inch tv in Avondale");
    const cards = c.last();
    if (cards.kind !== "product_list") throw new Error(`Expected product cards, got ${cards.kind}`);
    expect(cards.sections[0]!.products[0]!.price).toBe("$829.00");
  });

  it("says so when the product they ask about has gone", async () => {
    const shop = await dashboardOf(app, server, "Avondale Electronics (sample)");
    const gone = await shop.add({ name: "Hisense 50 inch TV", price: 399 });
    await shop.photo(gone);
    await aMinuteLater();
    expect(catalog.items.has(gone)).toBe(true);
    await shop.archive([gone]);
    await aMinuteLater();
    expect(catalog.items.has(gone)).toBe(false);

    const c = newCustomer(app);
    await c.agree();
    await c.send({ type: "text", text: "Is this available?" }, { referredProduct: { catalogId: "test-catalog", retailerId: gone } });
    expect(textOf(c.last())).toContain("that product isn't available any more");
  });

  it("marks products again when Meta refuses a batch, so the next sync sends them", async () => {
    const shop = await dashboardOf(app, server, "Borrowdale Home Appliances (sample)");
    const id = await shop.add({ name: "LG 8kg washing machine", price: 520 });
    await shop.photo(id);
    const down: CatalogClient = {
      name: "down",
      catalogId: "test-catalog",
      batch: async () => {
        throw new Error("Meta is down");
      },
      check: async () => ({ done: true, errors: [] }),
    };
    await expect(syncCatalog(app.db, down, { publicBaseUrl: app.config.publicBaseUrl, log: app.services.log })).rejects.toThrow("Meta is down");
    const [row] = await app.db.query<{ catalog_dirty: boolean }>("SELECT catalog_dirty FROM offerings WHERE id = $1", [id]);
    expect(row!.catalog_dirty).toBe(true);
    await aMinuteLater();
    expect(catalog.items.has(id)).toBe(true);
  });

  it("takes an erased business's products out", async () => {
    const shop = await dashboardOf(app, server, "Budiriro Couches (sample)");
    const sofa = await shop.add({ name: "3 seater sofa, grey", price: 350 });
    await shop.photo(sofa);
    await aMinuteLater();
    expect(catalog.items.has(sofa)).toBe(true);
    expect((await server.inject({ method: "POST", url: `/ops/api/businesses/${shop.id}/erase` })).statusCode).toBe(200);
    await aMinuteLater();
    expect(catalog.items.has(sofa)).toBe(false);
  });
});

describe("product pages and photos", () => {
  it("shows a live product's page and photo, says when it's out of stock, and shows nothing once it's taken down", async () => {
    const shop = await dashboardOf(app, server, "Borrowdale Home Appliances (sample)");
    const id = await shop.add({ name: "Capri 200L chest freezer", price: 420 });
    const photoId = await shop.photo(id);

    const page = await server.inject({ url: `/p/${id}` });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("<h1>Capri 200L chest freezer</h1>");
    expect(page.body).toContain("$420.00");
    expect(page.body).toContain(`<meta property="og:image" content="${app.config.publicBaseUrl}/media/products/${photoId}" />`);
    expect(page.body).toContain(`Code P-${id.slice(0, 8)}`);
    expect(page.body).toContain(`https://wa.me/${app.config.whatsapp.number}?text=Hi%2C%20I%27m%20interested%20in%20Capri%20200L%20chest%20freezer%20(P-${id.slice(0, 8)})`);
    const img = await server.inject({ url: `/media/products/${photoId}.jpg` });
    expect(img.statusCode).toBe(200);
    expect(img.headers["content-type"]).toBe("image/jpeg");

    await shop.stock([id], false);
    expect((await server.inject({ url: `/p/${id}` })).body).toContain("Out of stock right now");

    await shop.archive([id]);
    const gone = await server.inject({ url: `/p/${id}` });
    expect(gone.statusCode).toBe(404);
    expect(gone.body).toContain("This product isn't available any more");
    expect((await server.inject({ url: `/media/products/${photoId}` })).statusCode).toBe(404);
  });

  it("never serves other photos", async () => {
    const shop = await dashboardOf(app, server, "Borrowdale Home Appliances (sample)");
    const shopfront = (await shop.call("POST", "/photos", { kind: "shopfront", ...photo() })).json().id as string;
    expect((await server.inject({ url: `/media/products/${shopfront}` })).statusCode).toBe(404);
    expect((await server.inject({ url: "/media/products/not-a-photo" })).statusCode).toBe(404);
    expect((await server.inject({ url: "/p/not-a-product" })).statusCode).toBe(404);
  });
});

describe("the catalog in the admin portal", () => {
  it("reports how it stands, and sends everything again on request", async () => {
    const status = (await server.inject({ url: "/ops/api/catalog" })).json();
    expect(status).toMatchObject({ enabled: true, kind: "simulated", catalogId: "test-catalog", cards: true, alerts: { on: true }, errors: 0 });
    expect(status.live).toBe(catalog.items.size);

    const again = await server.inject({ method: "POST", url: "/ops/api/catalog/sync" });
    expect(again.statusCode).toBe(200);
    expect(again.json().marked).toBeGreaterThan(0);
    expect((await server.inject({ url: "/ops/api/catalog" })).json().waiting).toBeGreaterThan(0);
    await aMinuteLater();
    expect((await server.inject({ url: "/ops/api/catalog" })).json()).toMatchObject({ waiting: 0, live: catalog.items.size });
  });
});

describe("product cards on the wire", () => {
  it("keeps to WhatsApp's limits and builds the Cloud API message", () => {
    const sections = Array.from({ length: 12 }, (_, s) => ({
      title: `Store number ${s} with a very long name`,
      products: Array.from({ length: 4 }, (_, i) => ({ id: `p-${s}-${i}` })),
    }));
    const msg = normalize({ kind: "product_list", catalogId: "cat-1", header: "Photos and prices", body: "What the stores list", sections });
    if (msg.kind !== "product_list") throw new Error("Expected product cards");
    expect(msg.sections.flatMap((s) => s.products)).toHaveLength(30);
    expect(msg.sections.length).toBeLessThanOrEqual(10);
    expect(msg.sections.every((s) => s.title.length <= 24)).toBe(true);

    const payload = toCloudPayload("263771111111", msg) as { type: string; interactive: Record<string, any> };
    expect(payload.type).toBe("interactive");
    expect(payload.interactive.type).toBe("product_list");
    expect(payload.interactive.header).toEqual({ type: "text", text: "Photos and prices" });
    expect(payload.interactive.action.catalog_id).toBe("cat-1");
    expect(payload.interactive.action.sections[0].product_items[0]).toEqual({ product_retailer_id: "p-0-0" });
  });
});
