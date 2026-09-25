import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, registerRoutes } from "../src/http/server.js";
import type { OutboundMessage } from "../src/whatsapp/outbound.js";
import { FakeClaude, interpretation } from "./fakes.js";
import { testApp, textOf, type TestApp } from "./helpers.js";

const claude = new FakeClaude();
let app: TestApp;
let server: FastifyInstance;
let n = 0;
const newCustomer = () => `26377555${String(++n).padStart(4, "0")}`;

beforeAll(async () => {
  app = await testApp({}, { claude });
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

/** Button titles, or list row titles. */
function choices(m: OutboundMessage): string[] {
  if (m.kind === "buttons") return m.buttons.map((b) => b.title);
  if (m.kind === "list") return m.sections.flatMap((s) => s.rows.map((r) => r.title));
  return [];
}

function rows(m: OutboundMessage): string[] {
  if (m.kind !== "list") throw new Error(`Expected a list, got ${m.kind}: ${textOf(m)}`);
  return m.sections[0]!.rows.map((r) => r.title);
}

const requestFor = async (text: string) =>
  (await app.db.query<{ id: string; understood_by: string; category_slug: string | null; reading: { band: string } | null }>(
    "SELECT id, understood_by, category_slug, reading FROM requests WHERE raw_text = $1 ORDER BY created_at DESC LIMIT 1",
    [text],
  ))[0];

describe("Did you mean…?", () => {
  it("checks a request that rests on draft Shona words, and learns the answer", async () => {
    const c = as(newCustomer());
    await c.consented();
    await c.say("ndoda keke remuchato ku Avondale");
    expect(textOf(c.last())).toContain("do you mean *Cakes and baking*?");
    expect(choices(c.last())).toEqual(["Yes", "No, something else"]);
    expect(claude.calls).toHaveLength(0);
    await c.tap("Yes");
    expect(rows(c.last())[0]).toMatch(/^Sweet Layers/);
    expect(await requestFor("ndoda keke remuchato ku Avondale")).toMatchObject({ understood_by: "customer", category_slug: "cakes" });
    const [question] = await app.db.query("SELECT options, chosen FROM clarifications ORDER BY created_at DESC LIMIT 1");
    expect(question).toMatchObject({ options: ["cakes"], chosen: "cakes" });

    // The next customer who writes it isn't asked.
    const d = as(newCustomer());
    await d.consented();
    await d.say("Ndoda keke remuchato ku Avondale");
    expect(rows(d.last())[0]).toMatch(/^Sweet Layers/);
    expect(await requestFor("Ndoda keke remuchato ku Avondale")).toMatchObject({ understood_by: "phrasebook" });
  });

  it("offers what a word could mean, and takes an answer typed in words", async () => {
    const c = as(newCustomer());
    await c.consented();
    await c.say("Ndoda macheya ku Chitungwiza");
    expect(choices(c.last())).toEqual(["Event hire", "Furniture", "Something else"]);
    await c.say("to hire");
    expect(rows(c.last())).toEqual(expect.arrayContaining([expect.stringMatching(/^Chitungwiza Tents/)]));
    expect(await requestFor("Ndoda macheya ku Chitungwiza")).toMatchObject({ understood_by: "customer", category_slug: "event_hire" });
  });

  it("reads \"Something else\" with Claude, telling it what's ruled out", async () => {
    const c = as(newCustomer());
    await c.consented();
    await c.say("paint in Avondale");
    expect(choices(c.last())).toEqual(["Hardware stores", "Painters", "Something else"]);
    claude.answer = () => interpretation({ category_slug: "car_repairs", query: "car spray painting", area: "Avondale" });
    await c.tap("Something else");
    expect(claude.calls.at(-1)?.notes).toContain("The customer said they don't mean: hardware, painting");
    expect(rows(c.last())[0]).toMatch(/^Arcadia Auto/);
  });

  it("asks them to say it differently when nobody can tell, then a person takes over", async () => {
    claude.answer = () => null;
    const c = as(newCustomer());
    await c.consented();
    await c.say("fix my shoes in Avondale");
    expect(choices(c.last())).toEqual(["Yes", "No, something else"]);
    await c.tap("No, something else");
    expect(textOf(c.last())).toContain("Please tell me in other words");
    await c.say("the heel came off");
    expect(textOf(c.last())).toContain("passed your message to our team");
  });

  it("counts questions and answers on the System screen", async () => {
    const system = (await ops("GET", "/system")).json();
    expect(system.questions7d).toMatchObject({ asked: 4, picked: 2, something_else: 2 });
    expect(system.lexicon.words).toEqual(expect.arrayContaining([expect.objectContaining({ language: "sn", status: "draft" })]));
  });
});

describe("the word list", () => {
  it("lists draft Shona words for a native speaker to review", async () => {
    const words = (await ops("GET", "/lexicon?language=sn&status=draft")).json() as Record<string, unknown>[];
    const keke = words.find((w) => w.term === "keke");
    expect(keke).toMatchObject({ role: "product", categories: ["cakes"], category_names: ["Cakes and baking"], status: "draft" });
    expect(keke?.confirmed).toBe(1); // the customer who tapped "Yes" to Cakes and baking
    expect(words.find((w) => w.term === "gadzir")?.forms).toContain("anogadzira");
    const csv = await ops("GET", "/lexicon/export.csv?language=sn");
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.body).toContain('"keke","product","cake"');
  });

  it("answers straight away once a native speaker approves the words", async () => {
    const drafts = (await ops("GET", "/lexicon?language=sn&status=draft")).json() as { id: number; term: string }[];
    const ids = drafts.filter((w) => ["matende", "macheya", "roj"].includes(w.term)).map((w) => w.id);
    expect(ids).toHaveLength(3);
    expect((await ops("POST", "/lexicon/review", { ids, status: "approved" })).json()).toEqual({ updated: 3 });

    const c = as(newCustomer());
    await c.consented();
    await c.say("Tinoda matende nemacheya ekuroja ku Chitungwiza");
    expect(rows(c.last())).toEqual(expect.arrayContaining([expect.stringMatching(/^Chitungwiza Tents/)]));
    expect(await requestFor("Tinoda matende nemacheya ekuroja ku Chitungwiza")).toMatchObject({ understood_by: "local" });
    const approved = (await ops("GET", "/lexicon?language=sn&status=approved")).json() as { term: string; reviewed_by: string }[];
    expect(approved.find((w) => w.term === "matende")?.reviewed_by).toBeTruthy();
  });

  it("takes new words from the team, approved straight away", async () => {
    const bad = await ops("POST", "/lexicon", { term: "zvinotapira", language: "sn", role: "product" });
    expect(bad.statusCode).toBe(400);
    const saved = await ops("POST", "/lexicon", { term: "zvinotapira", language: "sn", role: "product", categories: ["cakes"], gloss: "sweet things" });
    expect(saved.json()).toMatchObject({ term: "zvinotapira", status: "approved", source: "team" });
    const c = as(newCustomer());
    await c.consented();
    await c.say("ndoda zvinotapira ku Avondale");
    expect(rows(c.last())[0]).toMatch(/^Sweet Layers/);
    expect(await requestFor("ndoda zvinotapira ku Avondale")).toMatchObject({ understood_by: "local" });
  });

  it("suggests words customers used, with what they turned out to mean", async () => {
    claude.answer = (text) => (text.includes("mabhisikiti") ? interpretation({ category_slug: "cakes", query: "biscuits" }) : null);
    for (const text of ["ndoda mabhisikiti ku Avondale", "Ndoda mabhisikiti ku Avondale"]) {
      const c = as(newCustomer());
      await c.consented();
      await c.say(text);
    }
    const suggestions = (await ops("GET", "/vocabulary/suggestions")).json() as { word: string; category: string; uses: number; agreement: number }[];
    expect(suggestions.find((s) => s.word === "mabhisikiti")).toMatchObject({ category: "cakes", uses: 2, agreement: 100 });
  });
});

describe("teaching and checking the engine", () => {
  it("learns from the team's answer in a handoff", async () => {
    claude.answer = () => null;
    const c = as(newCustomer());
    await c.consented();
    await c.say("zvipuka zviri kundiruma ku Chisipite");
    await c.say("zvipuka zviri kundiruma ku Chisipite");
    expect(textOf(c.last())).toContain("passed your message to our team");
    const handoffs = (await ops("GET", "/handoffs")).json() as { request: { id: string; raw_text: string; reading: { unknown: string[] } } }[];
    const waiting = handoffs.find((h) => h.request?.raw_text === "zvipuka zviri kundiruma ku Chisipite");
    expect(waiting?.request.reading.unknown).toContain("zvipuka");
    const taught = await ops("POST", `/requests/${waiting!.request.id}/teach`, { category: "pest_control" });
    expect(taught.json()).toMatchObject({ ok: true });

    const d = as(newCustomer());
    await d.consented();
    await d.say("Zvipuka zviri kundiruma ku Chisipite");
    expect(rows(d.last())[0]).toMatch(/^Chisipite Pest Control/);
    expect(await requestFor("Zvipuka zviri kundiruma ku Chisipite")).toMatchObject({ understood_by: "phrasebook" });
  });

  it("checks a sample of the engine's own answers, and a person's correction wins", async () => {
    const c = as(newCustomer());
    await c.consented();
    await c.say("I need a plumber in Mabelreign");
    await c.say("geyser in Hatfield");
    const sample = (await ops("GET", "/review/sample")).json() as { id: string; raw_text: string; category_slug: string }[];
    const plumber = sample.find((r) => r.raw_text === "I need a plumber in Mabelreign");
    const geyser = sample.find((r) => r.raw_text === "geyser in Hatfield");
    expect(plumber?.category_slug).toBe("plumbing");
    expect(geyser?.category_slug).toBe("plumbing");
    await ops("POST", `/requests/${plumber!.id}/review`, { verdict: "right" });
    // Say the team decides "geyser" alone usually means solar geysers here.
    await ops("POST", `/requests/${geyser!.id}/review`, { verdict: "wrong", category: "solar" });
    const again = (await ops("GET", "/review/sample")).json() as { id: string }[];
    expect(again.some((r) => r.id === plumber!.id)).toBe(false);

    await c.say("geyser in Hatfield");
    expect(await requestFor("geyser in Hatfield")).toMatchObject({ understood_by: "phrasebook", category_slug: "solar" });
    const system = (await ops("GET", "/system")).json();
    expect(system.precision28d).toMatchObject({ reviewed: 2, right: 1, wrong: 1 });
  });
});
