import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, registerRoutes } from "../src/http/server.js";
import { testApp, textOf, type TestApp } from "./helpers.js";
import { dashboardOf, newCustomer } from "./shops.js";

// Requests are stamped by the database's clock and alerts look back a day by ours, so these tests
// have an app of their own, and the one that moves the clock a day on comes last.
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

/** Background jobs, a minute on, as they'd run. */
async function aMinuteLater(): Promise<void> {
  app.advanceHours(1 / 60);
  await app.runJobs();
}

const alertsIn = (texts: string[]) => texts.filter((t) => t.includes("has just listed"));

describe("alerts when a store lists what nobody had", () => {
  it("tells the customer once, in the background, and the store's card follows", async () => {
    const shop = await dashboardOf(app, server, "Avondale Electronics (sample)");
    const c = newCustomer(app);
    await c.agree();
    await c.say("hisense 65 inch tv in Avondale");
    // Nobody lists one: the results are stores in the trade.
    expect(textOf(c.last())).not.toContain("I found");
    const before = c.all().length;

    await shop.add({ name: "Hisense 65 inch UHD smart TV", price: 899 });
    // Not while the owner waits: a moment later, from the job queue.
    expect(c.all()).toHaveLength(before);
    await aMinuteLater();
    const alert = textOf(c.last());
    expect(alert).toMatch(/^Good news, Chipo! Earlier you asked for \*.+\*, and nobody had it listed\./);
    expect(alert).toContain(
      "*Avondale Electronics (sample)* in Avondale (under 1 km from you) has just listed *Hisense 65 inch UHD smart TV* for *$899.00*.",
    );
    expect(alert).toContain("✅ Verified by our team.");

    await c.tap("See it");
    expect(textOf(c.last())).toContain("• Hisense 65 inch UHD smart TV: *$899.00*");

    // Once per request: another listing doesn't alert again.
    const seen = c.all().length;
    await shop.add({ name: "Hisense 65 inch QLED TV", price: 1099 });
    await aMinuteLater();
    expect(c.all()).toHaveLength(seen);
  });

  it("sends nothing to someone who said stop or switched alerts off, and alerts can come back on", async () => {
    const shop = await dashboardOf(app, server, "Borrowdale Home Appliances (sample)");
    const stopped = newCustomer(app);
    await stopped.agree();
    await stopped.say("lg washing machine in Borrowdale");
    await stopped.say("stop");
    const quiet = newCustomer(app);
    await quiet.agree();
    await quiet.say("lg washing machine in Borrowdale");
    await quiet.say("alerts off");
    expect(textOf(quiet.last())).toContain("Okay, no more alerts.");

    await shop.add({ name: "LG 8kg washing machine", price: 520 });
    await aMinuteLater();
    expect(alertsIn(stopped.texts())).toEqual([]);
    expect(alertsIn(quiet.texts())).toEqual([]);

    // Back on: their next request nobody can answer can bring one.
    await quiet.say("alerts on");
    expect(textOf(quiet.last())).toContain("Alerts are on.");
    await quiet.say("defy stove in Borrowdale");
    await shop.add({ name: "Defy 4 plate stove", price: 380 });
    await aMinuteLater();
    expect(alertsIn(quiet.texts())).toHaveLength(1);
    expect(textOf(quiet.last())).toContain("has just listed *Defy 4 plate stove*");

    // "No more alerts" on an alert switches them off too.
    await quiet.tap("No more alerts");
    expect(textOf(quiet.last())).toContain("Okay, no more alerts.");
  });

  it("leaves out prices over their budget, requests a store already answered, and ones they connected on", async () => {
    const shop = await dashboardOf(app, server, "Gulf Tech Traders (sample)");
    const budget = newCustomer(app);
    await budget.agree();
    await budget.say("tecno phone under $100 in Harare CBD");
    await shop.add({ name: "Tecno Spark 20 phone", price: 150 });
    await aMinuteLater();
    expect(alertsIn(budget.texts())).toEqual([]);
    await shop.add({ name: "Tecno Pop 8 phone", price: 95 });
    await aMinuteLater();
    expect(alertsIn(budget.texts())).toHaveLength(1);
    expect(textOf(budget.last())).toContain("*Tecno Pop 8 phone* for *$95.00*");

    // A store already lists one: they have their answer.
    const answered = newCustomer(app);
    await answered.agree();
    await answered.say("tecno phone in Harare CBD");
    expect(textOf(answered.last())).toContain("I found");
    await shop.add({ name: "Tecno Camon 30 phone", price: 240 });
    await aMinuteLater();
    expect(alertsIn(answered.texts())).toEqual([]);

    // They're already talking to a store about it.
    const connected = newCustomer(app);
    await connected.agree();
    await connected.say("samsung galaxy tablet in Harare CBD");
    await connected.tap("Gulf Tech Traders");
    await connected.tap("Connect me");
    await shop.add({ name: "Samsung Galaxy Tab A9 tablet", price: 210 });
    await aMinuteLater();
    expect(alertsIn(connected.texts())).toEqual([]);
  });

  it("leaves services to their trade", async () => {
    const plumber = await dashboardOf(app, server, "QuickFix Plumbing (sample)");
    const c = newCustomer(app);
    await c.agree();
    await c.say("I need a plumber to fix a burst geyser in Mabelreign");
    await plumber.add({ name: "Burst geyser repair", price: 60 });
    await aMinuteLater();
    expect(alertsIn(c.texts())).toEqual([]);
  });

  it("sends no more than two a day to one person", async () => {
    const c = newCustomer(app);
    await c.agree();
    for (const item of ["hisense microwave", "hisense kettle", "hisense blender"]) await c.say(`${item} in Borrowdale`);
    const shop = await dashboardOf(app, server, "Borrowdale Home Appliances (sample)");
    for (const name of ["Hisense microwave 20L", "Hisense kettle 1.7L", "Hisense blender 1.5L"]) await shop.add({ name, price: 40 });
    await aMinuteLater();
    expect(alertsIn(c.texts())).toHaveLength(2);
  });

  it("never writes once their free window has closed", async () => {
    const c = newCustomer(app);
    await c.agree();
    await c.say("samsung soundbar in Avondale");
    const n = c.all().length;
    app.advanceHours(25);
    const shop = await dashboardOf(app, server, "Avondale Electronics (sample)");
    await shop.add({ name: "Samsung soundbar 2.1", price: 180 });
    await aMinuteLater();
    expect(c.all()).toHaveLength(n);
  });
});
