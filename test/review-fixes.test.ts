import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { jobHandlers } from "../src/conversation/followups.js";
import { createServer, registerRoutes } from "../src/http/server.js";
import { applyRetention } from "../src/privacy.js";
import { isRetryable, OffTransport, WhatsAppApiError, WhatsAppOffError } from "../src/whatsapp/transport.js";
import type { InboundContent } from "../src/whatsapp/types.js";
import { testApp, textOf, type TestApp } from "./helpers.js";

// Fixes from the September 2026 review (docs/REVIEW.md): conversations that no longer get stuck,
// follow-ups that respect "stop", pauses only our team can lift, claims with a registration
// code, the legal pages, retention and the job queue.

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
const newCustomer = () => `26377222${String(++n).padStart(4, "0")}`;

function as(customer: string) {
  return {
    say: (text: string) => app.say(text, customer),
    tap: (title: string) => app.tap(title, "customer", customer),
    send: (content: InboundContent) => app.send("customer", customer, content),
    last: () => app.last("customer", customer),
    lastText: () => textOf(app.last("customer", customer)),
    outbox: () => app.outbox("customer", customer),
    consented: async () => {
      await app.say("hi", customer);
      await app.tap("I agree", "customer", customer);
    },
  };
}

function firstRow(m: ReturnType<TestApp["last"]>): string {
  if (m.kind !== "list") throw new Error(`Expected a list, got ${m.kind}: ${textOf(m)}`);
  return m.sections[0]!.rows[0]!.title;
}

async function contactId(waId: string): Promise<string> {
  const [row] = await app.db.query<{ id: string }>("SELECT id FROM contacts WHERE channel = 'customer' AND wa_id = $1", [waId]);
  return row!.id;
}

/** Find a plumber, open QuickFix's card and connect. */
async function connectToQuickFix(c: ReturnType<typeof as>): Promise<void> {
  await c.say("I need a plumber in Mabelreign");
  expect(firstRow(c.last())).toMatch(/^QuickFix/);
  await c.tap("QuickFix");
  await c.tap("Connect me");
  expect(c.last().kind).toBe("cta_url");
}

describe("consent", () => {
  it("takes agreeing in words, then answers the first message, and links the privacy notice", async () => {
    const c = as(newCustomer());
    await c.say("I need a plumber in Mabelreign");
    expect(c.lastText()).toContain("Privacy notice: http://localhost:3000/privacy");
    await c.say("yes");
    expect(firstRow(c.last())).toMatch(/^QuickFix/);
  });

  it("doesn't treat a first 'ok' as a request", async () => {
    const c = as(newCustomer());
    await c.say("ok");
    expect(c.last().kind).toBe("buttons");
    await c.say("ok");
    expect(c.lastText()).toContain("What are you looking for");
  });
});

describe("where to look", () => {
  it("keeps the request when the place isn't one we know", async () => {
    const c = as(newCustomer());
    await c.consented();
    await c.say("I need a fridge");
    expect(c.last().kind).toBe("location_request");
    await c.say("Zvimbambo Heights");
    expect(c.lastText()).toContain("I don't know that place yet");
    await c.say("Borrowdale");
    expect(c.last().kind).toBe("list");
    const [request] = await app.db.query<{ raw_text: string }>(
      "SELECT raw_text FROM requests WHERE contact_id = $1 ORDER BY created_at DESC LIMIT 1",
      [await contactId(c.outbox()[0]!.to)],
    );
    expect(request!.raw_text).toBe("I need a fridge");
  });

  it("treats a new request as a new request, not as the place", async () => {
    const c = as(newCustomer());
    await c.consented();
    await c.say("I need a fridge");
    expect(c.last().kind).toBe("location_request");
    await c.say("plumber in Mabelreign");
    expect(firstRow(c.last())).toMatch(/^QuickFix/);
  });

  it("searches everywhere when told 'anywhere'", async () => {
    const c = as(newCustomer());
    await c.consented();
    await c.say("I need a fridge");
    await c.say("anywhere");
    expect(c.last().kind).toBe("list");
  });

  it("uses a shared place for the rest of the day, not for ever", async () => {
    const customer = newCustomer();
    const c = as(customer);
    await c.consented();
    const borrowdale = app.services.gazetteer.match("Borrowdale")!;
    await c.send({ type: "location", lat: borrowdale.lat, lng: borrowdale.lng });
    await c.say("I need a fridge");
    expect(c.last().kind).toBe("list");
    app.advanceHours(13);
    await c.say("I need a fridge");
    expect(c.last().kind).toBe("location_request");
  });
});

describe("questions that lapse", () => {
  it("doesn't file a search typed hours later as a report", async () => {
    const customer = newCustomer();
    const c = as(customer);
    await c.consented();
    await c.say("I need a plumber in Mabelreign");
    await c.tap("QuickFix");
    await c.tap("Report");
    expect(c.lastText()).toContain("What went wrong?");
    app.advanceHours(2);
    await c.say("I need a plumber in Mabelreign");
    expect(firstRow(c.last())).toMatch(/^QuickFix/);
    expect(await app.db.query("SELECT 1 FROM reports WHERE contact_id = $1", [await contactId(customer)])).toHaveLength(0);
  });

  it("takes 'no' for the phone number as not knowing it", async () => {
    const c = as(newCustomer());
    await c.consented();
    await c.say("recommend");
    await c.say("Baba Tino");
    await c.say("He fixes fridges and stoves");
    await c.say("Glen View");
    await c.say("no");
    expect(c.lastText()).toContain("Our team will contact *Baba Tino*");
    const [tip] = await app.db.query<{ phone: string | null }>("SELECT phone FROM recommendations WHERE name = 'Baba Tino'");
    expect(tip).toEqual({ phone: null });
  });
});

describe("a person handling the chat", () => {
  it("stays quiet, but 'stop' still works", async () => {
    const c = as(newCustomer());
    await c.consented();
    await c.say("agent");
    const sent = c.outbox().length;
    await c.say("hello?");
    expect(c.outbox()).toHaveLength(sent);
    await c.say("stop");
    expect(c.lastText()).toContain("I won't message you");
  });
});

describe("messages that aren't text", () => {
  it("ignores reactions and asks for typing instead of stickers", async () => {
    const c = as(newCustomer());
    await c.consented();
    const sent = c.outbox().length;
    await c.send({ type: "unsupported", rawType: "reaction" });
    expect(c.outbox()).toHaveLength(sent);
    await c.send({ type: "unsupported", rawType: "sticker" });
    expect(c.lastText()).toContain("I can only read typed messages");
  });
});

describe("connecting and following up", () => {
  it("gives the same link when 'Connect me' is tapped twice, with one follow-up", async () => {
    const customer = newCustomer();
    const c = as(customer);
    await c.consented();
    await connectToQuickFix(c);
    await c.tap("Connect me");
    const id = await contactId(customer);
    expect(await app.db.query("SELECT 1 FROM introductions WHERE contact_id = $1", [id])).toHaveLength(1);
    const [intro] = await app.db.query<{ id: string }>("SELECT id FROM introductions WHERE contact_id = $1", [id]);
    expect(await app.db.query("SELECT 1 FROM jobs WHERE kind = 'follow_up' AND payload->>'introductionId' = $1", [intro!.id])).toHaveLength(1);
  });

  it("moves the score once however often 'Yes, sorted' is tapped", async () => {
    const c = as(newCustomer());
    await c.consented();
    await connectToQuickFix(c);
    app.advanceHours(21);
    await app.runJobs();
    const score = async () =>
      Number((await app.db.query<{ s: number }>("SELECT response_score AS s FROM businesses WHERE name = 'QuickFix Plumbing (sample)'"))[0]!.s);
    await c.tap("Yes, sorted");
    const once = await score();
    await c.tap("Yes, sorted");
    expect(await score()).toBe(once);
  });

  it("takes a typed 'yes' as the answer to the follow-up", async () => {
    const customer = newCustomer();
    const c = as(customer);
    await c.consented();
    await connectToQuickFix(c);
    app.advanceHours(21);
    await app.runJobs();
    expect(c.lastText()).toContain("QuickFix");
    await c.say("yes");
    expect(c.lastText()).toContain("How was *QuickFix Plumbing (sample)*?");
    const [intro] = await app.db.query<{ outcome: string }>("SELECT outcome FROM introductions WHERE contact_id = $1", [await contactId(customer)]);
    expect(intro!.outcome).toBe("sorted");
  });

  it("sends no follow-up after 'stop'", async () => {
    const customer = newCustomer();
    const c = as(customer);
    await c.consented();
    await connectToQuickFix(c);
    await c.say("stop");
    app.advanceHours(21);
    await app.runJobs();
    expect(c.lastText()).toContain("I won't message you");
    const [intro] = await app.db.query<{ followed_up_at: Date | null }>("SELECT followed_up_at FROM introductions WHERE contact_id = $1", [
      await contactId(customer),
    ]);
    expect(intro!.followed_up_at).toBeNull();
  });

  it("shows the street address and opening hours on a business's card", async () => {
    await app.db.query("UPDATE businesses SET address = '14 Harare Drive', hours = 'Mon to Sat, 8 to 5' WHERE name = 'QuickFix Plumbing (sample)'");
    const c = as(newCustomer());
    await c.consented();
    await c.say("I need a plumber in Mabelreign");
    await c.tap("QuickFix");
    expect(c.lastText()).toContain("📍 14 Harare Drive");
    expect(c.lastText()).toContain("🕒 Mon to Sat, 8 to 5");
  });
});

// ---------- Businesses ----------

let seq = 0;
async function write(from: string, content: InboundContent): Promise<void> {
  await app.engine.enqueue({ channel: "customer", route: true, waMessageId: `review-${++seq}`, from, phone: from, profileName: "Rudo", timestamp: app.clock.now, content });
}
const bizSay = (from: string, text: string) => write(from, { type: "text", text });
const lastTo = (to: string) => textOf(app.sim.sinceAny(to, 0).at(-1)!.message);
const ops = (method: "GET" | "POST", url: string, payload?: object) => server.inject({ method, url: `/ops/api${url}`, ...(payload ? { payload } : {}) });

async function signIn(owner: string): Promise<string> {
  await bizSay(owner, "dashboard");
  const token = decodeURIComponent(/\/app\/#signin=([\w%-]+)/.exec(lastTo(owner))![1]!);
  const res = await server.inject({ method: "POST", url: "/app/api/auth/exchange", payload: { token } });
  expect(res.statusCode).toBe(200);
  return `dz_owner=${/dz_owner=([^;]+)/.exec([res.headers["set-cookie"]].flat().join("; "))![1]}`;
}

async function registerOnWebsite(name: string, phone: string): Promise<{ code: string; id: string }> {
  const avondale = app.services.gazetteer.match("Avondale")!;
  const res = await server.inject({
    method: "POST",
    url: "/app/api/public/register",
    payload: { name, categories: ["hardware"], description: "Tools and paint", areaId: avondale.id, phone, consent: true },
  });
  expect(res.statusCode).toBe(200);
  const { code } = res.json() as { code: string };
  const waiting = (await ops("GET", "/web-registrations?status=pending")).json() as { id: string; code: string }[];
  return { code, id: waiting.find((r) => r.code === code)!.id };
}

describe("a listing our team listed", () => {
  it("is claimed by whoever sends its code first, and the team hears about it", async () => {
    const { code, id } = await registerOnWebsite("Chipo Paints", "0772 333 444");
    const listed = await ops("POST", `/web-registrations/${id}/list`);
    expect(listed.statusCode).toBe(200);
    const businessId = listed.json().businessId as string;

    // The owner writes from a different number than the shop's.
    const owner = "263779100001";
    await bizSay(owner, code);
    expect(lastTo(owner)).toContain("You now manage *Chipo Paints*");
    const [b] = await app.db.query<{ wa_id: string }>("SELECT c.wa_id FROM businesses b JOIN contacts c ON c.id = b.owner_contact_id WHERE b.id = $1", [businessId]);
    expect(b!.wa_id).toBe(owner);
    expect(await app.db.query("SELECT 1 FROM ops_audit WHERE action = 'business.claimed' AND target = $1", [businessId])).toHaveLength(1);

    // Nobody else can take it over with the same code.
    await bizSay("263779100002", code);
    expect(lastTo("263779100002")).toContain("That code has already been used");
  });

  it("stops accepting codes from a number after five wrong ones in a day", async () => {
    const guesser = "263779100003";
    for (let i = 0; i < 5; i++) {
      await bizSay(guesser, `REG-00000${i}`);
      expect(lastTo(guesser)).toContain("We couldn't find that registration code");
    }
    await bizSay(guesser, "REG-000009");
    expect(lastTo(guesser)).toContain("didn't match today");
    app.advanceHours(25);
    await bizSay(guesser, "REG-000009");
    expect(lastTo(guesser)).toContain("We couldn't find that registration code");
  });
});

describe("a pause by our team", () => {
  it("can't be lifted by the owner, on WhatsApp or the dashboard", async () => {
    const { code } = await registerOnWebsite("Tatenda Tiles", "0772 555 666");
    const owner = "263772555666";
    await bizSay(owner, code);
    expect(lastTo(owner)).toContain("Tatenda Tiles");
    const [b] = await app.db.query<{ id: string }>("SELECT id FROM businesses WHERE name = 'Tatenda Tiles'");
    const cookie = await signIn(owner);

    // The owner's own pause is theirs to lift.
    const own = await server.inject({ method: "POST", url: `/app/api/businesses/${b!.id}/status`, headers: { cookie }, payload: { live: false } });
    expect(own.json()).toMatchObject({ status: "paused" });
    const back = await server.inject({ method: "POST", url: `/app/api/businesses/${b!.id}/status`, headers: { cookie }, payload: { live: true } });
    expect(back.json()).toMatchObject({ status: "active" });

    // Paused after customer reports: only our team switches it back on.
    await app.db.query("UPDATE businesses SET status = 'paused', paused_by = 'system' WHERE id = $1", [b!.id]);
    const refused = await server.inject({ method: "POST", url: `/app/api/businesses/${b!.id}/status`, headers: { cookie }, payload: { live: true } });
    expect(refused.statusCode).toBe(409);
    await bizSay(owner, "resume");
    expect(lastTo(owner)).toContain("only our team can switch it back on");
    const me = (await server.inject({ url: "/app/api/me", headers: { cookie } })).json();
    expect(me.businesses[0]).toMatchObject({ status: "paused", paused_by: "system" });
  });

  it("keeps what an upload leaves empty, and finds a product listed without a code by its name", async () => {
    const { code } = await registerOnWebsite("Rufaro Hardware", "0772 777 888");
    const owner = "263772777888";
    await bizSay(owner, code);
    const [b] = await app.db.query<{ id: string }>("SELECT id FROM businesses WHERE name = 'Rufaro Hardware'");
    const cookie = await signIn(owner);
    const call = (payload: object) =>
      server.inject({ method: "POST", url: `/app/api/businesses/${b!.id}/products/import`, headers: { cookie }, payload });
    expect((await call({ rows: [{ name: "Claw hammer", price: "12.50", inStock: "no" }], updateExisting: true })).json()).toMatchObject({ added: 1 });
    // A later list with the price and stock cells empty, and a code the product didn't have.
    expect((await call({ rows: [{ name: "Claw hammer", sku: "CH-1", price: "", inStock: "" }], updateExisting: true })).json()).toMatchObject({
      added: 0,
      updated: 1,
    });
    const [p] = await app.db.query<{ price_usd: string; in_stock: boolean; sku: string }>("SELECT price_usd, in_stock, sku FROM offerings WHERE business_id = $1", [b!.id]);
    expect(p).toEqual({ price_usd: "12.50", in_stock: false, sku: "CH-1" });
    // "ask" still takes a price off.
    await call({ rows: [{ name: "Claw hammer", sku: "CH-1", price: "ask" }], updateExisting: true });
    const [q] = await app.db.query<{ price_usd: string | null }>("SELECT price_usd FROM offerings WHERE business_id = $1", [b!.id]);
    expect(q!.price_usd).toBeNull();
  });
});

describe("the website", () => {
  it("publishes the privacy notice and business terms, with the retention periods in use", async () => {
    const privacy = await server.inject({ url: "/privacy" });
    expect(privacy.statusCode).toBe(200);
    expect(privacy.body).toContain("Messages: 180 days.");
    expect(privacy.body).toContain("delete my data");
    const terms = await server.inject({ url: "/terms" });
    expect(terms.statusCode).toBe(200);
    expect(terms.body).toContain("Business terms");
    for (const body of [privacy.body, terms.body]) expect(body.toLowerCase()).not.toMatch(/\bfree\b|\bpaid\b/);
    const home = await server.inject({ url: "/" });
    expect(home.body).toContain('href="http://localhost:3000/privacy"');
  });

  it("sends headers that stop framing and content sniffing, and treats a broken cookie as no session", async () => {
    const home = await server.inject({ url: "/" });
    expect(home.headers["x-frame-options"]).toBe("DENY");
    expect(home.headers["x-content-type-options"]).toBe("nosniff");
    const broken = await server.inject({ url: "/app/api/me", headers: { cookie: "dz_owner=%E0%A4%A" } });
    expect(broken.statusCode).toBe(401);
  });
});

describe("keeping data only as long as we said", () => {
  it("drops old requests' search words and locations, and idle people's numbers", async () => {
    const customer = newCustomer();
    const c = as(customer);
    await c.consented();
    const borrowdale = app.services.gazetteer.match("Borrowdale")!;
    await c.send({ type: "location", lat: borrowdale.lat, lng: borrowdale.lng });
    await c.say("I need a fridge");
    const id = await contactId(customer);
    await app.db.query("UPDATE requests SET created_at = created_at - interval '400 days' WHERE contact_id = $1", [id]);
    await app.db.query("UPDATE contacts SET last_inbound_at = last_inbound_at - interval '400 days' WHERE id = $1", [id]);
    const result = await applyRetention(app.db, app.clock.now, { messageDays: 180, requestDays: 365 });
    expect(result.idleContacts).toBeGreaterThanOrEqual(1);
    const [request] = await app.db.query<{ raw_text: string; query: string; lat: number | null; area_id: number | null }>(
      "SELECT raw_text, query, lat, area_id FROM requests WHERE contact_id = $1",
      [id],
    );
    expect(request).toMatchObject({ raw_text: "", query: "", lat: null });
    expect(request!.area_id).not.toBeNull(); // the area stays, for statistics
    const [person] = await app.db.query<{ wa_id: string; phone: string | null }>("SELECT wa_id, phone FROM contacts WHERE id = $1", [id]);
    expect(person).toEqual({ wa_id: `gone-${id}`, phone: null });
  });
});

describe("background jobs", () => {
  it("puts back a job left running by a crash, judged by when it started", async () => {
    const now = app.clock.now.getTime();
    const [stuck] = await app.db.query<{ id: string }>(
      "INSERT INTO jobs (kind, run_at, status, started_at) VALUES ('noop', $1, 'running', $2) RETURNING id",
      [new Date(now - 3600_000), new Date(now - 20 * 60_000)],
    );
    const [busy] = await app.db.query<{ id: string }>(
      "INSERT INTO jobs (kind, run_at, status, started_at) VALUES ('noop', $1, 'running', $2) RETURNING id",
      [new Date(now - 3600_000), new Date(now - 60_000)],
    );
    await app.services.jobs.recoverStuck();
    const status = async (id: string) => (await app.db.query<{ status: string }>("SELECT status FROM jobs WHERE id = $1", [id]))[0]!.status;
    expect(await status(stuck!.id)).toBe("queued");
    expect(await status(busy!.id)).toBe("running");
    await app.db.query("DELETE FROM jobs WHERE kind = 'noop'");
  });

  it("books a recurring job's next run once, however often it runs", async () => {
    const handlers = jobHandlers(app.services);
    await handlers.report_reminders!({}, { id: "x", kind: "report_reminders", payload: {}, attempts: 1 } as never);
    await handlers.report_reminders!({}, { id: "y", kind: "report_reminders", payload: {}, attempts: 1 } as never);
    expect(await app.db.query("SELECT 1 FROM jobs WHERE kind = 'report_reminders' AND status = 'queued'")).toHaveLength(1);
  });

  it("waits out Meta's rate limits, but not errors that won't improve", () => {
    expect(isRetryable(new WhatsAppApiError(400, { error: { code: 131056 } }))).toBe(true);
    expect(isRetryable(new WhatsAppApiError(400, { error: { code: 130429 } }))).toBe(true);
    expect(isRetryable(new WhatsAppApiError(400, { error: { code: 131047 } }))).toBe(false);
    expect(isRetryable(new WhatsAppOffError())).toBe(false);
  });
});

describe("the webhook before launch", () => {
  it("answers Meta's verification, and takes signed calls without answering anyone", async () => {
    const off = await testApp(
      { WHATSAPP_TRANSPORT: "off", WHATSAPP_VERIFY_TOKEN: "verify-me", WHATSAPP_APP_SECRET: "app-secret" },
      { transport: new OffTransport() },
    );
    const s = createServer({ logger: false });
    registerRoutes(s, off);
    await s.ready();
    try {
      const verified = await s.inject({ url: "/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=4242" });
      expect(verified.statusCode).toBe(200);
      expect(verified.body).toBe("4242");
      expect((await s.inject({ url: "/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=wrong" })).statusCode).toBe(503);

      const body = JSON.stringify({
        entry: [{ changes: [{ value: { messages: [{ from: "263771234567", id: "wamid.1", type: "text", text: { body: "hi" } }] } }] }],
      });
      const signature = `sha256=${crypto.createHmac("sha256", "app-secret").update(body).digest("hex")}`;
      const res = await s.inject({ method: "POST", url: "/webhook/whatsapp", payload: body, headers: { "content-type": "application/json", "x-hub-signature-256": signature } });
      expect(res.statusCode).toBe(200);
      expect(await off.db.query("SELECT 1 FROM messages")).toHaveLength(0);
      const unsigned = await s.inject({ method: "POST", url: "/webhook/whatsapp", payload: body, headers: { "content-type": "application/json" } });
      expect(unsigned.statusCode).toBe(401);
    } finally {
      await s.close();
      await off.close();
    }
  });
});
