import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testApp, textOf, type TestApp } from "./helpers.js";

let app: TestApp;
beforeAll(async () => {
  app = await testApp();
});
afterAll(async () => {
  await app.close();
});

// One database for the file; each test is a different customer.
let n = 0;
const newCustomer = () => `26377111${String(++n).padStart(4, "0")}`;

function as(customer: string) {
  return {
    say: (text: string) => app.say(text, customer),
    tap: (title: string) => app.tap(title, "customer", customer),
    last: () => app.last("customer", customer),
    outbox: () => app.outbox("customer", customer),
    consented: async () => {
      await app.say("hi", customer);
      await app.tap("I agree", "customer", customer);
    },
  };
}

describe("customer journey", () => {
  it("asks for consent, then finds, connects and follows up", async () => {
    const c = as(newCustomer());
    await c.say("I need a plumber in Mabelreign");
    expect(c.last().kind).toBe("buttons");
    expect(textOf(c.last())).toContain("TestDir");

    await c.tap("I agree");
    const list = c.last();
    if (list.kind !== "list") throw new Error(`Expected a list, got ${list.kind}`);
    expect(list.sections[0]!.rows[0]!.title).toMatch(/^QuickFix/);
    expect(textOf(list)).toContain("Don't pay a deposit"); // an unverified business is in the list

    await c.tap("QuickFix");
    expect(textOf(c.last())).toContain("QuickFix Plumbing");

    await c.tap("Connect me");
    const link = c.last();
    if (link.kind !== "cta_url") throw new Error(`Expected a link, got ${link.kind}`);
    const phone = await app.phoneOf("QuickFix Plumbing (sample)");
    const url = new URL(link.url);
    expect(url.pathname).toBe(`/${phone}`);
    const ref = url.searchParams.get("text")!.match(/ref ([A-Z0-9]{5})/)![1]!;

    const lead = app.outbox("business", phone).at(-1)!;
    expect(lead.template).toBe("lead_notification"); // the business hasn't written to us, so a template is required
    expect(textOf(lead.message)).toContain(ref);
    expect(textOf(lead.message)).not.toContain(c.outbox()[0]!.to); // the customer's number is never handed over

    app.advanceHours(73);
    expect(await app.runJobs()).toBeGreaterThanOrEqual(1);
    const followUp = c.outbox().at(-1)!;
    expect(followUp.template).toBe("follow_up");
    expect(textOf(followUp.message)).toContain("QuickFix Plumbing");

    await c.tap("Yes, sorted");
    await c.tap("😀 Great");
    expect(textOf(c.last())).toContain("Thanks");
    const [b] = await app.db.query("SELECT rating_sum, rating_count FROM businesses WHERE phone = $1", [phone]);
    expect(b).toEqual({ rating_sum: 5, rating_count: 1 });
  });

  it("asks where to look, then accepts a shared location", async () => {
    const customer = newCustomer();
    const c = as(customer);
    await c.consented();
    expect(textOf(c.last())).toContain("What are you looking for");
    await c.say("I need a fridge");
    expect(c.last().kind).toBe("location_request");
    const borrowdale = app.services.gazetteer.match("Borrowdale")!;
    await app.send("customer", customer, { type: "location", lat: borrowdale.lat, lng: borrowdale.lng });
    const list = c.last();
    if (list.kind !== "list") throw new Error(`Expected a list, got ${list.kind}`);
    expect(list.sections[0]!.rows.map((r) => r.title)).toContainEqual(expect.stringMatching(/^Borrowdale Home/));
  });

  it("accepts a typed suburb after asking where", async () => {
    const c = as(newCustomer());
    await c.consented();
    await c.say("I need a mechanic");
    await c.say("Arcadia");
    expect(textOf(c.last())).toContain("near Arcadia");
  });

  it("asks around when nothing is listed and passes on a business that can help", async () => {
    const c = as(newCustomer());
    await c.consented();
    await c.say("I need a wedding venue in Avondale");
    expect(textOf(c.last())).toContain("couldn't find");
    await c.tap("Ask around");
    expect(textOf(c.last())).toMatch(/I've asked \d+ businesses/);

    const eventHire = await app.phoneOf("Msasa Event Hire (sample)");
    expect(textOf(app.last("business", eventHire))).toContain("wedding venue");
    await app.tap("Yes, I can help", "business", eventHire);
    expect(textOf(app.last("business", eventHire))).toContain("told the customer");

    expect(textOf(c.last())).toContain("Msasa Event Hire");
    await c.tap("Connect me");
    expect(c.last().kind).toBe("cta_url");
  });

  it("refuses blocked requests and off-topic questions", async () => {
    const c = as(newCustomer());
    await c.consented();
    await c.say("where can I buy weed");
    expect(textOf(c.last())).toContain("can't help with that");
    await c.say("who won the football yesterday");
    expect(textOf(c.last())).toContain("only help you find businesses");
  });

  it("hands over to a person and back", async () => {
    const c = as(newCustomer());
    await c.consented();
    await c.say("I want to talk to a person");
    expect(textOf(c.last())).toContain("person from our team");
    const before = c.outbox().length;
    await c.say("hello?");
    expect(c.outbox()).toHaveLength(before); // the bot stays quiet
    await c.say("menu");
    expect(textOf(c.last())).toContain("back with the assistant");
  });

  it("ignores a message WhatsApp delivers twice", async () => {
    const customer = newCustomer();
    const msg = {
      channel: "customer" as const,
      waMessageId: `wamid.same.${customer}`,
      from: customer,
      phone: customer,
      timestamp: app.clock.now,
      content: { type: "text" as const, text: "hi" },
    };
    await app.engine.enqueue(msg);
    await app.engine.enqueue(msg);
    expect(as(customer).outbox()).toHaveLength(1);
  });
});
