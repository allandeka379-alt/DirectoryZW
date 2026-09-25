import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contentWords, WordShapeClassifier } from "../src/ai/classifier.js";
import { KeywordInterpreter } from "../src/ai/keyword-interpreter.js";
import { trainClassifier } from "../src/ai/learning.js";
import { analyzeLocally, DEFAULT_LOCAL_SETTINGS, parseUnknownWords } from "../src/ai/local.js";
import { costOf } from "../src/ai/pricing.js";
import { realExamples } from "../src/eval/examples.js";
import { createServer, registerRoutes } from "../src/http/server.js";
import { FakePriceListBatches, FakeVision } from "./fakes.js";
import { testApp, textOf, type TestApp } from "./helpers.js";

const vision = new FakeVision();
const batches = new FakePriceListBatches();
let app: TestApp;
let server: FastifyInstance;
let n = 0;
const newCustomer = () => `26377444${String(++n).padStart(4, "0")}`;

beforeAll(async () => {
  app = await testApp({}, { vision, priceListBatches: batches });
  server = createServer({ logger: false });
  registerRoutes(server, app);
  await server.ready();
});
afterAll(async () => {
  await server.close();
  await app.close();
});

const ops = (method: "GET" | "POST", url: string, payload?: object) =>
  server.inject({ method, url: `/ops/api${url}`, ...(payload ? { payload } : {}) });

function as(customer: string) {
  return {
    say: (text: string) => app.say(text, customer),
    tap: (title: string) => app.tap(title, "customer", customer),
    last: () => app.last("customer", customer),
    consented: async () => {
      await app.say("hi", customer);
      await app.tap("I agree", "customer", customer);
    },
  };
}

function rows(m: ReturnType<TestApp["last"]>): string[] {
  if (m.kind !== "list") throw new Error(`Expected a list, got ${m.kind}: ${textOf(m)}`);
  return m.sections[0]!.rows.map((r) => r.title);
}

describe("the word-shape classifier", () => {
  const classifier = WordShapeClassifier.train([
    { words: ["photographer", "photos"], category: "photography" },
    { words: ["plumber", "plumbing"], category: "plumbing" },
    { words: ["control"], category: "pest_control" },
  ]);

  it("finds the known word a misspelling is most like", () => {
    const [best] = classifier.guess(["fotographer"]);
    expect(best).toMatchObject({ category: "photography", like: "photographer" });
    expect(best!.score).toBeGreaterThan(0.6);
    expect(classifier.guess(["plumbaa"])[0]?.category).toBe("plumbing");
  });

  it("doesn't take a longer or shorter word for one it merely contains", () => {
    expect(classifier.guess(["controller"]).some((g) => g.like === "control")).toBe(false);
    expect(contentWords("I need a PS5 controller please")).toEqual(["ps5", "controller"]);
  });

  it("learns from the phrasebook and the team's labels, not from place names or phrases", async () => {
    const { taxonomy, lexicon, gazetteer } = app.services;
    await app.db.query(
      `INSERT INTO phrasebook (signature, intent, category_slug, query, language, source)
       VALUES ('mabhisikiti', 'search', 'cakes', 'biscuits', 'sn', 'team') ON CONFLICT DO NOTHING`,
    );
    const learnt = await trainClassifier({ taxonomy, lexicon, gazetteer, db: app.db });
    expect(learnt.guess(["mabhisikitii"])[0]).toMatchObject({ category: "cakes", like: "mabhisikiti" });
    expect(learnt.guess(["mabelreign"]).some((g) => g.like === "mabelreign")).toBe(false);
    expect(learnt.guess(["machine"]).some((g) => g.like === "machine")).toBe(false); // only known as "washing machine"
  });
});

describe("the thresholds", () => {
  const keywords = new KeywordInterpreter();

  it("reads LOCAL_UNKNOWN_WORDS", () => {
    expect(parseUnknownWords("en:2,sn:1")).toEqual({ en: 2, sn: 1, nd: 0 });
    expect(() => parseUnknownWords("english:1")).toThrow(/LOCAL_UNKNOWN_WORDS/);
  });

  it("allows as many unknown words as the settings say", async () => {
    const ctx = { taxonomy: app.services.taxonomy, gazetteer: app.services.gazetteer, lexicon: app.services.lexicon };
    const text = "plumber for the geyser thing in Mabelreign asap";
    expect((await analyzeLocally(text, ctx, keywords)).band).toBe("high");
    const strict = { ...DEFAULT_LOCAL_SETTINGS, unknownWords: { en: 0, sn: 0, nd: 0 } };
    expect((await analyzeLocally("plumber for my mamba", ctx, keywords, strict)).band).toBe("medium");
  });

  it("turns a misspelling into a question, and repair + a guessed appliance into appliance repairs", async () => {
    const ctx = { ...app.services, classifier: app.services.classifier };
    expect(await analyzeLocally("i need a fotographer", ctx, keywords)).toMatchObject({ band: "medium", options: ["photography"] });
    expect(await analyzeLocally("fridj repair in Hatfield", ctx, keywords)).toMatchObject({ band: "medium", options: ["appliance_repair"] });
    const off = { ...DEFAULT_LOCAL_SETTINGS, classifierMin: 0 };
    expect((await analyzeLocally("i need a fotographer", ctx, keywords, off)).band).toBe("low");
  });

  it("prices batch calls at half", () => {
    const usage = { input_tokens: 1000, output_tokens: 1000 };
    expect(costOf("claude-sonnet-5", usage, { batch: true })).toBeCloseTo(costOf("claude-sonnet-5", usage) / 2, 10);
  });
});

describe("photos with a clear caption", () => {
  it("are understood from the caption alone, without paying to read the photo", async () => {
    const customer = newCustomer();
    const c = as(customer);
    await c.consented();
    const before = vision.photos.length;
    const mediaId = app.simulatorMedia!.put({ data: Buffer.from("jpeg"), mimeType: "image/jpeg" });
    await app.send("customer", customer, { type: "image", mediaId, caption: "I need a plumber in Mabelreign" });
    expect(vision.photos.length).toBe(before);
    expect(rows(c.last())[0]).toMatch(/^QuickFix/);
    const [row] = await app.db.query<{ raw_text: string; understood_by: string }>(
      "SELECT raw_text, understood_by FROM requests ORDER BY created_at DESC LIMIT 1",
    );
    expect(row).toMatchObject({ raw_text: "📷 I need a plumber in Mabelreign", understood_by: "local" });
  });

  it("still go to Claude when the caption isn't enough", async () => {
    const customer = newCustomer();
    await as(customer).consented();
    vision.photoAnswer = () => null;
    const before = vision.photos.length;
    const mediaId = app.simulatorMedia!.put({ data: Buffer.from("jpeg"), mimeType: "image/jpeg" });
    await app.send("customer", customer, { type: "image", mediaId, caption: "how much for this one?" });
    expect(vision.photos.length).toBe(before + 1);
  });
});

describe("field price lists through the Batch API", () => {
  async function registerWithPriceList(ref: string, name: string, phone: string): Promise<string> {
    const created = await ops("POST", "/agents", { name: `Agent ${ref}` });
    const token = new URL(created.json().setupUrl).hash.replace("#token=", "");
    const avondale = app.services.gazetteer.match("Avondale")!;
    const res = await server.inject({
      method: "POST",
      url: "/field/api/businesses",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        clientRef: ref,
        name,
        phone,
        categories: ["salons"],
        areaId: avondale.id,
        checks: { premisesSeen: true, idChecked: true },
        consent: true,
        photos: [{ kind: "price_list", contentType: "image/jpeg", dataBase64: Buffer.from("price list").toString("base64") }],
      },
    });
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  }

  it("queues them, sends them in a batch, and saves the results when it ends", async () => {
    const before = vision.priceLists.length;
    const businessId = await registerWithPriceList("batch-ref-1", "Rudo's Salon", "0771239881");
    await app.runJobs(); // read_price_list: queued for the next batch
    expect(vision.priceLists.length).toBe(before); // not read interactively
    app.advanceHours(0.5);
    await app.runJobs(); // price_list_batches: sent off
    expect(batches.submitted).toHaveLength(1);
    const [batch] = batches.submitted;
    batches.answer = (photoId) => ({ photoId, list: { is_price_list: true, items: [{ name: "Cornrows", price_usd: 15, price_text: "$15" }] } });
    batches.finish(batch!.batchId);
    app.advanceHours(0.5);
    await app.runJobs(); // collected
    const detail = (await ops("GET", `/businesses/${businessId}`)).json();
    expect(detail.offerings).toMatchObject([{ name: "Cornrows", price_text: "$15" }]);
    const system = (await ops("GET", "/system")).json();
    expect(system.priceLists).toMatchObject({ batch: true, queued: 0, submitted: 0, done_7d: 1 });
  });

  it("retries a photo that failed, and gives up after three tries", async () => {
    await registerWithPriceList("batch-ref-2", "Tafadzwa's Barber", "0771239882");
    batches.answer = (photoId) => ({ photoId, list: null, error: "overloaded" });
    await app.runJobs();
    for (let i = 0; i < 3; i++) {
      app.advanceHours(0.5);
      await app.runJobs(); // sent off
      batches.finish(batches.submitted.at(-1)!.batchId);
      app.advanceHours(0.5);
      await app.runJobs(); // collected: failed
    }
    const [read] = await app.db.query<{ status: string; attempts: number; error: string }>(
      "SELECT status, attempts, error FROM price_list_reads ORDER BY created_at DESC LIMIT 1",
    );
    expect(read).toMatchObject({ status: "failed", attempts: 3, error: "overloaded" });
  });
});

describe("labelling real requests", () => {
  it("lets the team label a sample, learns from corrections, and exports the labels for the eval", async () => {
    const c = as(newCustomer());
    await c.consented();
    await c.say("I need a plumber in Hatfield");
    await c.say("pikipiki repairs in Avondale");
    const next = (await ops("GET", "/labels/next?limit=100")).json() as { target: number; requests: { id: string; raw_text: string }[] };
    expect(next.target).toBe(300);
    const plumber = next.requests.find((r) => r.raw_text === "I need a plumber in Hatfield")!;
    const pikipiki = next.requests.find((r) => r.raw_text === "pikipiki repairs in Avondale")!;
    expect((await ops("POST", `/requests/${plumber.id}/label`, { intent: "search", category: "plumbing" })).json()).toEqual({ ok: true, corrected: false });
    // A motorbike repair: the assistant didn't know; the label teaches the phrasebook.
    expect((await ops("POST", `/requests/${pikipiki.id}/label`, { intent: "search", category: "car_repairs" })).json()).toEqual({ ok: true, corrected: true });
    const summary = (await ops("GET", "/labels/summary")).json();
    expect(summary).toMatchObject({ labelled: 2, right: 1 });

    const d = as(newCustomer());
    await d.consented();
    await d.say("pikipiki repairs in Avondale");
    const [row] = await app.db.query<{ understood_by: string; category_slug: string }>(
      "SELECT understood_by, category_slug FROM requests WHERE raw_text = $1 ORDER BY created_at DESC LIMIT 1",
      ["pikipiki repairs in Avondale"],
    );
    expect(row).toMatchObject({ understood_by: "phrasebook", category_slug: "car_repairs" });

    const exported = await realExamples(app.db, { labelled: true, days: 30, limit: 300 });
    expect(exported).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: "pikipiki repairs in Avondale", expect: { intent: "search", category: "car_repairs" }, reviewed: true }),
      ]),
    );
    expect(exported.every((e) => e.reviewed)).toBe(true);
    const system = (await ops("GET", "/system")).json();
    expect(system.targets).toMatchObject({ labelled: 2, labelled_right: 1 });
    expect(system.targets.requests).toBeGreaterThan(0);
  });
});
