import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, registerRoutes } from "../src/http/server.js";
import { testApp, type TestApp } from "./helpers.js";

let app: TestApp;
let server: FastifyInstance;
let agentId: string;
let token: string;

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

const photo = { kind: "shopfront", contentType: "image/jpeg", dataBase64: Buffer.from("not-really-a-jpeg").toString("base64") };

function registration(overrides: Record<string, unknown> = {}) {
  const avondale = app.services.gazetteer.match("Avondale")!;
  return {
    clientRef: `ref-${Math.random().toString(36).slice(2, 12)}`,
    name: "Rudos Salon",
    phone: "0771230001",
    categories: ["salons"],
    description: "Braids, wigs and nails",
    areaId: avondale.id,
    lat: avondale.lat,
    lng: avondale.lng,
    gpsAccuracyM: 8,
    checks: { premisesSeen: true, idChecked: true },
    consent: true,
    photos: [photo],
    ...overrides,
  };
}

const field = (method: "GET" | "POST", url: string, payload?: unknown, bearer = token) =>
  server.inject({ method, url: `/field/api${url}`, headers: { authorization: `Bearer ${bearer}` }, ...(payload ? { payload: payload as object } : {}) });

describe("field agents", () => {
  it("creates an agent whose setup link works in the field app", async () => {
    const res = await server.inject({ method: "POST", url: "/ops/api/agents", payload: { name: "Rudo Moyo", city: "Harare", phone: "0772000111" } });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.setupUrl).toMatch(/\/field\/#token=[\w-]{20,}$/);
    agentId = body.agent.id;
    token = body.setupUrl.split("token=")[1];

    const boot = await field("GET", "/bootstrap");
    expect(boot.statusCode).toBe(200);
    expect(boot.json().agent.name).toBe("Rudo Moyo");
    expect(boot.json().categories.some((c: { slug: string }) => c.slug.startsWith("blocked"))).toBe(false);
    expect(boot.json().areas.length).toBeGreaterThan(50);

    expect((await field("GET", "/bootstrap", undefined, "not-a-real-token-at-all")).statusCode).toBe(401);
  });
});

describe("field registration", () => {
  let businessId: string;

  it("registers a verified business with a photo", async () => {
    const res = await field("POST", "/businesses", registration({ clientRef: "ref-first-0001" }));
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ status: "created", verification: "verified" });
    businessId = res.json().id;
    const [row] = await app.db.query(
      "SELECT registered_by, source, phone, gps_accuracy_m, checks, opted_in_at IS NOT NULL AS opted_in FROM businesses WHERE id = $1",
      [businessId],
    );
    expect(row).toEqual({
      registered_by: agentId,
      source: "field",
      phone: "263771230001",
      gps_accuracy_m: 8,
      checks: { premisesSeen: true, idChecked: true },
      opted_in: true,
    });
    const photos = await app.db.query<{ storage_key: string }>("SELECT storage_key FROM business_photos WHERE business_id = $1", [businessId]);
    expect(photos).toHaveLength(1);
    expect(app.files.files.get(photos[0]!.storage_key)?.toString()).toBe("not-really-a-jpeg");
  });

  it("never registers the same thing twice", async () => {
    const again = await field("POST", "/businesses", registration({ clientRef: "ref-first-0001" }));
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ status: "exists", id: businessId });

    const samePhone = await field("POST", "/businesses", registration({ name: "Another Shop", categories: ["clothing"] }));
    expect(samePhone.statusCode).toBe(409);
    expect(samePhone.json().matches[0]).toMatchObject({ id: businessId, reason: "same_phone" });

    const similarName = await field("POST", "/businesses", registration({ phone: "0771230002" }));
    expect(similarName.statusCode).toBe(409);
    expect(similarName.json().matches[0]).toMatchObject({ reason: "similar_name_nearby" });

    const anyway = await field("POST", "/businesses", registration({ name: "Another Shop", categories: ["clothing"], allowDuplicatePhone: true }));
    expect(anyway.statusCode).toBe(201);
  });

  it("marks a business unverified when a check is missing", async () => {
    const res = await field("POST", "/businesses", registration({ name: "Tino Tailors", phone: "0771230003", categories: ["tailoring"], checks: { premisesSeen: true, idChecked: false } }));
    expect(res.json()).toMatchObject({ status: "created", verification: "registered" });
  });

  it("rejects blocked categories, ID documents, other file types and missing consent", async () => {
    const blocked = await field("POST", "/businesses", registration({ phone: "0771230009", categories: ["blocked_drugs"] }));
    expect(blocked.statusCode).toBe(400);
    const idPhoto = await field("POST", "/businesses", registration({ phone: "0771230009", photos: [{ ...photo, kind: "document" }] }));
    expect(idPhoto.statusCode).toBe(400);
    const pdf = await field("POST", "/businesses", registration({ phone: "0771230009", photos: [{ ...photo, contentType: "application/pdf" }] }));
    expect(pdf.statusCode).toBe(400);
    const noConsent = await field("POST", "/businesses", registration({ phone: "0771230009", consent: false }));
    expect(noConsent.statusCode).toBe(400);
  });

  it("shows the agent their own registrations", async () => {
    const res = await field("GET", "/mine");
    expect(res.statusCode).toBe(200);
    expect(res.json().counts.today).toBe(3);
    expect(res.json().recent.map((b: { name: string }) => b.name)).toContain("Rudos Salon");
  });

  it("serves photos to the ops team", async () => {
    const [p] = await app.db.query<{ id: string }>("SELECT id FROM business_photos WHERE business_id = $1", [businessId]);
    const res = await server.inject({ url: `/ops/api/photos/${p!.id}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/jpeg");
    expect(res.body).toBe("not-really-a-jpeg");
  });

  it("samples call-backs, and a failed one hides the listing and counts against the agent", async () => {
    const queue = await server.inject({ url: "/ops/api/audits/queue?percent=100" });
    expect(queue.json().map((r: { id: string }) => r.id)).toContain(businessId);

    const audit = await server.inject({ method: "POST", url: `/ops/api/businesses/${businessId}/audit`, payload: { outcome: "not_a_business", by: "Chipo" } });
    expect(audit.statusCode).toBe(200);
    const [row] = await app.db.query("SELECT status, audit_status FROM businesses WHERE id = $1", [businessId]);
    expect(row).toEqual({ status: "paused", audit_status: "failed" });

    const agents = await server.inject({ url: "/ops/api/agents" });
    expect(agents.json().find((a: { id: string }) => a.id === agentId)).toMatchObject({ registered_7d: 3, audits_failed: 1 });
    const after = await server.inject({ url: "/ops/api/audits/queue?percent=100" });
    expect(after.json().map((r: { id: string }) => r.id)).not.toContain(businessId);
  });

  it("cuts off a deactivated agent and issues fresh links", async () => {
    await server.inject({ method: "POST", url: `/ops/api/agents/${agentId}/active`, payload: { active: false } });
    expect((await field("GET", "/bootstrap")).statusCode).toBe(401);
    await server.inject({ method: "POST", url: `/ops/api/agents/${agentId}/active`, payload: { active: true } });
    const reset = await server.inject({ method: "POST", url: `/ops/api/agents/${agentId}/token` });
    const fresh = reset.json().setupUrl.split("token=")[1];
    expect((await field("GET", "/bootstrap")).statusCode).toBe(401); // the old link stops working
    expect((await field("GET", "/bootstrap", undefined, fresh)).statusCode).toBe(200);
  });
});

describe("pages", () => {
  it("serves the field app, its service worker and the ops console", async () => {
    const page = await server.inject({ url: "/field/" });
    expect(page.statusCode).toBe(200);
    expect(page.headers["content-type"]).toContain("text/html");
    const sw = await server.inject({ url: "/field/sw.js" });
    expect(sw.headers["service-worker-allowed"]).toBe("/field/");
    const ops = await server.inject({ url: "/ops" });
    expect(ops.body).toContain("Ops console");
  });
});
