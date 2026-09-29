import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, registerRoutes } from "../src/http/server.js";
import { testApp, textOf, type TestApp } from "./helpers.js";

let app: TestApp;
let server: FastifyInstance;
const SECRET = "app-secret";

beforeAll(async () => {
  app = await testApp({
    WHATSAPP_APP_SECRET: SECRET,
    WHATSAPP_VERIFY_TOKEN: "verify-me",
    WHATSAPP_PHONE_NUMBER_ID: "PN_OURS",
  });
  server = createServer({ logger: false });
  registerRoutes(server, app);
  await server.ready();
});
afterAll(async () => {
  await server.close();
  await app.close();
});

function signed(body: unknown) {
  const raw = JSON.stringify(body);
  return {
    payload: raw,
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": "sha256=" + crypto.createHmac("sha256", SECRET).update(raw).digest("hex"),
    },
  };
}

const textMessage = (from: string, id: string, text: string) => ({
  object: "whatsapp_business_account",
  entry: [
    {
      id: "WABA",
      changes: [
        {
          field: "messages",
          value: {
            metadata: { phone_number_id: "PN_OURS" },
            contacts: [{ profile: { name: "Rudo" }, wa_id: from }],
            messages: [{ from, id, timestamp: "1767225600", type: "text", text: { body: text } }],
          },
        },
      ],
    },
  ],
});

describe("webhook", () => {
  it("answers Meta's verification challenge only with the right token", async () => {
    const ok = await server.inject({ url: "/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=42" });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe("42");
    const bad = await server.inject({ url: "/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=42" });
    expect(bad.statusCode).toBe(403);
  });

  it("accepts signed messages and rejects unsigned ones", async () => {
    const res = await server.inject({ method: "POST", url: "/webhook/whatsapp", ...signed(textMessage("263772222222", "wamid.http1", "hi")) });
    expect(res.statusCode).toBe(200);
    await app.engine.idle();
    expect(textOf(app.last("customer", "263772222222"))).toContain("Hi Rudo!");

    // The same number takes business registrations.
    await server.inject({ method: "POST", url: "/webhook/whatsapp", ...signed(textMessage("263772222224", "wamid.http3", "I want to register a business")) });
    await app.engine.idle();
    expect(textOf(app.last("business", "263772222224"))).toContain("What's the name of your business?");

    const forged = await server.inject({
      method: "POST",
      url: "/webhook/whatsapp",
      payload: JSON.stringify(textMessage("263772222223", "wamid.http2", "hi")),
      headers: { "content-type": "application/json", "x-hub-signature-256": "sha256=" + "0".repeat(64) },
    });
    expect(forged.statusCode).toBe(401);
  });
});

describe("ops API", () => {
  it("registers a business from the field and reports supply gaps", async () => {
    const created = await server.inject({
      method: "POST",
      url: "/ops/api/businesses",
      payload: {
        name: "Rudo's Tailoring",
        phone: "0773 456 789",
        categories: ["tailoring"],
        area: "Avondale",
        description: "Alterations and school uniforms",
        consent: true,
        verified: true,
        agent: "agent-rudo",
      },
    });
    expect(created.statusCode).toBe(201);
    const [row] = await app.db.query("SELECT phone, verification, source FROM businesses WHERE name = $1", ["Rudo's Tailoring"]);
    expect(row).toEqual({ phone: "263773456789", verification: "verified", source: "field" });

    const refused = await server.inject({
      method: "POST",
      url: "/ops/api/businesses",
      payload: { name: "X", phone: "0773456789", categories: ["blocked_drugs"], area: "Avondale", consent: true, agent: "a" },
    });
    expect(refused.statusCode).toBe(400);

    const gaps = await server.inject({ url: "/ops/api/supply-gaps" });
    expect(gaps.statusCode).toBe(200);
    expect(Array.isArray(gaps.json())).toBe(true);
  });
});

describe("simulator API", () => {
  it("sends a message and returns the replies", async () => {
    const sent = await server.inject({
      method: "POST",
      url: "/simulator/api/send",
      payload: { channel: "customer", from: "263774444444", name: "Chipo", content: { type: "text", text: "hello" } },
    });
    expect(sent.statusCode).toBe(200);
    const replies = (await server.inject({ url: "/simulator/api/messages?channel=customer&to=263774444444&after=0" })).json();
    expect(replies.items).toHaveLength(1);
    // A page that last polled before a restart gets everything again.
    const stale = await server.inject({ url: `/simulator/api/messages?channel=customer&to=263774444444&after=99&run=old` });
    expect(stale.json()).toMatchObject({ run: replies.run, items: [{ seq: replies.items[0].seq }] });
    // Otherwise only newer messages come back.
    const same = await server.inject({ url: `/simulator/api/messages?channel=customer&to=263774444444&after=99&run=${replies.run}` });
    expect(same.json().items).toHaveLength(0);
    const page = await server.inject({ url: "/simulator" });
    expect(page.headers["content-type"]).toContain("text/html");
    expect(page.body).toContain("TestDir");
    // The page's script is written inside a template string: a slip there breaks the whole page.
    const scripts = [...page.body.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
    expect(scripts.length).toBeGreaterThan(0);
    for (const script of scripts) expect(() => new Function(script)).not.toThrow();
  });

  it("passes on which product card a message was written from", async () => {
    const sent = await server.inject({
      method: "POST",
      url: "/simulator/api/send",
      payload: {
        channel: "customer",
        from: "263774444446",
        content: { type: "text", text: "Is this available?" },
        referredProduct: { catalogId: "sim-catalog", retailerId: "00000000-0000-0000-0000-000000000000" },
      },
    });
    expect(sent.statusCode).toBe(200);
    const bad = await server.inject({
      method: "POST",
      url: "/simulator/api/send",
      payload: { channel: "customer", from: "263774444446", content: { type: "text", text: "hi" }, referredProduct: { catalogId: "sim-catalog" } },
    });
    expect(bad.statusCode).toBe(400);
  });

  it("asks for a typed message when a voice note arrives, and takes no uploads", async () => {
    const customer = "263774444445";
    await server.inject({
      method: "POST",
      url: "/simulator/api/send",
      payload: { channel: "customer", from: customer, content: { type: "text", text: "hi" } },
    });
    await server.inject({
      method: "POST",
      url: "/simulator/api/send",
      payload: { channel: "customer", from: customer, content: { type: "button_reply", id: "consent:yes", title: "I agree" } },
    });
    const sent = await server.inject({
      method: "POST",
      url: "/simulator/api/send",
      payload: { channel: "customer", from: customer, content: { type: "audio", mediaId: "voice-1", voice: true, mimeType: "audio/ogg" } },
    });
    expect(sent.statusCode).toBe(200);
    const replies = (await server.inject({ url: `/simulator/api/messages?channel=customer&to=${customer}&after=0` })).json();
    expect(JSON.stringify(replies.items.at(-1))).toContain("I can only read typed messages for now");
    const upload = await server.inject({ method: "POST", url: "/simulator/api/media", payload: { mimeType: "audio/ogg", dataBase64: "b2dn" } });
    expect(upload.statusCode).toBe(404);
  });
});
