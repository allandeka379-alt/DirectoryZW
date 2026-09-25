import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, registerRoutes } from "../src/http/server.js";
import { applyRetention } from "../src/privacy.js";
import { FakeVision } from "./fakes.js";
import { testApp, textOf, type TestApp } from "./helpers.js";

const vision = new FakeVision();
let app: TestApp;
let server: FastifyInstance;
let n = 0;
const newCustomer = () => `26377555${String(++n).padStart(4, "0")}`;

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

const count = async (sql: string, params: unknown[]) => (await app.db.query<{ n: number }>(sql, params))[0]!.n;
const ops = (method: "GET" | "POST", url: string, payload?: object) =>
  server.inject({ method, url: `/ops/api${url}`, ...(payload ? { payload } : {}) });

describe("customers deleting their data", () => {
  it("deletes everything once they confirm, and starts fresh next time", async () => {
    const customer = newCustomer();
    await app.say("hi", customer);
    await app.tap("I agree", "customer", customer);
    await app.say("I need a plumber in Mabelreign", customer);
    await app.tap("QuickFix", "customer", customer);
    await app.tap("Connect me", "customer", customer);
    const [contact] = await app.db.query<{ id: string }>("SELECT id FROM contacts WHERE wa_id = $1", [customer]);

    await app.say("Delete my data", customer);
    expect(textOf(app.last("customer", customer))).toContain("Delete everything we hold about you?");
    await app.tap("Keep my data", "customer", customer);
    expect(await count("SELECT count(*)::int AS n FROM contacts WHERE wa_id = $1", [customer])).toBe(1);

    await app.say("delete my data", customer);
    await app.tap("Delete everything", "customer", customer);
    expect(textOf(app.last("customer", customer))).toContain("We've deleted everything we held about you");
    expect(await count("SELECT count(*)::int AS n FROM contacts WHERE wa_id = $1", [customer])).toBe(0);
    expect(await count("SELECT count(*)::int AS n FROM messages WHERE contact_id = $1 OR sender->>'from' = $2", [contact!.id, customer])).toBe(0);
    expect(await count("SELECT count(*)::int AS n FROM requests WHERE contact_id = $1", [contact!.id])).toBe(0);
    expect(await count("SELECT count(*)::int AS n FROM introductions WHERE contact_id = $1", [contact!.id])).toBe(0);

    await app.say("I need a plumber", customer);
    expect(textOf(app.last("customer", customer))).toContain("I agree"); // a brand-new contact
  });
});

describe("business owners deleting their data", () => {
  it("deletes their listings with photos and price lists, and keeps them out of web results", async () => {
    const owner = "263779777001";
    const b = (text: string) => app.send("business", owner, { type: "text", text });
    await b("register");
    await b("Chipo's Cakes");
    await b("We bake wedding cakes and do catering");
    await app.tap("Yes, that's right", "business", owner);
    await b("Avondale");
    await app.tap("This number", "business", owner);
    await app.tap("I agree", "business", owner);
    vision.priceListAnswer = { is_price_list: true, items: [{ name: "Wedding cake, 3 tier", price_usd: 120, price_text: "$120" }] };
    await app.send("business", owner, { type: "image", mediaId: app.simulatorMedia!.put({ data: Buffer.from("menu"), mimeType: "image/jpeg" }), mimeType: "image/jpeg" });
    await app.tap("Save prices", "business", owner);
    expect(app.files.files.size).toBeGreaterThan(0);
    const [biz] = await app.db.query<{ id: string }>("SELECT id FROM businesses WHERE name = $1", ["Chipo's Cakes"]);

    await b("delete my data");
    expect(textOf(app.last("business", owner))).toContain("*Chipo's Cakes*");
    await app.tap("Delete everything", "business", owner);
    expect(await count("SELECT count(*)::int AS n FROM businesses WHERE id = $1", [biz!.id])).toBe(0);
    expect(await count("SELECT count(*)::int AS n FROM offerings WHERE business_id = $1", [biz!.id])).toBe(0);
    expect([...app.files.files.keys()].some((k) => k.includes(biz!.id))).toBe(false);
    expect(await count("SELECT count(*)::int AS n FROM contacts WHERE wa_id = $1 AND channel = 'business'", [owner])).toBe(0);
    expect(await count("SELECT count(*)::int AS n FROM online_optouts", [])).toBe(1);
  });
});

describe("data requests through the ops console", () => {
  it("finds a person by number, exports their data, then erases it", async () => {
    const customer = newCustomer();
    await app.say("hi", customer);
    await app.tap("I agree", "customer", customer);
    await app.say("I need a plumber in Mabelreign", customer);

    const found = (await ops("GET", `/contacts?phone=0${customer.slice(3)}`)).json();
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ channel: "customer", wa_id: customer, requests: 1 });

    const exported = await ops("GET", `/contacts/${found[0].id}/export`);
    expect(exported.headers["content-disposition"]).toContain("attachment");
    const data = exported.json();
    expect(data.contact.wa_id).toBe(customer);
    expect(data.requests[0].raw_text).toBe("I need a plumber in Mabelreign");
    expect(data.messages.length).toBeGreaterThan(3);

    const erased = (await ops("POST", `/contacts/${found[0].id}/erase`)).json();
    expect(erased).toMatchObject({ ok: true, requests: 1 });
    expect((await ops("GET", `/contacts?phone=${customer}`)).json()).toHaveLength(0);
    const activity = (await ops("GET", "/activity")).json() as { action: string }[];
    expect(activity.map((a) => a.action)).toEqual(expect.arrayContaining(["contact.export", "contact.erase"]));
  });
});

describe("retention", () => {
  it("deletes old chats and the words of old requests, but keeps open handoffs", async () => {
    const customer = newCustomer();
    await app.say("hi", customer);
    await app.tap("I agree", "customer", customer);
    await app.say("I need a plumber in Mabelreign", customer);
    await app.say("agent", customer); // waiting for a person
    const later = new Date(Date.now() + 400 * 24 * 3600_000);
    const result = await applyRetention(app.db, later, { messageDays: 180, requestDays: 365 });
    expect(result.messages).toBeGreaterThan(0);
    expect(result.requests).toBeGreaterThan(0);
    const [request] = await app.db.query<{ raw_text: string; category_slug: string | null; status: string }>(
      "SELECT r.raw_text, r.category_slug, r.status FROM requests r JOIN contacts c ON c.id = r.contact_id WHERE c.wa_id = $1 ORDER BY r.created_at LIMIT 1",
      [customer],
    );
    expect(request).toMatchObject({ raw_text: "", category_slug: "plumbing" }); // statistics survive
    expect(await count("SELECT count(*)::int AS n FROM sessions s JOIN contacts c ON c.id = s.contact_id WHERE c.wa_id = $1", [customer])).toBe(1);
  });
});
