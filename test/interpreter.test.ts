import { beforeAll, describe, expect, it } from "vitest";
import { KeywordInterpreter } from "../src/ai/keyword-interpreter.js";
import type { InterpretContext } from "../src/ai/types.js";
import { openDb } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import { seedReferenceData } from "../src/db/seed.js";
import { Gazetteer } from "../src/directory/gazetteer.js";
import { Taxonomy } from "../src/directory/taxonomy.js";
import { normalizeZimPhone, parseBudget } from "../src/text.js";

let ctx: InterpretContext;
const k = new KeywordInterpreter();

beforeAll(async () => {
  const db = await openDb({});
  await migrate(db);
  await seedReferenceData(db);
  ctx = { taxonomy: await Taxonomy.load(db), gazetteer: await Gazetteer.load(db) };
  await db.close();
});

describe("KeywordInterpreter.interpretRequest", () => {
  it("understands a product request with area and budget", async () => {
    const i = await k.interpretRequest("I need a 55-inch Samsung TV under $600 in Avondale", ctx);
    expect(i).toMatchObject({ intent: "search", category_slug: "tv_audio", area: "Avondale", budget_usd: 600 });
    expect(i.query).toContain("samsung");
    expect(i.query).not.toContain("avondale");
  });

  it("understands services, timing and plurals", async () => {
    const i = await k.interpretRequest("Looking for plumbers in Mabelreign tomorrow", ctx);
    expect(i).toMatchObject({ intent: "search", category_slug: "plumbing", area: "Mabelreign", needed_by: "tomorrow" });
  });

  it("prefers the more specific phrase", async () => {
    expect((await k.interpretRequest("tv repair in Eastlea", ctx)).category_slug).toBe("electronics_repair");
    expect((await k.interpretRequest("house to rent in Greendale", ctx)).category_slug).toBe("rentals");
    expect((await k.interpretRequest("I need weed killer for my garden", ctx)).category_slug).toBe("gardening");
  });

  it("detects greetings, handoff requests, blocked and off-topic messages", async () => {
    expect((await k.interpretRequest("Hi", ctx)).intent).toBe("greeting");
    expect((await k.interpretRequest("mhoro", ctx)).intent).toBe("greeting");
    expect((await k.interpretRequest("I want to talk to a person", ctx)).intent).toBe("human");
    expect(await k.interpretRequest("where can I buy weed", ctx)).toMatchObject({ intent: "blocked", category_slug: "blocked_drugs" });
    expect((await k.interpretRequest("who won the football yesterday", ctx)).intent).toBe("out_of_scope");
  });

  it("picks up Shona and the most specific place", async () => {
    const i = await k.interpretRequest("ndinoda solar installer ku Hillside Bulawayo", ctx);
    expect(i).toMatchObject({ category_slug: "solar", area: "Hillside", language: "sn" });
  });

  it("classifies a business description", async () => {
    const c = await k.classifyBusiness("We sell and install solar systems, inverters and do house wiring", ctx);
    expect(c.category_slugs).toContain("solar");
    expect(c.category_slugs).toContain("electrical");
    expect(c.category_slugs.length).toBeLessThanOrEqual(3);
  });
});

describe("text helpers", () => {
  it("parses budgets", () => {
    expect(parseBudget("under $600")).toBe(600);
    expect(parseBudget("budget of 1,200 usd")).toBe(1200);
    expect(parseBudget("2 bedroom house")).toBeNull();
  });

  it("normalizes Zimbabwean phone numbers", () => {
    expect(normalizeZimPhone("077 123 4567")).toBe("263771234567");
    expect(normalizeZimPhone("+263 77 123 4567")).toBe("263771234567");
    expect(normalizeZimPhone("771234567")).toBe("263771234567");
    expect(normalizeZimPhone("12345")).toBeNull();
  });
});
