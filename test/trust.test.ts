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

let n = 0;
const newCustomer = () => `26377333${String(++n).padStart(4, "0")}`;

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

const buttons = (m: OutboundMessage) => (m.kind === "buttons" ? m.buttons.map((b) => b.title) : []);
const businesses = (m: OutboundMessage) =>
  m.kind === "list" ? m.sections.flatMap((s) => s.rows).filter((r) => r.id.startsWith("biz:")).map((r) => r.title) : [];

const businessId = async (name: string) => (await app.db.query<{ id: string }>("SELECT id FROM businesses WHERE name = $1", [name]))[0]!.id;

/** A customer connects with a business from their results; the next day, the (free) follow-up. */
async function connectAndFollowUp(c: ReturnType<typeof as>, business: string) {
  await c.tap(business);
  await c.tap("Connect me");
  app.advanceHours(21);
  await app.runJobs();
}

/** Customers' follow-up answers about a business, straight into the database. */
async function answers(business: string, outcomes: string[]) {
  const [contact] = await app.db.query<{ id: string }>("SELECT id FROM contacts LIMIT 1");
  const id = await businessId(business);
  for (const outcome of outcomes) {
    await app.db.query(
      "INSERT INTO introductions (ref_code, contact_id, business_id, outcome) VALUES (upper(substr(md5(random()::text), 1, 8)), $1, $2, $3)",
      [contact!.id, id, outcome],
    );
  }
}

type Recheck = { id: string; name: string; reasons: string[] };
const rechecks = async () => (await server.inject({ url: "/ops/api/rechecks" })).json() as Recheck[];
const recheck = (id: string, outcome: string, note?: string) =>
  server.inject({ method: "POST", url: `/ops/api/businesses/${id}/recheck`, payload: { outcome, reasons: ["test"], note } });

describe("the follow-up asks whether the business came through", () => {
  it("asks a store's customer whether it had the item, and doesn't offer that store again", async () => {
    const c = as(newCustomer());
    await c.consented();
    await c.say("I need a samsung tv in Avondale");
    expect(businesses(c.last())).toEqual([expect.stringMatching(/^Avondale Electronics/), expect.stringMatching(/^Gulf Tech Traders/)]);
    await connectAndFollowUp(c, "Avondale Electronics");
    expect(textOf(c.last())).toBe("Did you get what you needed from *Avondale Electronics (sample)*?");
    expect(buttons(c.last())).toEqual(["Yes, sorted", "Not yet", "It didn't work out"]);

    await c.tap("It didn't work out");
    expect(textOf(c.last())).toBe("Sorry about that. What happened?");
    expect(buttons(c.last())).toEqual(["They didn't reply", "Didn't have it", "Something else"]);
    await c.tap("Didn't have it");
    expect(textOf(c.last())).toContain("Sorry they didn't have it. Thanks for telling us: our team checks again any business that keeps letting customers down.");
    const [intro] = await app.db.query<{ outcome: string }>(
      "SELECT i.outcome FROM introductions i JOIN businesses b ON b.id = i.business_id WHERE b.name = 'Avondale Electronics (sample)' AND i.request_id IS NOT NULL",
    );
    expect(intro?.outcome).toBe("couldnt_help");

    // The other store only, and when that one lets them down too, a person offers to help.
    await c.tap("Other options");
    expect(businesses(c.last())).toEqual([expect.stringMatching(/^Gulf Tech Traders/)]);
    await connectAndFollowUp(c, "Gulf Tech");
    await c.tap("It didn't work out");
    await c.tap("They didn't reply");
    await c.tap("Other options");
    expect(textOf(c.last())).toContain("We don't have any other businesses for that yet");
    expect(buttons(c.last())).toEqual(["Talk to a person", "New search"]);
  });

  it("asks a service's customer whether they could help, and ranks businesses that don't reply lower", async () => {
    const c = as(newCustomer());
    await c.consented();
    await c.say("I need a plumber in Mabelreign");
    const before = (await app.db.query<{ response_score: number }>("SELECT response_score FROM businesses WHERE name = 'QuickFix Plumbing (sample)'"))[0]!;
    await connectAndFollowUp(c, "QuickFix");
    await c.tap("It didn't work out");
    expect(buttons(c.last())).toEqual(["They didn't reply", "Couldn't help", "Something else"]);
    await c.tap("They didn't reply");
    expect(textOf(c.last())).toContain("Sorry they didn't reply.");
    expect(textOf(c.last())).toContain("Would you like to try another business?");
    const after = (await app.db.query<{ response_score: number }>("SELECT response_score FROM businesses WHERE name = 'QuickFix Plumbing (sample)'"))[0]!;
    expect(after.response_score).toBeLessThan(before.response_score);
  });

  it("takes 'something else' as a report in the customer's words", async () => {
    const customer = newCustomer();
    const c = as(customer);
    await c.consented();
    await c.say("I need an electrician in Belvedere");
    await connectAndFollowUp(c, "PowerLine");
    await c.tap("It didn't work out");
    await c.tap("Something else");
    expect(textOf(c.last())).toContain("What went wrong?");
    await c.say("they asked for a deposit and then stopped answering");
    expect(textOf(c.last())).toContain("Our team will look into it");
    const [report] = await app.db.query<{ reason: string; had_introduction: boolean }>(
      "SELECT r.reason, r.had_introduction FROM reports r JOIN businesses b ON b.id = r.business_id WHERE b.name = 'PowerLine Electricians (sample)'",
    );
    expect(report).toEqual({ reason: "they asked for a deposit and then stopped answering", had_introduction: true });
  });
});

describe("track records", () => {
  it("shows customers when our team checked a business, and how customers got on once enough have said", async () => {
    const c = as(newCustomer());
    await c.consented();
    await c.say("I need a plumber in Hatfield");
    await c.tap("Hatfield Plumbing");
    const card = textOf(c.last());
    const month = new Date().toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "Africa/Harare" });
    expect(card).toContain(`✅ Verified by our team in ${month}`);
    expect(card).not.toContain("👍"); // nobody has answered a follow-up yet

    await answers("Hatfield Plumbing Works (sample)", ["sorted", "sorted", "sorted", "sorted", "no_reply", "not_yet"]);
    await c.tap("Hatfield Plumbing");
    // "Not yet" isn't an answer, so it's 4 of 5.
    expect(textOf(c.last())).toContain("👍 4 of the last 5 customers we sent them got what they needed");
  });
});

describe("re-checks", () => {
  it("lists verified businesses that keep letting customers down, with the reasons", async () => {
    await answers("Siyaso Hardware (sample)", ["no_reply", "no_reply", "couldnt_help", "sorted"]);
    const siyaso = (await rechecks()).find((r) => r.name === "Siyaso Hardware (sample)");
    expect(siyaso?.reasons).toEqual([
      "Only 1 of 4 customers got what they needed",
      "2 customers said they didn't reply, in the last 30 days",
    ]);

    // Still good: off the list for now, and the check renews the verification.
    expect((await recheck(siyaso!.id, "still_good", "Owner was away; has a new number")).statusCode).toBe(200);
    expect((await rechecks()).some((r) => r.name === "Siyaso Hardware (sample)")).toBe(false);
    const [b] = await app.db.query<{ verification: string; verified_by: string }>("SELECT verification, verified_by FROM businesses WHERE id = $1", [siyaso!.id]);
    expect(b?.verification).toBe("verified");
    const [check] = await app.db.query<{ outcome: string; note: string }>("SELECT outcome, note FROM rechecks WHERE business_id = $1", [siyaso!.id]);
    expect(check).toEqual({ outcome: "still_good", note: "Owner was away; has a new number" });
  });

  it("puts reported and long-verified businesses on the list, and can take the tick away or pause them", async () => {
    const tents = await businessId("Msasa Event Hire (sample)");
    await app.db.query("INSERT INTO reports (business_id, reason, had_introduction) VALUES ($1, 'Tent was torn and they kept the deposit', true)", [tents]);
    const solar = await businessId("SunPower Solar Harare (sample)");
    await app.db.query("UPDATE businesses SET verified_at = now() - interval '400 days' WHERE id = $1", [solar]);

    const list = await rechecks();
    expect(list[0]?.name).toBe("Msasa Event Hire (sample)"); // reports come first
    expect(list[0]?.reasons).toEqual(["1 open report from customers"]);
    expect(list.find((r) => r.id === solar)?.reasons).toEqual(["Verified 13 months ago"]);

    await recheck(tents, "unverified");
    const [t] = await app.db.query<{ verification: string; verified_at: Date | null }>("SELECT verification, verified_at FROM businesses WHERE id = $1", [tents]);
    expect(t).toEqual({ verification: "registered", verified_at: null });
    // The report that put it on the list has been looked into.
    const [report] = await app.db.query<{ status: string }>("SELECT status FROM reports WHERE business_id = $1", [tents]);
    expect(report?.status).toBe("actioned");
    await recheck(solar, "paused");
    const [s] = await app.db.query<{ status: string }>("SELECT status FROM businesses WHERE id = $1", [solar]);
    expect(s?.status).toBe("paused");
    expect((await rechecks()).some((r) => r.id === tents || r.id === solar)).toBe(false);

    const detail = (await server.inject({ url: `/ops/api/businesses/${solar}` })).json() as { rechecks: { outcome: string }[] };
    expect(detail.rechecks.map((r) => r.outcome)).toEqual(["paused"]);
    expect((await recheck(solar, "demoted")).statusCode).toBe(400);
  });
});

describe("reports can't sit unread", () => {
  it("reminds the team once about a report left open for a day", async () => {
    const id = await businessId("Glam Studio Salon (sample)");
    await app.db.query(
      "INSERT INTO reports (business_id, reason, created_at) VALUES ($1, 'Charged double the price agreed', now() - interval '25 hours')",
      [id],
    );
    const summary = (await server.inject({ url: "/ops/api/summary" })).json() as { reports_over_a_day: number };
    expect(summary.reports_over_a_day).toBeGreaterThanOrEqual(1);

    const reminders = () => app.services.alerts.recent.filter((a) => a.key === "reports-waiting");
    app.advanceHours(2);
    await app.runJobs();
    expect(reminders()).toHaveLength(1);
    expect(reminders()[0]!.text).toContain("Glam Studio Salon (sample)");

    app.advanceHours(2);
    await app.runJobs();
    expect(reminders()).toHaveLength(1); // raised once, not every hour
  });
});
