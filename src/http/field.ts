import type { FastifyInstance } from "fastify";
import type { App } from "../app.js";
import { agentByToken, type Agent } from "../field/agents.js";
import { findDuplicates, FieldRegistrationSchema, registerFromField } from "../field/registration.js";
import { normalizeZimPhone } from "../text.js";
import { harareStartOfDay } from "../time.js";
import { serveFile } from "./static.js";

declare module "fastify" {
  interface FastifyRequest {
    agent?: Agent;
  }
}

/** The field app (an offline-capable web app for agents) and its API. */
export function registerField(server: FastifyInstance, app: App): void {
  server.get("/field", async (_req, reply) => reply.redirect("/field/"));
  serveFile(server, "/field/", "field/index.html");
  serveFile(server, "/field/app.js", "field/app.js");
  serveFile(server, "/field/app.css", "field/app.css");
  serveFile(server, "/field/manifest.webmanifest", "field/manifest.webmanifest");
  serveFile(server, "/field/icon.svg", "field/icon.svg");
  serveFile(server, "/field/sw.js", "field/sw.js", { "Service-Worker-Allowed": "/field/" });

  server.register(
    async (api) => {
      api.addHook("onRequest", async (req, reply) => {
        const auth = req.headers.authorization ?? "";
        const agent = await agentByToken(app.db, auth.startsWith("Bearer ") ? auth.slice(7) : "");
        if (!agent) {
          return reply.code(401).send({ error: "This phone isn't set up. Ask your team lead for a new setup link." });
        }
        req.agent = agent;
      });

      api.get("/bootstrap", async (req) => ({
        agent: { name: req.agent!.name, city: req.agent!.city },
        brand: app.config.brandName,
        categories: app.services.taxonomy.searchable().map((c) => ({ slug: c.slug, name: c.name, group: c.group })),
        areas: app.services.gazetteer.areas.map((a) => ({ id: a.id, name: a.name, city: a.city, lat: a.lat, lng: a.lng })),
      }));

      api.get("/duplicates", async (req) => {
        const q = req.query as { phone?: string; name?: string; lat?: string; lng?: string };
        const lat = q.lat ? Number(q.lat) : undefined;
        const lng = q.lng ? Number(q.lng) : undefined;
        return findDuplicates(app.db, app.services.gazetteer, {
          phone: q.phone ? normalizeZimPhone(q.phone) : null,
          name: q.name,
          lat: Number.isFinite(lat) ? lat : undefined,
          lng: Number.isFinite(lng) ? lng : undefined,
        });
      });

      api.post("/businesses", { bodyLimit: 8 * 1024 * 1024 }, async (req, reply) => {
        const parsed = FieldRegistrationSchema.safeParse(req.body);
        if (!parsed.success) {
          return reply.code(400).send({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
        }
        const result = await registerFromField(
          { db: app.db, taxonomy: app.services.taxonomy, gazetteer: app.services.gazetteer, store: app.store },
          req.agent!,
          parsed.data,
        );
        if (result.status === "created" && app.services.vision) {
          // Read price-list photos into the listing in the background, so the upload returns quickly.
          const photos = await app.db.query<{ id: string }>(
            "SELECT id FROM business_photos WHERE business_id = $1 AND kind = 'price_list'",
            [result.id],
          );
          for (const p of photos) await app.services.jobs.enqueue("read_price_list", { photoId: p.id }, app.services.now());
        }
        const code = { created: 201, exists: 200, duplicate: 409, invalid: 400 }[result.status];
        return reply.code(code).send(result);
      });

      api.get("/mine", async (req) => {
        const agent = req.agent!;
        const startOfDay = harareStartOfDay(app.services.now());
        const [counts] = await app.db.query(
          `SELECT
             count(*) FILTER (WHERE created_at >= $2)::int AS today,
             count(*) FILTER (WHERE created_at >= now() - interval '7 days')::int AS week,
             count(*) FILTER (WHERE verification = 'verified')::int AS verified,
             count(*) FILTER (WHERE audit_status = 'passed')::int AS audits_passed,
             count(*) FILTER (WHERE audit_status = 'failed')::int AS audits_failed
           FROM businesses WHERE registered_by = $1`,
          [agent.id, startOfDay],
        );
        const recent = await app.db.query(
          `SELECT b.id, b.client_ref, b.name, b.verification, b.status, b.audit_status, b.created_at, a.name AS area,
                  (SELECT count(*)::int FROM business_photos p WHERE p.business_id = b.id) AS photos
             FROM businesses b LEFT JOIN areas a ON a.id = b.area_id
            WHERE b.registered_by = $1 ORDER BY b.created_at DESC LIMIT 50`,
          [agent.id],
        );
        return { counts, recent };
      });
    },
    { prefix: "/field/api" },
  );
}
