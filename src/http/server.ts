import Fastify, { type FastifyInstance } from "fastify";
import type { App } from "../app.js";
import { updateMessageStatus } from "../conversation/store.js";
import { parseWebhook, verifySignature } from "../whatsapp/webhook.js";
import { registerField } from "./field.js";
import { registerOps } from "./ops.js";
import { registerSimulator } from "./simulator.js";

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

/** Fastify with a JSON parser that keeps the raw body, which webhook signature checks need. */
export function createServer(opts: { logger: boolean }): FastifyInstance {
  const server = Fastify({ logger: opts.logger, bodyLimit: 1_000_000 });
  server.addContentTypeParser("application/json", { parseAs: "buffer" }, (req, body, done) => {
    const buf = body as Buffer;
    req.rawBody = buf;
    if (!buf.length) return done(null, {});
    try {
      done(null, JSON.parse(buf.toString("utf8")));
    } catch {
      const err = Object.assign(new Error("Invalid JSON"), { statusCode: 400 });
      done(err, undefined);
    }
  });
  return server;
}

export function registerRoutes(server: FastifyInstance, app: App): void {
  // Liveness: the process is up. Readiness: it can reach the database.
  server.get("/health", async () => ({ ok: true, understanding: app.services.understanding.description }));
  server.get("/ready", async (_req, reply) => {
    try {
      await app.db.query("SELECT 1");
      return { ok: true };
    } catch {
      return reply.code(503).send({ ok: false, error: "database unreachable" });
    }
  });

  // Meta calls this once when you register the webhook URL.
  server.get("/webhook/whatsapp", async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const token = app.config.whatsapp.verifyToken;
    if (q["hub.mode"] === "subscribe" && token && q["hub.verify_token"] === token) {
      return reply.type("text/plain").send(q["hub.challenge"] ?? "");
    }
    return reply.code(403).send("Forbidden");
  });

  // Every message and delivery status arrives here. Messages are saved before Meta gets its 200
  // (if saving fails, Meta retries), then handled in the background.
  server.post("/webhook/whatsapp", async (req, reply) => {
    const secret = app.config.whatsapp.appSecret;
    if (secret) {
      const signature = req.headers["x-hub-signature-256"];
      if (!req.rawBody || !verifySignature(req.rawBody, typeof signature === "string" ? signature : undefined, secret)) {
        return reply.code(401).send("Invalid signature");
      }
    } else if (app.config.env === "production") {
      return reply.code(500).send("WHATSAPP_APP_SECRET is not configured");
    }
    const parsed = parseWebhook(req.body, app.config.whatsapp.phoneNumberIds);
    try {
      for (const message of parsed.messages) await app.engine.receive(message);
    } catch (err) {
      req.log.error({ err: String(err) }, "Could not save inbound messages");
      return reply.code(500).send("Try again");
    }
    for (const status of parsed.statuses) {
      void updateMessageStatus(app.db, status.waMessageId, status.status).catch((err) =>
        req.log.warn({ err: String(err) }, "Could not record message status"),
      );
    }
    return reply.code(200).send("OK");
  });

  if (app.simulator) registerSimulator(server, app, app.simulator);
  registerOps(server, app);
  registerField(server, app);
}
