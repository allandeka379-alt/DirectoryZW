import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedReferenceData } from "../src/db/seed.js";
import { searchBusinesses } from "../src/directory/search.js";
import { createServer, registerRoutes } from "../src/http/server.js";
import type { InboundContent } from "../src/whatsapp/types.js";
import { FakeFinder, FakeVision, found, interpretation } from "./fakes.js";
import { testApp, textOf, type TestApp } from "./helpers.js";

const vision = new FakeVision();
const finder = new FakeFinder();
let app: TestApp;
let server: FastifyInstance;

beforeAll(async () => {
  app = await testApp({ ONLINE_SEARCHES_PER_DAY: "2" }, { vision, finder });
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
    expect(textOf(c.last())).toMatch(/^🎙️ I heard: “ndoda plumber ku Mabelreign”\n\nI found \d places for \*plumber\* near Mabelreign/);
    expect(rowsOf(c.last())[0]).toMatch(/^QuickFix/);
    const [logged] = await app.db.query<{ transcript: string }>(
      "SELECT body->>'transcript' AS transcript FROM messages WHERE body->>'mediaId' = $1",
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
    await c.say("I need a kombi in Workington");
    const unmatched = (await ops("GET", "/unmatched")).json();
    expect(unmatched.find((u: { query: string }) => u.query === "kombi")).toMatchObject({ requests: 1 });

    const res = await ops("POST", "/categories/transport_moving/synonyms", { add: ["Kombi", "kombi hire", "truck"] });
    expect(res.json().extra_synonyms).toEqual(["kombi", "kombi hire"]); // "truck" is already a seeded synonym

    await c.say("I need a kombi in Workington");
    expect(rowsOf(c.last()).some((t) => t.startsWith("Workington"))).toBe(true);
    const after = (await ops("GET", "/unmatched")).json();
    expect(after.find((u: { query: string }) => u.query === "kombi")).toBeUndefined();

    // Reseeding (every start-up) keeps words added from the console.
    await seedReferenceData(app.db);
    await app.reloadTaxonomy();
    expect(app.services.taxonomy.match("kombi")[0]?.category.slug).toBe("transport_moving");
  });
});

// Last: these tests move the clock forward.
describe("found online", () => {
  const venues = () => [
    found("Avondale Gardens Venue", "263772100001", { area: "Avondale" }),
    found("Rose Hall", "263772100002"),
  ];

  it("shows unchecked businesses from the web when nothing is listed", async () => {
    finder.answer = (q) => (q.query.includes("venue") ? venues() : []);
    const c = as(newCustomer());
    await c.say("I need a wedding venue in Avondale");
    await c.tap("I agree");

    expect(c.texts().at(-2)).toContain("checking online");
    expect(finder.calls.at(-1)).toMatchObject({ categoryName: "Venues", place: "Avondale, Harare", city: "Harare" });
    const list = c.last();
    expect(textOf(list)).toContain("Our team hasn't checked this business");
    expect(rowsOf(list)).toEqual(["Avondale Gardens Venue", "Rose Hall"]);
    expect(rowsOf(list, 1)).toEqual(["Ask around", "Talk to a person"]);

    await c.tap("Avondale Gardens");
    const card = textOf(c.last());
    expect(card).toContain("🌐 Found online");
    expect(card).toContain("facebook.com");

    await c.tap("Connect me");
    const link = c.last();
    if (link.kind !== "cta_url") throw new Error(`Expected a link, got ${link.kind}`);
    const url = new URL(link.url);
    expect(url.pathname).toBe("/263772100001");
    expect(url.searchParams.get("text")).toContain("I found your business online through TestDir");
    expect(app.outbox("business", "263772100001")).toHaveLength(0); // they never signed up, so we don't message them

    // Still a gap for the field team.
    const gaps = (await ops("GET", "/supply-gaps")).json();
    expect(gaps.some((g: { category: string; area: string }) => g.category === "venues" && g.area === "Avondale")).toBe(true);
  });

  it("reuses recent finds instead of searching again", async () => {
    const searches = finder.calls.length;
    const c = as(newCustomer());
    await c.consented();
    await c.say("I need a wedding venue in Avondale");
    expect(finder.calls.length).toBe(searches);
    expect(rowsOf(c.last())).toEqual(["Avondale Gardens Venue", "Rose Hall"]);
  });

  it("never searches the web for high-scam categories", async () => {
    const searches = finder.calls.length;
    const c = as(newCustomer());
    await c.consented();
    await c.say("I want to buy a used car in Avondale");
    expect(finder.calls.length).toBe(searches);
    expect(textOf(c.last())).toContain("couldn't find a listed business");
  });

  it("limits how many web searches one customer can trigger in a day", async () => {
    const searches = finder.calls.length;
    const c = as(newCustomer());
    await c.consented();
    await c.say("I need a tailor in Avondale");
    await c.say("I need a welder in Avondale");
    await c.say("I need car hire in Avondale");
    expect(finder.calls.length).toBe(searches + 2);
    expect(c.texts().filter((t) => t.includes("checking online"))).toHaveLength(2);
    expect(textOf(c.last())).toContain("couldn't find a listed business");
  });

  it("lets the field team work through the list; declined businesses never come back", async () => {
    const leads = (await ops("GET", "/online-leads")).json();
    const gardens = leads.find((l: { name: string }) => l.name === "Avondale Gardens Venue");
    const rose = leads.find((l: { name: string }) => l.name === "Rose Hall");
    expect(gardens).toMatchObject({ times_connected: 1, category: "Venues", area: "Avondale", phone: "263772100001" });
    expect((await ops("POST", `/online-leads/${gardens.id}/status`, { status: "invited" })).statusCode).toBe(200);
    expect((await ops("POST", `/online-leads/${gardens.id}/close`, { reason: "declined" })).statusCode).toBe(200);
    expect((await ops("POST", `/online-leads/${rose.id}/close`, { reason: "wrong" })).statusCode).toBe(200);

    // The web still lists both, but only Rose Hall may be shown again.
    const searches = finder.calls.length;
    const c = as(newCustomer());
    await c.consented();
    await c.say("I need a wedding venue in Avondale");
    expect(finder.calls.length).toBe(searches + 1);
    expect(rowsOf(c.last())).toEqual(["Rose Hall"]);
    const [optOuts] = await app.db.query<{ n: number }>("SELECT count(*)::int AS n FROM online_optouts");
    expect(optOuts!.n).toBe(1); // only a hash of the number is kept
  });

  it("deletes web finds when they expire", async () => {
    const count = async () => (await app.db.query<{ n: number }>("SELECT count(*)::int AS n FROM online_leads"))[0]!.n;
    expect(await count()).toBeGreaterThan(0);
    app.advanceHours(31 * 24);
    await app.runJobs();
    expect(await count()).toBe(0);
  });
});
