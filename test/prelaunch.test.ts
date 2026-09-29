import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { upsertContact } from "../src/conversation/store.js";
import { createServer, registerRoutes } from "../src/http/server.js";
import { OffTransport } from "../src/whatsapp/transport.js";
import { testApp, type TestApp } from "./helpers.js";

// Before launch: WhatsApp isn't connected yet (WHATSAPP_TRANSPORT=off). The website, the admin portal
// and the dashboard run; sign-ups wait for the team to call, and the team hands out dashboard links.
let app: TestApp;
let server: FastifyInstance;

beforeAll(async () => {
  app = await testApp({ WHATSAPP_TRANSPORT: "off" }, { transport: new OffTransport() });
  server = createServer({ logger: false });
  registerRoutes(server, app);
  await server.ready();
});
afterAll(async () => {
  await server.close();
  await app.close();
});

const ops = (method: "GET" | "POST", url: string, payload?: object) =>
  server.inject({ method, url: `/ops/api${url}`, ...(payload ? { payload } : {}) });

describe("pre-launch mode", () => {
  it("runs in production without Meta's settings, but never on the simulator", () => {
    const production = { NODE_ENV: "production", OPS_TOKEN: "a-long-random-token-for-scripts", DATABASE_URL: "postgres://u:p@db:5432/findzim" };
    expect(loadConfig({ ...production, WHATSAPP_TRANSPORT: "off" }).whatsapp.transport).toBe("off");
    expect(() => loadConfig({ ...production, WHATSAPP_TRANSPORT: "simulator" })).toThrow("cloud WhatsApp transport (or off, before launch)");
    expect(() => loadConfig({ ...production, WHATSAPP_TRANSPORT: "cloud" })).toThrow("WHATSAPP_ACCESS_TOKEN is required");
  });

  it("sends nothing on WhatsApp, and doesn't keep trying", async () => {
    const contact = await upsertContact(app.db, { channel: "customer", waId: "263771110000", phone: "263771110000", at: app.clock.now });
    await app.services.messenger.reply(contact, { kind: "text", text: "Hello" });
    const sent = await app.db.query<{ status: string }>("SELECT status FROM messages WHERE contact_id = $1 AND direction = 'out'", [contact.id]);
    expect(sent.map((m) => m.status)).toEqual(["failed"]);
    expect(await app.db.query("SELECT 1 FROM jobs WHERE kind = 'resend'")).toHaveLength(0);
    // Nobody can reach us on WhatsApp yet, and there's no simulator.
    expect((await server.inject({ url: "/webhook/whatsapp?hub.mode=subscribe" })).statusCode).toBe(503);
    expect((await server.inject({ method: "POST", url: "/webhook/whatsapp", payload: {} })).statusCode).toBe(503);
    expect((await server.inject({ url: "/simulator" })).statusCode).toBe(404);
  });

  it("hides what needs WhatsApp on the website", async () => {
    for (const url of ["/", "/register"]) {
      const page = await server.inject({ url });
      expect(page.statusCode).toBe(200);
      expect(page.body).toContain('<html lang="en" data-whatsapp="off">');
    }
    expect((await server.inject({ url: "/" })).body).toContain("We open on WhatsApp soon");
    const options = (await server.inject({ url: "/app/api/public/options" })).json();
    expect(options).toMatchObject({ brand: "TestDir", whatsapp: false, whatsappNumber: null });
    // Sign-in links can't come on WhatsApp yet.
    expect((await server.inject({ method: "POST", url: "/app/api/auth/request", payload: { phone: "0772111222" } })).json()).toEqual({
      ok: true,
      preLaunch: true,
    });
  });

  it("keeps a website sign-up for the team, who list it and hand the owner a dashboard link", async () => {
    const avondale = app.services.gazetteer.match("Avondale")!;
    const registered = await server.inject({
      method: "POST",
      url: "/app/api/public/register",
      payload: { name: "Tanaka Hardware", categories: ["hardware"], description: "Tools and paint", areaId: avondale.id, phone: "0772 111 222", consent: true },
    });
    expect(registered.statusCode).toBe(200);
    const { code, preLaunch, expiresAt, whatsappLink } = registered.json();
    expect(preLaunch).toBe(true);
    expect(whatsappLink).toBeUndefined();
    // It waits for the team's call for weeks, not the 48 hours a code has on WhatsApp.
    expect(new Date(expiresAt).getTime() - app.clock.now.getTime()).toBeGreaterThan(30 * 24 * 3600_000);

    const waiting = (await ops("GET", "/web-registrations?status=pending")).json() as { id: string; code: string; name: string; phone: string }[];
    const signup = waiting.find((r) => r.code === code)!;
    expect(signup).toMatchObject({ name: "Tanaka Hardware", phone: "263772111222" });

    const listed = await ops("POST", `/web-registrations/${signup.id}/list`);
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({ name: "Tanaka Hardware", created: true });
    expect((await ops("POST", `/web-registrations/${signup.id}/list`)).statusCode).toBe(409);
    const business = (await ops("GET", `/businesses/${listed.json().businessId}`)).json();
    expect(business).toMatchObject({ name: "Tanaka Hardware", phone: "263772111222", status: "active" });

    // The team hands the owner a link: it signs them in as the owner of that business, once.
    const link = (await ops("POST", `/businesses/${listed.json().businessId}/owner/link`)).json();
    expect(new Date(link.expiresAt).getTime() - app.clock.now.getTime()).toBe(24 * 3600_000);
    const token = new URL(link.url).searchParams.get("signin")!;
    const exchanged = await server.inject({ method: "POST", url: "/app/api/auth/exchange", payload: { token } });
    expect(exchanged.statusCode).toBe(200);
    const cookie = `dz_owner=${/dz_owner=([^;]+)/.exec([exchanged.headers["set-cookie"]].flat().join("; "))![1]}`;
    const me = (await server.inject({ url: "/app/api/me", headers: { cookie } })).json();
    expect(me.businesses.map((b: { name: string }) => b.name)).toEqual(["Tanaka Hardware"]);
    const again = await server.inject({ method: "POST", url: "/app/api/auth/exchange", payload: { token } });
    expect(again.statusCode).toBe(401);
    expect(again.json().error).toContain("Ask our team for a new one");

    // A second link for the same business keeps the same owner.
    const second = (await ops("POST", `/businesses/${listed.json().businessId}/owner/link`)).json();
    const token2 = new URL(second.url).searchParams.get("signin")!;
    expect((await server.inject({ method: "POST", url: "/app/api/auth/exchange", payload: { token: token2 } })).statusCode).toBe(200);
    const owners = await app.db.query("SELECT 1 FROM contacts WHERE channel = 'business' AND wa_id = '263772111222'");
    expect(owners).toHaveLength(1);
  });
});
