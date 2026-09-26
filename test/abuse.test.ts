import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebhookAlerts } from "../src/alerts.js";
import { createServer, registerRoutes } from "../src/http/server.js";
import { silentLogger } from "../src/logger.js";
import { testApp, textOf, type TestApp } from "./helpers.js";

const alerts = new WebhookAlerts({ brand: "TestDir", log: silentLogger });
let app: TestApp;
let server: FastifyInstance;
let n = 0;
const newCustomer = () => `26377444${String(++n).padStart(4, "0")}`;

beforeAll(async () => {
  app = await testApp({ RATE_LIMIT_PER_MINUTE: "15", REPORTS_PER_DAY: "2", REPORTS_TO_PAUSE: "2" }, { alerts });
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
    texts: () => app.outbox("customer", customer).map((m) => textOf(m.message)),
    consented: async () => {
      await app.say("hi", customer);
      await app.tap("I agree", "customer", customer);
    },
  };
}

describe("floods from one number", () => {
  it("answers the first messages, says to slow down once, then ignores the rest", async () => {
    const c = as(newCustomer());
    await c.consented(); // 2 messages
    for (let i = 0; i < 18; i++) await c.say(`I need a plumber in Mabelreign ${i}`);
    const texts = c.texts();
    expect(texts.filter((t) => t.includes("faster than I can answer"))).toHaveLength(1);
    expect(texts.filter((t) => t.startsWith("We have"))).toHaveLength(13); // messages 3 to 15 of the minute
  });
});

describe("reports", () => {
  async function connectWith(c: ReturnType<typeof as>, business: string) {
    await c.say("I need a plumber in Mabelreign");
    await c.tap(business);
    await c.tap("Connect me");
  }

  it("limits reports per customer per day", async () => {
    const c = as(newCustomer());
    await c.consented();
    await c.say("I need a plumber in Mabelreign");
    for (let i = 0; i < 2; i++) {
      await c.tap("QuickFix");
      await c.tap("Report");
      await c.say(`Rude on the phone ${i}`);
    }
    await c.tap("QuickFix");
    await c.tap("Report");
    expect(c.texts().at(-1)).toContain("already had several reports from you today");
  });

  it("pauses a listing only after reports from different customers who contacted it", async () => {
    const business = "Waterfalls Plumbers (sample)";
    const status = async () => (await app.db.query<{ status: string }>("SELECT status FROM businesses WHERE name = $1", [business]))[0]?.status;

    // A customer who never contacted them: the report is kept but doesn't count towards pausing.
    const stranger = as(newCustomer());
    await stranger.consented();
    await stranger.say("I need a plumber in Waterfalls");
    await stranger.tap("Waterfalls");
    await stranger.tap("Report");
    await stranger.say("Scammers");

    const first = as(newCustomer());
    await first.consented();
    await connectWith(first, "Waterfalls");
    await first.tap("Report");
    await first.say("Took a deposit and disappeared");
    expect(await status()).toBe("active");

    const second = as(newCustomer());
    await second.consented();
    await connectWith(second, "Waterfalls");
    await second.tap("Report");
    await second.say("Same, took my money");
    expect(await status()).toBe("paused");
    expect(alerts.recent.some((a) => a.text.includes(business))).toBe(true);

    const reports = (await server.inject({ url: "/ops/api/reports" })).json() as { business: string; had_introduction: boolean }[];
    const theirs = reports.filter((r) => r.business === business);
    expect(theirs.map((r) => r.had_introduction).sort()).toEqual([false, true, true]);
  });
});

describe("blocking a number", () => {
  it("stops answering a blocked number", async () => {
    const customer = newCustomer();
    const c = as(customer);
    await c.consented();
    const [contact] = (await server.inject({ url: `/ops/api/contacts?phone=${customer}` })).json() as { id: string }[];
    const res = await server.inject({ method: "POST", url: `/ops/api/contacts/${contact!.id}/block`, payload: { blocked: true, reason: "Spam" } });
    expect(res.statusCode).toBe(200);
    const before = c.texts().length;
    await c.say("I need a plumber in Mabelreign");
    expect(c.texts()).toHaveLength(before);

    await server.inject({ method: "POST", url: `/ops/api/contacts/${contact!.id}/block`, payload: { blocked: false } });
    await c.say("I need a plumber in Mabelreign");
    expect(c.texts().length).toBeGreaterThan(before);
  });
});
