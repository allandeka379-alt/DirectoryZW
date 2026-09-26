import type Anthropic from "@anthropic-ai/sdk";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebhookAlerts } from "../src/alerts.js";
import { ClaudeInterpreter } from "../src/ai/claude-interpreter.js";
import { createServer, registerRoutes } from "../src/http/server.js";
import { silentLogger } from "../src/logger.js";
import { interpretation } from "./fakes.js";
import { testApp, textOf, type TestApp } from "./helpers.js";

let n = 0;
const newCustomer = () => `26377666${String(++n).padStart(4, "0")}`;

/** A customer who agrees, searches for a plumber in Mabelreign and connects with QuickFix. */
async function connectToQuickFix(app: TestApp, customer = newCustomer()) {
  await app.say("hi", customer);
  await app.tap("I agree", "customer", customer);
  await app.say("I need a plumber in Mabelreign", customer);
  await app.tap("QuickFix", "customer", customer);
  await app.tap("Connect me", "customer", customer);
  return customer;
}

describe("messages stay inside conversations people started (free)", () => {
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

  it("tells a business about a lead only while its own window is open", async () => {
    const plumber = await app.phoneOf("QuickFix Plumbing (sample)");
    await connectToQuickFix(app);
    expect(app.outbox("business", plumber)).toHaveLength(0); // it hasn't written to us: no paid template

    await app.send("business", plumber, { type: "text", text: "menu" });
    await connectToQuickFix(app);
    const lead = app.outbox("business", plumber).at(-1)!;
    expect(lead.template).toBeUndefined(); // free, inside the window it just opened
    expect(textOf(lead.message)).toContain("New customer from TestDir");
  });

  it("lists a business's customers by reference, free, in its menu", async () => {
    const plumber = await app.phoneOf("QuickFix Plumbing (sample)");
    await app.send("business", plumber, { type: "text", text: "menu" });
    expect(textOf(app.last("business", plumber))).toMatch(/This week: shown in \d+ searches · \d+ customers connected/);
    await app.tap("My customers", "business", plumber);
    const list = textOf(app.last("business", plumber));
    expect(list).toContain("Customers who contacted *QuickFix Plumbing (sample)* through us");
    const refs = await app.db.query<{ ref_code: string }>(
      "SELECT i.ref_code FROM introductions i JOIN businesses b ON b.id = i.business_id WHERE b.phone = $1",
      [plumber],
    );
    for (const r of refs) expect(list).toContain(r.ref_code);
  });

  it("skips a follow-up that would need a paid template", async () => {
    const customer = await connectToQuickFix(app);
    const before = app.outbox("customer", customer).length;
    app.advanceHours(30); // the job ran late: the window "Connect me" opened has closed
    await app.runJobs();
    expect(app.outbox("customer", customer)).toHaveLength(before);
  });

  it("won't send a handoff reply WhatsApp would refuse", async () => {
    const customer = newCustomer();
    await app.say("hi", customer);
    await app.tap("I agree", "customer", customer);
    await app.say("agent", customer);
    const [contact] = await app.db.query<{ id: string }>("SELECT id FROM contacts WHERE wa_id = $1 AND channel = 'customer'", [customer]);
    const chats = (await server.inject({ url: "/ops/api/handoffs" })).json() as { contact_id: string; window_closes_at: string }[];
    expect(chats.find((c) => c.contact_id === contact!.id)?.window_closes_at).toBeTruthy();

    const ok = await server.inject({ method: "POST", url: `/ops/api/contacts/${contact!.id}/reply`, payload: { text: "Hello, how can we help?" } });
    expect(ok.statusCode).toBe(200);
    await app.db.query("UPDATE contacts SET last_inbound_at = now() - interval '25 hours' WHERE id = $1", [contact!.id]);
    const late = await server.inject({ method: "POST", url: `/ops/api/contacts/${contact!.id}/reply`, payload: { text: "Still there?" } });
    expect(late.statusCode).toBe(409);
    expect(late.json().error).toContain("24-hour window has closed");
  });

  it("shows what running the service costs", async () => {
    const system = (await server.inject({ url: "/ops/api/system" })).json() as {
      costs: { month: { templates: number; requests: number }; settings: { leadNotices: string; weeklySummaries: string; followUpDelayHours: number } };
    };
    expect(system.costs.month.templates).toBe(0);
    expect(system.costs.settings).toMatchObject({ leadNotices: "free_only", weeklySummaries: "off", followUpDelayHours: 20 });
  });
});

describe("paid templates, when switched on", () => {
  const alerts = new WebhookAlerts({ brand: "TestDir", log: silentLogger });
  let capped: TestApp;
  let paid: TestApp;
  beforeAll(async () => {
    capped = await testApp({ LEAD_NOTICES: "always", TEMPLATE_DAILY_CAP: "1" }, { alerts });
    paid = await testApp({ PAID_FOLLOW_UPS: "true" });
  });
  afterAll(async () => {
    await capped.close();
    await paid.close();
  });

  it("sends lead notices as templates up to the daily cap, then stops and tells the team", async () => {
    const plumber = await capped.phoneOf("QuickFix Plumbing (sample)");
    await connectToQuickFix(capped);
    expect(capped.outbox("business", plumber).at(-1)!.template).toBe("lead_notification");
    await connectToQuickFix(capped);
    expect(capped.outbox("business", plumber)).toHaveLength(1); // the second would pass the cap of one
    expect(alerts.recent.some((a) => a.key === "template-cap")).toBe(true);
  });

  it("pays for a late follow-up only with PAID_FOLLOW_UPS", async () => {
    const customer = await connectToQuickFix(paid);
    paid.advanceHours(30);
    await paid.runJobs();
    const followUp = paid.outbox("customer", customer).at(-1)!;
    expect(followUp.template).toBe("follow_up");
    expect(textOf(followUp.message)).toContain("QuickFix Plumbing");
  });
});

describe("Claude calls", () => {
  let app: TestApp;
  beforeAll(async () => {
    app = await testApp();
  });
  afterAll(async () => {
    await app.close();
  });

  function fakeClaude(clock: { now: Date }) {
    const requests: { system: { cache_control?: unknown }[] }[] = [];
    let failing = false;
    const client = {
      beta: {
        messages: {
          parse: async (req: { system: { cache_control?: unknown }[] }) => {
            requests.push(req);
            if (failing) throw new Error("overloaded");
            return {
              model: "claude-sonnet-5",
              usage: { input_tokens: 10, output_tokens: 10 },
              stop_reason: "end_turn",
              parsed_output: interpretation({ category_slug: "plumbing", query: "plumber" }),
            };
          },
        },
      },
    } as unknown as Anthropic;
    const alerts = new WebhookAlerts({ brand: "TestDir", log: silentLogger, now: () => clock.now });
    const claude = new ClaudeInterpreter({ client, model: "claude-sonnet-5", brand: "TestDir", log: silentLogger, alerts, now: () => clock.now });
    return { claude, requests, alerts, fail: (on: boolean) => (failing = on) };
  }

  const ctx = () => ({ taxonomy: app.services.taxonomy, gazetteer: app.services.gazetteer });

  it("marks the prompt for caching only when a call follows another within minutes", async () => {
    const clock = { now: new Date() };
    const { claude, requests } = fakeClaude(clock);
    await claude.interpretRequest("plumber please", ctx());
    clock.now = new Date(clock.now.getTime() + 60_000);
    await claude.interpretRequest("plumber please", ctx());
    clock.now = new Date(clock.now.getTime() + 10 * 60_000);
    await claude.interpretRequest("plumber please", ctx());
    expect(requests.map((r) => "cache_control" in r.system[0]!)).toEqual([false, true, false]);
  });

  it("stops calling for five minutes after three failures in a row", async () => {
    const clock = { now: new Date() };
    const { claude, requests, alerts, fail } = fakeClaude(clock);
    fail(true);
    for (let i = 0; i < 4; i++) expect(await claude.interpretRequest("plumber please", ctx())).toBeNull();
    expect(requests).toHaveLength(3); // the fourth didn't wait on Claude at all
    expect(alerts.recent.some((a) => a.key === "claude-break")).toBe(true);

    fail(false);
    clock.now = new Date(clock.now.getTime() + 5 * 60_000 + 1);
    expect((await claude.interpretRequest("plumber please", ctx()))?.category_slug).toBe("plumbing");
    expect(requests).toHaveLength(4);
  });
});
