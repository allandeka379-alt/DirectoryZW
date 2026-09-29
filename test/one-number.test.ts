import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isRegisterIntent } from "../src/conversation/router.js";
import type { InboundContent } from "../src/whatsapp/types.js";
import { testApp, textOf, type TestApp } from "./helpers.js";

let app: TestApp;
beforeAll(async () => {
  app = await testApp();
});
afterAll(async () => {
  await app.close();
});

let seq = 0;
/** A message to our one WhatsApp number: the router picks the side, as for a real message. */
async function write(from: string, content: InboundContent, name = "Rudo"): Promise<void> {
  await app.engine.enqueue({
    channel: "customer",
    route: true,
    waMessageId: `one-${++seq}`,
    from,
    phone: from,
    profileName: name,
    timestamp: app.clock.now,
    content,
  });
}
const say = (from: string, text: string) => write(from, { type: "text", text });
/** Everything our number sent this person, from either side. */
const inbox = (to: string) => app.sim.sinceAny(to, 0);
const last = (to: string) => inbox(to).at(-1)!.message;
const sideOf = (to: string) => inbox(to).at(-1)!.channel;

async function tap(from: string, title: string): Promise<void> {
  for (const { message: m } of [...inbox(from)].reverse()) {
    if (m.kind === "buttons") {
      const b = m.buttons.find((x) => x.title === title);
      if (b) return write(from, { type: "button_reply", id: b.id, title: b.title });
    }
    if (m.kind === "list") {
      for (const s of m.sections) {
        const r = s.rows.find((x) => x.title === title || x.title.startsWith(title));
        if (r) return write(from, { type: "list_reply", id: r.id, title: r.title });
      }
    }
  }
  throw new Error(`No button or row "${title}" in messages to ${from}`);
}

async function registerBusiness(owner: string, name: string): Promise<void> {
  await say(owner, "I want to register a business");
  await say(owner, name);
  await say(owner, "We sell and install solar systems and inverters");
  await tap(owner, "Yes, that's right");
  await say(owner, "Borrowdale");
  await tap(owner, "This number");
  await tap(owner, "I agree");
}

const rowTitles = (to: string) => {
  const m = last(to);
  return m.kind === "list" ? m.sections.flatMap((s) => s.rows).map((r) => r.title) : [];
};

describe("registering on the one number", () => {
  it("tells a new customer how businesses register", async () => {
    await say("263775550000", "hi");
    expect(sideOf("263775550000")).toBe("customer");
    expect(textOf(last("263775550000"))).toContain("Own a business? Type *register my business* to list it free.");
  });

  it("registers a business when someone types that they want to, and the same person can still search", async () => {
    const owner = "263775550001";
    await say(owner, "I want to register a business");
    expect(sideOf(owner)).toBe("business");
    expect(textOf(last(owner))).toContain("What's the name of your business?");
    await say(owner, "Rudo Solar Installers");
    await say(owner, "We sell and install solar systems and inverters");
    await tap(owner, "Yes, that's right");
    await say(owner, "Borrowdale");
    await tap(owner, "This number");
    await tap(owner, "I agree");
    expect(textOf(last(owner))).toContain("You're listed!");
    expect(textOf(last(owner))).toContain("Type *my business* any time");
    const [row] = await app.db.query<{ phone: string }>("SELECT phone FROM businesses WHERE name = 'Rudo Solar Installers'");
    expect(row?.phone).toBe(owner);

    // Looking for something is the customer side, with its own consent.
    await say(owner, "I need a plumber in Mabelreign");
    expect(sideOf(owner)).toBe("customer");
    await tap(owner, "I agree");
    expect(sideOf(owner)).toBe("customer");
    expect(rowTitles(owner)).toEqual(expect.arrayContaining([expect.stringMatching(/^QuickFix/)]));

    // "my business" goes back to the business menu.
    await say(owner, "my business");
    expect(sideOf(owner)).toBe("business");
    expect(rowTitles(owner)).toContain("Find a supplier");
  });

  it("understands the ways people ask to register, and leaves company registration as a search", () => {
    for (const text of ["I want to register a business", "Register my shop", "can I list my business?", "add my business", "sign up", "register"]) {
      expect(isRegisterIntent(text), text).toBe(true);
    }
    for (const text of ["I want to register a company", "business registration", "I need a plumber", "list of hardware shops"]) {
      expect(isRegisterIntent(text), text).toBe(false);
    }
  });

  it("answers a voice note in the middle of a registration from the business side", async () => {
    const owner = "263775550002";
    await say(owner, "register my shop");
    await write(owner, { type: "audio", mediaId: "a1", voice: true });
    expect(sideOf(owner)).toBe("business");
    expect(textOf(last(owner))).toContain("I can only read typed messages");
  });
});

describe("which side a message goes to", () => {
  it("sends a tap back to the side that sent the button", async () => {
    const owner = "263775550003";
    await registerBusiness(owner, "Chiedza Solar");
    await say(owner, "my business");
    await tap(owner, "My customers");
    expect(sideOf(owner)).toBe("business");
    expect(textOf(last(owner))).toContain("No customers have contacted *Chiedza Solar*");

    await say(owner, "I need a plumber in Mabelreign");
    await tap(owner, "I agree");
    await tap(owner, "QuickFix");
    expect(sideOf(owner)).toBe("customer");
    const card = last(owner);
    expect(card.kind === "buttons" ? card.buttons.map((b) => b.title) : []).toContain("Connect me");
  });

  it("keeps 'menu' with the business side for an hour after it last replied", async () => {
    const owner = "263775550004";
    await registerBusiness(owner, "Tatenda Solar");
    await say(owner, "menu");
    expect(sideOf(owner)).toBe("business");
    expect(rowTitles(owner)).toContain("My summary");

    await app.db.query(
      "UPDATE messages SET created_at = created_at - interval '2 hours' WHERE contact_id IN (SELECT id FROM contacts WHERE wa_id = $1)",
      [owner],
    );
    await say(owner, "menu");
    expect(sideOf(owner)).toBe("customer");
  });

  it("lets the owner of a listing a field agent registered find it with 'my business'", async () => {
    const phone = await app.phoneOf("PowerLine Electricians (sample)");
    await say(phone, "my business");
    expect(sideOf(phone)).toBe("business");
    expect(rowTitles(phone)).toContain("My summary");
    const [owned] = await app.db.query<{ owner: string | null }>(
      "SELECT c.wa_id AS owner FROM businesses b JOIN contacts c ON c.id = b.owner_contact_id WHERE b.name = 'PowerLine Electricians (sample)'",
    );
    expect(owned?.owner).toBe(phone);
  });
});

describe("one person, two sides", () => {
  it("counts a message to either side as opening the free reply window, so lead notices stay free", async () => {
    const owner = await app.phoneOf("Avondale Electronics (sample)");
    await say(owner, "my business");
    // Days later, the owner's own business chat has gone quiet...
    await app.db.query("UPDATE contacts SET last_inbound_at = now() - interval '3 days' WHERE wa_id = $1", [owner]);
    // ...but they search as a customer, which opens WhatsApp's window for our whole number.
    await say(owner, "hi");
    const [business] = await app.db.query<{ recent: boolean }>(
      "SELECT last_inbound_at > now() - interval '1 hour' AS recent FROM contacts WHERE wa_id = $1 AND channel = 'business'",
      [owner],
    );
    expect(business?.recent).toBe(true);

    const customer = "263775550005";
    await say(customer, "hi");
    await tap(customer, "I agree");
    await say(customer, "I need a samsung tv in Avondale");
    await tap(customer, "Avondale Electronics");
    await tap(customer, "Connect me");
    const lead = app.sim.since("business", owner, 0).at(-1)!;
    expect(lead.template).toBeUndefined();
    expect(textOf(lead.message)).toContain("New customer");
  });

  it("sends an owner's 'delete my data' to the business side, which deletes both sides", async () => {
    const owner = "263775550006";
    await registerBusiness(owner, "Nyasha Solar");
    await say(owner, "I need a plumber in Mabelreign");
    await tap(owner, "I agree");
    await say(owner, "delete my data");
    expect(sideOf(owner)).toBe("business");
    expect(textOf(last(owner))).toContain("*Nyasha Solar*");
    await tap(owner, "Delete everything");
    await app.engine.idle();
    const contacts = await app.db.query("SELECT id FROM contacts WHERE wa_id = $1", [owner]);
    expect(contacts).toHaveLength(0);
    const listings = await app.db.query("SELECT id FROM businesses WHERE name = 'Nyasha Solar'");
    expect(listings).toHaveLength(0);
  });
});
