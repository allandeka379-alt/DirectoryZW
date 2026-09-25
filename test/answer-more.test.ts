import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedReferenceData } from "../src/db/seed.js";
import { searchBusinesses } from "../src/directory/search.js";
import { createServer, registerRoutes } from "../src/http/server.js";
import type { InboundContent } from "../src/whatsapp/types.js";
import { FakeVision, interpretation } from "./fakes.js";
import { testApp, textOf, type TestApp } from "./helpers.js";

const vision = new FakeVision();
let app: TestApp;
let server: FastifyInstance;

beforeAll(async () => {
  app = await testApp({}, { vision });
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

const photo = () => app.simulatorMedia!.put({ data: Buffer.from("jpeg bytes"), mimeType: "image/jpeg" });
const voiceNote = (words: string) => app.simulatorMedia!.put({ data: Buffer.from(`ogg ${words}`), mimeType: "audio/ogg" }, words);

function rowsOf(m: ReturnType<TestApp["last"]>, section = 0): string[] {
  if (m.kind !== "list") throw new Error(`Expected a list, got ${m.kind}`);
  return m.sections[section]!.rows.map((r) => r.title);
}

describe("photos", () => {
  it("finds businesses from a photo and its caption", async () => {
    vision.photoAnswer = (caption) =>
      interpretation({ category_slug: "furniture", query: "black leather couch", area: caption?.includes("Glen View") ? "Glen View" : null });
    const c = as(newCustomer());
    await c.consented();
    await c.send({ type: "image", mediaId: photo(), caption: "Something like this in Glen View", mimeType: "image/jpeg" });

    expect(vision.photos.at(-1)!.caption).toBe("Something like this in Glen View");
    expect(textOf(c.last())).toContain("black leather couch");
    expect(rowsOf(c.last()).some((t) => t.startsWith("Glen View"))).toBe(true);

    await c.tap("Glen View");
    await c.tap("Connect me");
    const link = c.last();
    if (link.kind !== "cta_url") throw new Error(`Expected a link, got ${link.kind}`);
    expect(link.body).toContain("send them your photo");
    expect(new URL(link.url).searchParams.get("text")).toContain("Something like this in Glen View (black leather couch)");
  });

  it("keeps a photo sent before consent and reads it once the customer agrees", async () => {
    vision.photoAnswer = () => interpretation({ category_slug: "furniture", query: "wardrobe", area: "Glen View" });
    const c = as(newCustomer());
    const read = vision.photos.length;
    await c.send({ type: "image", mediaId: photo(), mimeType: "image/jpeg" });
    expect(textOf(c.last())).toContain("I agree");
    expect(vision.photos.length).toBe(read); // nothing is sent to Claude before consent

    await c.tap("I agree");
    expect(vision.photos.length).toBe(read + 1);
    expect(c.last().kind).toBe("list");
  });

  it("asks for words when the photo can't be used", async () => {
    vision.photoAnswer = () => null;
    const c = as(newCustomer());
    await c.consented();
    await c.send({ type: "image", mediaId: photo(), mimeType: "image/jpeg" });
    expect(textOf(c.last())).toContain("describe it in words");
  });
});

describe("voice notes", () => {
  it("says back what it heard, then searches", async () => {
    const c = as(newCustomer());
    await c.consented();
    const id = voiceNote("ndoda plumber ku Mabelreign");
    await c.send({ type: "audio", mediaId: id, voice: true, mimeType: "audio/ogg" });

    // What we heard tops the results, rather than costing a message of its own.
    // Replies are in English: the category's name, not the customer's Shona words.
    expect(textOf(c.last())).toMatch(/^🎙️ I heard: “ndoda plumber ku Mabelreign”\n\nWe have (a business|\w+ businesses) near Mabelreign that offers? \*plumbing services\*/);
    expect(rowsOf(c.last())[0]).toMatch(/^QuickFix/);
    const [logged] = await app.db.query<{ transcript: string }>(
      "SELECT notes->>'transcript' AS transcript FROM messages WHERE body->>'mediaId' = $1",
      [id],
    );
    expect(logged?.transcript).toBe("ndoda plumber ku Mabelreign"); // shown to the team in the ops console
  });

  it("asks for text when there's no speech-to-text service", async () => {
    const speech = app.services.speech;
    app.services.speech = undefined;
    try {
      const c = as(newCustomer());
      await c.consented();
      await c.send({ type: "audio", mediaId: voiceNote("plumber"), voice: true });
      expect(textOf(c.last())).toContain("can't listen to voice notes");
    } finally {
      app.services.speech = speech;
    }
  });

  it("lets business owners answer by voice note", async () => {
    const owner = "263779888001";
    await app.send("business", owner, { type: "text", text: "register" });
    await app.send("business", owner, { type: "audio", mediaId: voiceNote("Chipo Tailoring"), voice: true });
    const reply = textOf(app.last("business", owner));
    expect(reply).toContain("I heard: “Chipo Tailoring”");
    expect(reply).toContain("What do you sell or do?");
  });
});

describe("price lists", () => {
  it("reads a price-list photo into the listing once the owner confirms", async () => {
    const phone = await app.phoneOf("Siyaso Hardware (sample)");
    vision.priceListAnswer = {
      is_price_list: true,
      items: [
        { name: "PPC Cement 50kg", price_usd: 11.5, price_text: "$11.50" },
        { name: "IBR roofing sheet 3m", price_usd: 14, price_text: "$14" },
        { name: "Wheelbarrow", price_usd: null, price_text: "ZiG 900" },
      ],
    };
    await app.send("business", phone, { type: "text", text: "menu" });
    await app.tap("Add price list photo", "business", phone);
    expect(textOf(app.last("business", phone))).toContain("Send a photo of your price list");

    await app.send("business", phone, { type: "image", mediaId: photo(), mimeType: "image/jpeg" });
    const read = textOf(app.last("business", phone));
    expect(read).toContain("I read 3 items");
    expect(read).toContain("PPC Cement 50kg: $11.50");
    expect(read).toContain("Wheelbarrow: ZiG 900");
    const count = async () =>
      (await app.db.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM offerings o JOIN businesses b ON b.id = o.business_id WHERE b.phone = $1",
        [phone],
      ))[0]!.n;
    expect(await count()).toBe(0); // nothing changes until the owner says so

    await app.tap("Save prices", "business", phone);
    expect(textOf(app.last("business", phone))).toContain("Saved! 3 items");
    expect(await count()).toBe(3);
  });

  it("finds businesses by their price-list items and shows matching prices", async () => {
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

  it("asks again when the photo isn't a price list", async () => {
    const phone = await app.phoneOf("Southerton Building Supplies (sample)");
    vision.priceListAnswer = { is_price_list: false, items: [] };
    await app.send("business", phone, { type: "image", mediaId: photo(), mimeType: "image/jpeg" });
    expect(textOf(app.last("business", phone))).toContain("couldn't read items and prices");
  });

  it("reads price lists that field agents photograph", async () => {
    vision.priceListAnswer = { is_price_list: true, items: [{ name: "Braids", price_usd: 25, price_text: "$25" }] };
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
    expect(detail.offerings).toMatchObject([{ name: "Braids", price_text: "$25" }]);
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
