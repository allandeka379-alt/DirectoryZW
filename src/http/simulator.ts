import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { App } from "../app.js";
import type { SimulatorTransport } from "../whatsapp/transport.js";
import type { InboundMessage } from "../whatsapp/types.js";
import { simulatorPage } from "./simulator-page.js";

const Content = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string().min(1).max(4096) }),
  z.object({ type: z.literal("button_reply"), id: z.string().max(256), title: z.string().max(100) }),
  z.object({ type: z.literal("list_reply"), id: z.string().max(256), title: z.string().max(100), description: z.string().max(200).optional() }),
  z.object({ type: z.literal("location"), lat: z.number(), lng: z.number(), name: z.string().max(100).optional() }),
]);

const SendBody = z.object({
  channel: z.enum(["customer", "business"]),
  from: z.string().regex(/^\d{7,15}$/),
  name: z.string().max(60).optional(),
  content: Content,
});

/** A local WhatsApp stand-in: two chat panes in the browser, no Meta account needed. */
export function registerSimulator(server: FastifyInstance, app: App, sim: SimulatorTransport): void {
  server.get("/", async (_req, reply) => reply.redirect("/simulator"));
  server.get("/simulator", async (_req, reply) => reply.type("text/html").send(simulatorPage(app.config.brandName)));

  server.get("/simulator/api/areas", async () =>
    app.services.gazetteer.areas.map((a) => ({ name: a.name, city: a.city, lat: a.lat, lng: a.lng })),
  );

  server.get("/simulator/api/businesses", async () =>
    app.db.query(
      "SELECT name, phone, verification, status FROM businesses WHERE status <> 'removed' ORDER BY name LIMIT 300",
    ),
  );

  server.post("/simulator/api/send", async (req, reply) => {
    const parsed = SendBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues });
    const { channel, from, name, content } = parsed.data;
    const message: InboundMessage = {
      channel,
      waMessageId: `sim-in-${crypto.randomUUID()}`,
      from,
      phone: from,
      profileName: name || undefined,
      timestamp: app.services.now(),
      content,
    };
    await app.engine.enqueue(message);
    return { ok: true };
  });

  // Polled every 1.5 seconds by each chat pane, so keep it out of the request log.
  server.get("/simulator/api/messages", { logLevel: "warn" }, async (req, reply) => {
    const q = req.query as { channel?: string; to?: string; after?: string };
    if (q.channel !== "customer" && q.channel !== "business") return reply.code(400).send({ error: "channel" });
    return sim.since(q.channel, String(q.to ?? ""), Number(q.after) || 0);
  });

  // Make every queued job due now and run it, so follow-ups can be tried without waiting days.
  server.post("/simulator/api/jobs/run-now", async () => {
    await app.db.query("UPDATE jobs SET run_at = $1 WHERE status = 'queued'", [app.services.now()]);
    return { ran: await app.runJobs() };
  });
}
