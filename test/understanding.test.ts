import type Anthropic from "@anthropic-ai/sdk";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebhookAlerts } from "../src/alerts.js";
import { ClaudeInterpreter } from "../src/ai/claude-interpreter.js";
import { costOf } from "../src/ai/pricing.js";
import { categories, relatedCategories } from "../src/db/seed-data/categories.js";
import { createServer, registerRoutes } from "../src/http/server.js";
import { silentLogger } from "../src/logger.js";
import { FakeClaude, interpretation } from "./fakes.js";
import { testApp, textOf, type TestApp } from "./helpers.js";

const claude = new FakeClaude();
const alerts = new WebhookAlerts({ brand: "TestDir", log: silentLogger });
let app: TestApp;
let server: FastifyInstance;
let n = 0;
const newCustomer = () => `26377666${String(++n).padStart(4, "0")}`;

beforeAll(async () => {
  app = await testApp({ CLAUDE_CALLS_PER_NUMBER_PER_DAY: "2", CLAUDE_DAILY_BUDGET_USD: "1" }, { claude, alerts });
  server = createServer({ logger: false });
  registerRoutes(server, app);
  await server.ready();
});
afterAll(async () => {
  await server.close();
  await app.close();
});

function as(customer: string) {
  return {
    say: (text: string) => app.say(text, customer),
    tap: (title: string) => app.tap(title, "customer", customer),
    last: () => app.last("customer", customer),
    texts: () => app.outbox("customer", customer).map((m) => textOf(m.message)),
    consented: async () => {
      await app.say("hi", customer);
      await app.tap("I agree", "customer", customer);
    },
  };
}

function rows(m: ReturnType<TestApp["last"]>, section = 0): string[] {
  if (m.kind !== "list") throw new Error(`Expected a list, got ${m.kind}`);
  return m.sections[section]!.rows.map((r) => r.title);
}

const requestFor = async (text: string) =>
  (await app.db.query<{ understood_by: string; match: string; status: string }>(
    "SELECT understood_by, match, status FROM requests WHERE raw_text = $1 ORDER BY created_at DESC LIMIT 1",
    [text],
  ))[0];

describe("understanding: local first, Claude when stuck", () => {
  it("answers greetings and clear requests without Claude", async () => {
    const c = as(newCustomer());
    await c.consented();
    await c.say("thanks");
    await c.say("I need a plumber in Mabelreign");
    expect(claude.calls).toHaveLength(0);
    expect(rows(c.last())[0]).toMatch(/^QuickFix/);
    expect(await requestFor("I need a plumber in Mabelreign")).toMatchObject({ understood_by: "local", match: "exact" });
  });

  it("asks Claude only about wording it can't read, with its notes, and remembers the answer", async () => {
    claude.answer = (text) =>
      text.includes("zvinotapira") ? interpretation({ category_slug: "cakes", query: "wedding sweets", area: "Avondale", language: "sn" }) : null;
    const c = as(newCustomer());
    await c.consented();
    // "Sweet things for a wedding": the engine knows "muchato" (a wedding), which says nothing about what's wanted.
    await c.say("ndoda zvinotapira zvemuchato ku Avondale");
    expect(claude.calls).toHaveLength(1);
    expect(claude.calls[0]!.notes).toEqual(["Possible categories: none", "Words not recognised: zvinotapira", "Place mentioned: Avondale"]);
    expect(rows(c.last())[0]).toMatch(/^Sweet Layers/);
    expect(await requestFor("ndoda zvinotapira zvemuchato ku Avondale")).toMatchObject({ understood_by: "claude" });

    // Someone else, same words, different place: no second Claude call.
    const d = as(newCustomer());
    await d.consented();
    await d.say("Ndoda zvinotapira zvemuchato ku Mount Pleasant");
    expect(claude.calls).toHaveLength(1);
    expect(rows(d.last())[0]).toMatch(/^Sweet Layers/);
    expect(await requestFor("Ndoda zvinotapira zvemuchato ku Mount Pleasant")).toMatchObject({ understood_by: "phrasebook" });
  });

  it("asks twice at most, then hands to a person, when nobody understands", async () => {
    claude.answer = () => null;
    const c = as(newCustomer());
    await c.consented();
    await c.say("I need a flux capacitor in Belvedere");
    expect(textOf(c.last())).toContain("What are you looking for?");
    await c.say("flux capacitor for my time machine");
    expect(textOf(c.last())).toContain("passed your message to our team");
    const handoffs = (await server.inject({ url: "/ops/api/handoffs" })).json() as { wa_id: string }[];
    expect(handoffs.some((h) => h.wa_id === `26377666${String(n).padStart(4, "0")}`)).toBe(true);
  });

  it("stops asking Claude for a number that reached its daily limit", async () => {
    const customer = newCustomer();
    const c = as(customer);
    await c.consented();
    const [contact] = await app.db.query<{ id: string }>("SELECT id FROM contacts WHERE wa_id = $1", [customer]);
    for (let i = 0; i < 2; i++) {
      await app.services.budget.record("request", "claude-sonnet-5", { input_tokens: 10, output_tokens: 10 }, contact!.id);
    }
    const before = claude.calls.length;
    await c.say("ndoda keke yebirthday ku Avondale");
    expect(claude.calls.length).toBe(before); // understood locally or not at all, but no Claude call
  });
});

describe("when nothing matches", () => {
  it("refers the customer to our electronics shops for a gadget nobody lists", async () => {
    claude.answer = (text) => (text.includes("PS5") ? interpretation({ category_slug: "tv_audio", query: "ps5 controller", area: "Avondale" }) : null);
    const c = as(newCustomer());
    await c.consented();
    await c.say("I need a PS5 controller in Avondale");
    expect(textOf(c.last())).toContain("for *ps5 controller*");
    expect(rows(c.last())).toEqual(expect.arrayContaining([expect.stringMatching(/^Avondale Electronics/)]));
  });

  it("offers related suppliers when none in the category are nearby", async () => {
    claude.answer = (text) => (text.includes("Fridge") ? interpretation({ category_slug: "appliance_repair", query: "fridge repair", area: "Avondale" }) : null);
    const c = as(newCustomer());
    await c.consented();
    await c.say("Fridge repair in Avondale");
    const list = c.last();
    expect(textOf(list)).toContain("couldn't find a business listing *fridge repair* near Avondale yet, but these electronics and appliances businesses may have it");
    expect(rows(list)).toEqual(expect.arrayContaining([expect.stringMatching(/^Borrowdale Home/)]));
    expect(rows(list, 1)).toEqual(["Talk to a person"]);
    expect(await requestFor("Fridge repair in Avondale")).toMatchObject({ match: "related", status: "answered" });

    await c.tap("Borrowdale Home");
    await c.tap("Connect me");
    expect(c.last().kind).toBe("cta_url");
    // Still a gap for the field team: nobody in the category itself.
    const gaps = (await server.inject({ url: "/ops/api/supply-gaps" })).json() as { category: string }[];
    expect(gaps.some((g) => g.category === "appliance_repair")).toBe(true);
  });

  it("uses related categories that make sense: events businesses for a venue", async () => {
    const c = as(newCustomer());
    await c.consented();
    await c.say("I need a wedding venue in Avondale");
    expect(textOf(c.last())).toContain("these events businesses may have it");
    expect(rows(c.last())).toEqual(expect.arrayContaining([expect.stringMatching(/^Msasa Event Hire/)]));
  });

  it("hands over to a person straight away when nobody on our list fits", async () => {
    const c = as(newCustomer());
    await c.consented();
    await c.say("I need a lawyer in Avondale");
    expect(textOf(c.last())).toContain("couldn't find a business for *lawyer* near Avondale on our list yet, so I've passed your request to our team");
    expect(await requestFor("I need a lawyer in Avondale")).toMatchObject({ match: "none", status: "handoff" });
    const before = c.texts().length;
    await c.say("hello?");
    expect(c.texts()).toHaveLength(before); // a person has it now
  });

  it("only refers between categories we chose, all of which exist", () => {
    const slugs = new Set(categories.map((c) => c.slug));
    for (const [slug, related] of Object.entries(relatedCategories)) {
      expect(slugs.has(slug), slug).toBe(true);
      for (const r of related) expect(slugs.has(r), `${slug} -> ${r}`).toBe(true);
    }
    expect(relatedCategories.plumbing).toBeUndefined(); // trades don't refer to other trades
  });
});

describe("business sign-up without Claude", () => {
  it("lets an owner pick a category when their description doesn't match one", async () => {
    const owner = "263779666001";
    const b = (text: string) => app.send("business", owner, { type: "text", text });
    await b("register");
    await b("Chipo's Clock Repairs");
    await b("We restore antique clocks");
    const picker = app.last("business", owner);
    expect(textOf(picker)).toContain("Which of these best describes your business?");
    expect(rows(picker)).toContain("Home and furniture");
    await app.tap("Home and furniture", "business", owner);
    await app.tap("Furniture", "business", owner);
    expect(textOf(app.last("business", owner))).toContain("• Furniture");
    await app.tap("Yes, that's right", "business", owner);
    await b("Avondale");
    await app.tap("This number", "business", owner);
    await app.tap("I agree", "business", owner);
    const [cat] = await app.db.query<{ category_slug: string }>(
      "SELECT bc.category_slug FROM business_categories bc JOIN businesses b ON b.id = bc.business_id WHERE b.name = $1",
      ["Chipo's Clock Repairs"],
    );
    expect(cat?.category_slug).toBe("furniture");
    expect(claude.calls.every((c) => !c.text.includes("clocks"))).toBe(true);
  });
});

describe("Claude calls", () => {
  it("run with thinking off, carry the local notes, and are costed", async () => {
    let params: Record<string, unknown> = {};
    const client = {
      beta: {
        messages: {
          parse: async (p: Record<string, unknown>) => {
            params = p;
            return {
              model: "claude-sonnet-5",
              stop_reason: "end_turn",
              usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 3000, cache_creation_input_tokens: 0 },
              parsed_output: interpretation({ category_slug: "cakes", query: "wedding cake" }),
            };
          },
        },
      },
    } as unknown as Anthropic;
    const recorded: unknown[][] = [];
    const reader = new ClaudeInterpreter({
      client,
      model: "claude-sonnet-5",
      brand: "TestDir",
      log: silentLogger,
      meter: { record: async (...args) => void recorded.push(args) },
    });
    const result = await reader.interpretRequest("ndoda keke", { taxonomy: app.services.taxonomy, notes: ["Words not recognised: keke"], contactId: "c-1" });
    expect(result?.category_slug).toBe("cakes");
    expect(params).toMatchObject({ model: "claude-sonnet-5", thinking: { type: "disabled" }, output_config: { effort: "low" } });
    expect(JSON.stringify(params.messages)).toContain("Words not recognised: keke");
    expect(recorded[0]).toEqual(["request", "claude-sonnet-5", expect.objectContaining({ input_tokens: 100 }), "c-1"]);
    // $2 per million input, $0.20 cached, $10 output.
    expect(costOf("claude-sonnet-5", { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 3000 })).toBeCloseTo(0.0013, 6);
    expect(costOf("claude-opus-5", { input_tokens: 1_000_000, output_tokens: 0 })).toBe(5);
  });

  it("shows understanding and spend on the System screen", async () => {
    const system = (await server.inject({ url: "/ops/api/system" })).json();
    const by = Object.fromEntries((system.understood7d as { by: string; requests: number }[]).map((r) => [r.by, r.requests]));
    expect(by.local).toBeGreaterThan(0);
    expect(by.claude).toBeGreaterThan(0);
    expect(by.phrasebook).toBeGreaterThan(0);
    expect(system.claude.today.find((r: { feature: string }) => r.feature === "request")).toMatchObject({ calls: 2 });
    expect(system.features.understanding).toBe("local, then fake-claude");
  });

  // Last: this uses up the day's budget.
  it("stops all Claude calls when the daily budget is spent, and says so once", async () => {
    await app.services.budget.record("request", "claude-sonnet-5", { input_tokens: 0, output_tokens: 200_000 }); // $2
    expect(alerts.recent.filter((a) => a.key === "claude-budget-100")).toHaveLength(0);
    const before = claude.calls.length;
    const c = as(newCustomer());
    await c.consented();
    await c.say("ndoda zvinotapira zvebirthday");
    expect(claude.calls.length).toBe(before);
    expect(alerts.recent.filter((a) => a.key === "claude-budget-100")).toHaveLength(1);
    expect(alerts.recent.some((a) => a.key === "claude-budget-80")).toBe(true);
  });
});
