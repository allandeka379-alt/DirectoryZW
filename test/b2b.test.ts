import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, registerRoutes } from "../src/http/server.js";
import type { OutboundMessage } from "../src/whatsapp/outbound.js";
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

/** An owner on the business number, by the name of their (sample) listing. */
async function owner(name: string) {
  const phone = await app.phoneOf(name);
  return {
    phone,
    say: (text: string) => app.send("business", phone, { type: "text", text }),
    tap: (title: string) => app.tap(title, "business", phone),
    last: () => app.last("business", phone),
    outbox: () => app.outbox("business", phone),
  };
}

const rows = (m: OutboundMessage) =>
  m.kind === "list" ? m.sections.flatMap((s) => s.rows).filter((r) => r.id.startsWith("biz:")).map((r) => r.title) : [];

describe("businesses finding suppliers", () => {
  it("finds verified wholesalers near the shop, and tells the supplier which business is asking", async () => {
    const siyaso = await owner("Siyaso Hardware (sample)");
    await siyaso.say("menu");
    await siyaso.tap("Find a supplier");
    expect(textOf(siyaso.last())).toContain("What does *Siyaso Hardware (sample)* need to buy?");
    expect(textOf(siyaso.last())).toContain("near Mbare");

    await siyaso.say("cement wholesale");
    const results = siyaso.last();
    expect(textOf(results)).toMatch(/^We have (a supplier|\w+ suppliers) near Mbare that our team has verified, and (it has|they have) \*cement\*/);
    // Wholesalers only: not Siyaso itself, and not shops that sell only to the public.
    expect(rows(results)).toEqual([expect.stringMatching(/^Harare Cement Distr/)]);

    await siyaso.tap("Harare Cement");
    await siyaso.tap("Connect me");
    const link = siyaso.last();
    if (link.kind !== "cta_url") throw new Error(`Expected a link, got ${link.kind}`);
    expect(new URL(link.url).searchParams.get("text")).toMatch(/^Hi Harare Cement Distributors \(sample\), this is Siyaso Hardware \(sample\)\. We found you on TestDir \(ref [A-Z0-9]{5}\)/);

    const [request] = await app.db.query<{ buyer: string }>(
      "SELECT b.name AS buyer FROM requests r JOIN businesses b ON b.id = r.buyer_business_id WHERE r.raw_text = 'cement wholesale'",
    );
    expect(request?.buyer).toBe("Siyaso Hardware (sample)");
  });

  it("tells the supplier, free, while its own window is open", async () => {
    const supplier = await owner("Mbare Wholesale Groceries (sample)");
    await supplier.say("menu"); // opens its window
    const shop = await owner("Mbare Fresh Market Stall (sample)");
    await shop.say("menu");
    await shop.tap("Find a supplier");
    await shop.say("cooking oil in bulk");
    await shop.tap("Mbare Wholesale");
    await shop.tap("Connect me");
    const lead = supplier.outbox().at(-1)!;
    expect(lead.template).toBeUndefined();
    expect(textOf(lead.message)).toContain("New trade customer from TestDir");
    expect(textOf(lead.message)).toContain("*Mbare Fresh Market Stall (sample)* is looking for: cooking oil in bulk");
  });

  it("keeps wholesale-only businesses out of the public's searches", async () => {
    const customer = "263778880001";
    await app.say("hi", customer);
    await app.tap("I agree", "customer", customer);
    await app.say("I need cement in Workington", customer);
    const list = app.last("customer", customer);
    expect(rows(list).length).toBeGreaterThan(0);
    expect(rows(list).some((r) => r.startsWith("Harare Cement"))).toBe(false);
  });

  it("lets an owner say they sell to businesses too, and then other shops find them", async () => {
    const siyaso = await owner("Siyaso Hardware (sample)");
    await siyaso.say("menu");
    await siyaso.tap("Who I sell to");
    expect(textOf(siyaso.last())).toContain("Right now you sell to the public");
    await siyaso.tap("Both");
    expect(textOf(siyaso.last())).toContain("sells to the public and other businesses");

    const southerton = await owner("Southerton Building Supplies (sample)");
    await southerton.say("menu");
    await southerton.tap("Find a supplier");
    await southerton.say("cement wholesale");
    expect(rows(southerton.last())).toEqual(expect.arrayContaining([expect.stringMatching(/^Siyaso Hardware/), expect.stringMatching(/^Harare Cement/)]));
  });

  it("follows up on the business number, and 'menu' goes back to the business menu", async () => {
    const siyaso = await owner("Siyaso Hardware (sample)");
    app.advanceHours(21);
    await app.runJobs();
    const followUp = siyaso.last();
    expect(textOf(followUp)).toBe("Did you get what you needed from *Harare Cement Distributors (sample)*?");
    expect(followUp.kind === "buttons" && followUp.buttons.map((b) => b.title)).toEqual(["Yes, sorted", "Not yet", "It didn't work out"]);
    await siyaso.tap("Yes, sorted");
    await siyaso.tap("😀 Great");
    const [rated] = await app.db.query<{ rating_count: number }>("SELECT rating_count FROM businesses WHERE name = 'Harare Cement Distributors (sample)'");
    expect(rated?.rating_count).toBe(1);

    await siyaso.say("menu");
    const menu = siyaso.last();
    expect(menu.kind === "list" && menu.sections.flatMap((s) => s.rows).map((r) => r.title)).toContain("Find a supplier");
  });

  it("gives a business the retail stores in that line when no wholesaler has it", async () => {
    const siyaso = await owner("Siyaso Hardware (sample)");
    await siyaso.say("find a supplier");
    await siyaso.say("fridges wholesale");
    const list = siyaso.last();
    expect(textOf(list)).toMatch(
      /^No wholesaler we list has \*fridges\* yet, so here are retail stores that do\.\n\nWe have (a store|\w+ stores) near Mbare that our team has verified/,
    );
    expect(rows(list)).toEqual(expect.arrayContaining([expect.stringMatching(/^Borrowdale Home/)]));
    expect(list.kind === "list" && list.footer).toBe("Type menu for your business menu");

    // The store still hears which business is asking.
    await siyaso.tap("Borrowdale Home");
    await siyaso.tap("Connect me");
    const link = siyaso.last();
    if (link.kind !== "cta_url") throw new Error(`Expected a link, got ${link.kind}`);
    expect(new URL(link.url).searchParams.get("text")).toContain("this is Siyaso Hardware (sample)");
  });

  it("shows the team what businesses couldn't find from wholesalers, as wholesale gaps", async () => {
    const siyaso = await owner("Siyaso Hardware (sample)");
    await siyaso.say("find a supplier");
    await siyaso.say("solar panels wholesale");
    expect(textOf(siyaso.last())).toContain("No wholesaler we list offers *solar systems and installation* yet, so here are businesses that do.");
    const gaps = (await server.inject({ url: "/ops/api/supply-gaps" })).json() as { category: string; from_businesses: number }[];
    expect(gaps.find((g) => g.category === "solar")?.from_businesses).toBeGreaterThanOrEqual(1);
    expect(gaps.find((g) => g.category === "appliances")?.from_businesses).toBeGreaterThanOrEqual(1);
  });
});
