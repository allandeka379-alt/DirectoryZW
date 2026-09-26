import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedReferenceData } from "../src/db/seed.js";
import { searchBusinesses } from "../src/directory/search.js";
import { createServer, registerRoutes } from "../src/http/server.js";
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

let n = 0;
const newCustomer = () => `26377222${String(++n).padStart(4, "0")}`;

function as(customer: string) {
  return {
    say: (text: string) => app.say(text, customer),
    tap: (title: string) => app.tap(title, "customer", customer),
    send: (content: InboundContent) => app.send("customer", customer, content, "Chipo"),
    last: () => app.last("customer", customer),
    texts: () => app.outbox("customer", customer).map((m) => textOf(m.message)),
    consented: async () => {
      await app.say("hi", customer);
      await app.tap("I agree", "customer", customer);
    },
  };
}

const ops = (method: "GET" | "POST", url: string, payload?: object) =>
  server.inject({ method, url: `/ops/api${url}`, ...(payload ? { payload } : {}) });

function rowsOf(m: ReturnType<TestApp["last"]>, section = 0): string[] {
  if (m.kind !== "list") throw new Error(`Expected a list, got ${m.kind}`);
  return m.sections[section]!.rows.map((r) => r.title);
}

describe("typed messages only", () => {
  it("asks customers to type instead of sending a photo or a voice note", async () => {
    const c = as(newCustomer());
    await c.consented();
    await c.send({ type: "image", mediaId: "photo-1", caption: "one like this", mimeType: "image/jpeg" });
    expect(textOf(c.last())).toContain("I can only read typed messages for now");
    await c.send({ type: "audio", mediaId: "voice-1", voice: true, mimeType: "audio/ogg" });
    expect(textOf(c.last())).toContain("Please type what you need");
  });

  it("asks for consent, then what they need, when the first message is a voice note", async () => {
    const c = as(newCustomer());
    await c.send({ type: "audio", mediaId: "voice-2", voice: true, mimeType: "audio/ogg" });
    expect(textOf(c.last())).toContain("I agree");
    await c.tap("I agree");
    expect(textOf(c.last())).toContain("What are you looking for");
  });

  it("asks business owners to type too", async () => {
    const owner = "263779888001";
    await app.send("business", owner, { type: "text", text: "register" });
    await app.send("business", owner, { type: "image", mediaId: "photo-2", mimeType: "image/jpeg" });
    expect(textOf(app.last("business", owner))).toContain("I can only read typed messages for now");
  });
});

describe("price lists", () => {
  it("finds businesses by their price-list items and shows matching prices", async () => {
    // Items read from price-list photos (before photos were switched off) stay searchable.
    const [siyaso] = await app.db.query<{ id: string }>("SELECT id FROM businesses WHERE name = 'Siyaso Hardware (sample)'");
    const items: [string, number | null, string][] = [
      ["PPC Cement 50kg", 11.5, "$11.50"],
      ["IBR roofing sheet 3m", 14, "$14"],
      ["Wheelbarrow", null, "ZiG 900"],
    ];
    for (const [name, usd, text] of items) {
      await app.db.query("INSERT INTO offerings (business_id, name, price_usd, price_text) VALUES ($1, $2, $3, $4)", [siyaso!.id, name, usd, text]);
    }
    await app.db.query("UPDATE businesses SET offerings_text = $2 WHERE id = $1", [siyaso!.id, items.map(([name]) => name).join(" ")]);

    // "wheelbarrow" is only on Siyaso's price list, not in its description or keywords.
    const hits = await searchBusinesses(app.db, app.services.taxonomy, { categorySlug: null, text: "wheelbarrow", limit: 8, minVerified: 3 });
    expect(hits.map((h) => h.name)).toContain("Siyaso Hardware (sample)");

    const c = as(newCustomer());
    await c.consented();
    await c.say("I need cement in Mbare");
    await c.tap("Siyaso");
    const card = textOf(c.last());
    expect(card).toContain("From their price list");
    expect(card).toContain("PPC Cement 50kg: $11.50");
    expect(card).not.toContain("Wheelbarrow");
    expect(card).toContain("confirm with them");
  });

  it("keeps field agents' price-list photos for the team, without reading them", async () => {
    const created = await ops("POST", "/agents", { name: "Tino Field" });
    const token = new URL(created.json().setupUrl).hash.replace("#token=", "");
    const avondale = app.services.gazetteer.match("Avondale")!;
    const res = await server.inject({
      method: "POST",
      url: "/field/api/businesses",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        clientRef: "ref-pricelist-1",
        name: "Tino's Salon",
        phone: "0771239991",
        categories: ["salons"],
        areaId: avondale.id,
        checks: { premisesSeen: true, idChecked: true },
        consent: true,
        photos: [{ kind: "price_list", contentType: "image/jpeg", dataBase64: Buffer.from("price list").toString("base64") }],
      },
    });
    expect(res.statusCode).toBe(201);
    await app.runJobs();
    const detail = (await ops("GET", `/businesses/${res.json().id}`)).json();
    expect(detail.photos.map((p: { kind: string }) => p.kind)).toEqual(["price_list"]);
    expect(detail.offerings).toEqual([]);
  });
});

describe("recommendations", () => {
  it("takes a customer's tip for the field team", async () => {
    const c = as(newCustomer());
    await c.consented();
    await c.say("recommend");
    expect(textOf(c.last())).toContain("What's the business called?");
    await c.say("Mai Chipo Tailoring");
    await c.say("Wedding dresses and alterations");
    expect(c.last().kind).toBe("location_request");
    await c.say("Glen View");
    await c.say("0772 555 666");
    expect(textOf(c.last())).toContain("Our team will contact *Mai Chipo Tailoring*");

    const tips = (await ops("GET", "/recommendations?status=new")).json();
    expect(tips[0]).toMatchObject({
      name: "Mai Chipo Tailoring",
      category_slug: "tailoring",
      area: "Glen View",
      phone: "263772555666",
      already_listed: false,
    });
    expect(tips[0]).not.toHaveProperty("contact_id"); // who recommended them stays private
    expect((await ops("POST", `/recommendations/${tips[0].id}/status`, { status: "contacted" })).statusCode).toBe(200);
    expect((await ops("GET", "/recommendations?status=new")).json()).toHaveLength(0);
  });

  it("recognises a business that is already listed", async () => {
    const phone = await app.phoneOf("QuickFix Plumbing (sample)");
    const c = as(newCustomer());
    await c.consented();
    await c.say("recommend");
    await c.say("QuickFix");
    await c.say("Plumbing");
    await c.say("Mabelreign");
    await c.say(`0${phone.slice(3)}`);
    expect(textOf(c.last())).toContain("already listed");
  });
});

describe("vocabulary", () => {
  it("grows the categories from searches that matched none", async () => {
    const c = as(newCustomer());
    await c.consented();
    // Not understood twice: a person takes over.
    await c.say("I need a lowbed in Workington");
    await c.say("A lowbed in Workington please");
    expect(textOf(c.last())).toContain("passed your message to our team");
    const unmatched = (await ops("GET", "/unmatched")).json();
    expect(unmatched.find((u: { query: string }) => u.query === "lowbed")).toMatchObject({ requests: 2 });

    const res = await ops("POST", "/categories/transport_moving/synonyms", { add: ["Lowbed", "lowbed hire", "truck"] });
    expect(res.json().extra_synonyms).toEqual(["lowbed", "lowbed hire"]); // "truck" is already a seeded synonym

    await c.say("menu"); // back from the person to the assistant
    await c.say("I need a lowbed in Workington");
    expect(rowsOf(c.last()).some((t) => t.startsWith("Workington"))).toBe(true);
    const after = (await ops("GET", "/unmatched")).json();
    expect(after.find((u: { query: string }) => u.query === "lowbed")).toBeUndefined();

    // Reseeding (every start-up) keeps words added from the console.
    await seedReferenceData(app.db);
    await app.reloadTaxonomy();
    expect(app.services.taxonomy.match("lowbed")[0]?.category.slug).toBe("transport_moving");
  });
});
