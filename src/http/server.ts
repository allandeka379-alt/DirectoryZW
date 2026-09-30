import Fastify, { type FastifyInstance } from "fastify";
import type { App } from "../app.js";
import { updateMessageStatus } from "../conversation/store.js";
import { parseWebhook, verifySignature } from "../whatsapp/webhook.js";
import { registerField } from "./field.js";
import { registerOps } from "./ops.js";
import { registerSimulator } from "./simulator.js";
import { registerPublicProducts } from "./products-public.js";
import { registerWeb } from "./web.js";

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

/** Fastify with a JSON parser that keeps the raw body, which webhook signature checks need. */
export function createServer(opts: { logger: boolean }): FastifyInstance {
  const server = Fastify({
    // Request logs keep the path, never the query string: links can carry tokens.
    logger: opts.logger && { serializers: { req: (req: { method?: string; url?: string; ip?: string }) => ({ method: req.method, url: (req.url ?? "").split("?")[0], remoteAddress: req.ip }) } },
    bodyLimit: 1_000_000,
  });
  // On every response: browsers take content types as given, other sites can't frame our pages,
  // and other sites are sent our origin at most, never a full address.
  server.addHook("onSend", async (_req, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "strict-origin-when-cross-origin");
    return payload;
  });
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
  // Before launch too, so the webhook can be registered with Meta before WhatsApp is switched on.
  server.get("/webhook/whatsapp", async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const token = app.config.whatsapp.verifyToken;
    if (q["hub.mode"] === "subscribe" && token && q["hub.verify_token"] === token) {
      return reply.type("text/plain").send(q["hub.challenge"] ?? "");
    }
    if (app.config.whatsapp.transport === "off") return reply.code(503).send("WhatsApp isn't connected yet");
    return reply.code(403).send("Forbidden");
  });

  // Every message and delivery status arrives here. Messages are saved before Meta gets its 200
  // (if saving fails, Meta retries), then handled in the background.
  server.post("/webhook/whatsapp", async (req, reply) => {
    const off = app.config.whatsapp.transport === "off";
    const secret = app.config.whatsapp.appSecret;
    if (secret) {
      const signature = req.headers["x-hub-signature-256"];
      if (!req.rawBody || !verifySignature(req.rawBody, typeof signature === "string" ? signature : undefined, secret)) {
        return reply.code(401).send("Invalid signature");
      }
    } else if (off) {
      return reply.code(503).send("WhatsApp isn't connected yet");
    } else if (app.config.env === "production") {
      return reply.code(500).send("WHATSAPP_APP_SECRET is not configured");
    }
    const parsed = parseWebhook(req.body, app.config.whatsapp.phoneNumberId);
    // Before launch nothing is answered. Meta gets its 200, so it doesn't retry for days and flood us at launch.
    if (off) {
      if (parsed.messages.length) req.log.warn({ messages: parsed.messages.length }, "WhatsApp is off: incoming messages dropped");
      return reply.code(200).send("OK");
    }
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
  registerWeb(server, app);
  registerPublicProducts(server, app);
}
