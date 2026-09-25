import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebhookAlerts } from "../src/alerts.js";
import { KeywordInterpreter } from "../src/ai/keyword-interpreter.js";
import type { Interpreter } from "../src/ai/types.js";
import { logInbound } from "../src/conversation/store.js";
import { silentLogger } from "../src/logger.js";
import type { OutboundMessage } from "../src/whatsapp/outbound.js";
import { SimulatorTransport, WhatsAppApiError, type Transport } from "../src/whatsapp/transport.js";
import type { Channel } from "../src/whatsapp/types.js";
import { testApp, textOf, type TestApp } from "./helpers.js";

/** Fails the next sends with the given errors, then behaves like the simulator. */
class FlakyTransport implements Transport {
  readonly inner = new SimulatorTransport();
  failures: Error[] = [];
  async send(channel: Channel, to: string, message: OutboundMessage): Promise<string> {
    const failure = this.failures.shift();
    if (failure) throw failure;
    return this.inner.send(channel, to, message);
  }
}

/** Throws while `broken` is set, else reads requests like the keyword interpreter. */
class BreakableInterpreter implements Interpreter {
  readonly name = "breakable";
  broken = false;
  private readonly keywords = new KeywordInterpreter();
  interpretRequest: Interpreter["interpretRequest"] = async (text, ctx) => {
    if (this.broken) throw new Error("interpreter exploded");
    return this.keywords.interpretRequest(text, ctx);
  };
  classifyBusiness: Interpreter["classifyBusiness"] = (text, ctx) => this.keywords.classifyBusiness(text, ctx);
}

const transport = new FlakyTransport();
const interpreter = new BreakableInterpreter();
const alerts = new WebhookAlerts({ brand: "TestDir", log: silentLogger });
let app: TestApp;
let n = 0;
const newCustomer = () => `26377333${String(++n).padStart(4, "0")}`;

beforeAll(async () => {
  app = await testApp({}, { transport, interpreter, alerts });
});
afterAll(async () => {
  await app.close();
});

const sent = (to: string) => transport.inner.since("customer", to).map((m) => textOf(m.message));

async function consented(customer: string) {
  await app.say("hi", customer);
  await app.send("customer", customer, { type: "button_reply", id: "consent:yes", title: "I agree" });
}

describe("messages survive a crash", () => {
  it("handles messages a restart left unprocessed", async () => {
    const customer = newCustomer();
    await consented(customer);
    // Saved by the webhook, then the process died before handling it.
    await logInbound(app.db, {
      channel: "customer",
      waMessageId: "crash-1",
      from: customer,
      phone: customer,
      timestamp: app.clock.now,
      content: { type: "text", text: "I need a plumber in Mabelreign" },
    });
    expect(await app.engine.recover()).toBe(0); // too recent: it may still be in progress

    app.advanceHours(0.1); // six minutes later
    expect(await app.engine.recover()).toBe(1);
    await app.engine.idle();
    expect(sent(customer).at(-1)).toMatch(/^I found \d places for \*plumber\*/);
    const [row] = await app.db.query<{ processed_at: Date | null }>("SELECT processed_at FROM messages WHERE wa_message_id = 'crash-1'");
    expect(row?.processed_at).not.toBeNull();
    expect(await app.engine.recover()).toBe(0); // done once
  });

  it("retries a message that failed, then gives up and alerts the team", async () => {
    const customer = newCustomer();
    await consented(customer);
    interpreter.broken = true;
    try {
      await app.say("I need an electrician in Belvedere", customer);
      for (let i = 0; i < 3; i++) {
        app.advanceHours(0.1);
        await app.engine.recover();
        await app.engine.idle();
      }
    } finally {
      interpreter.broken = false;
    }
    const [row] = await app.db.query<{ attempts: number; processed_at: Date | null }>(
      "SELECT attempts, processed_at FROM messages WHERE direction = 'in' AND body->>'text' = 'I need an electrician in Belvedere'",
    );
    expect(row).toMatchObject({ attempts: 3 });
    expect(row?.processed_at).not.toBeNull();
    expect(alerts.recent.some((a) => a.key === "inbound")).toBe(true);
    app.advanceHours(0.1);
    expect(await app.engine.recover()).toBe(0);
  });
});

describe("replies that fail to send", () => {
  it("retries temporary WhatsApp errors from the job queue", async () => {
    const customer = newCustomer();
    await consented(customer);
    transport.failures.push(new WhatsAppApiError(503, { error: "busy" }));
    await app.say("I need a plumber in Mabelreign", customer);
    const status = async () =>
      (await app.db.query<{ status: string }>(
        "SELECT m.status FROM messages m JOIN contacts c ON c.id = m.contact_id WHERE c.wa_id = $1 AND m.direction = 'out' ORDER BY m.created_at DESC LIMIT 1",
        [customer],
      ))[0]?.status;
    expect(await status()).toBe("retrying");
    expect(sent(customer).at(-1)).not.toMatch(/^I found/);

    app.advanceHours(0.05);
    await app.runJobs();
    expect(await status()).toBe("sent");
    expect(sent(customer).at(-1)).toMatch(/^I found/);
  });

  it("doesn't retry errors that won't improve, and alerts on a rejected token", async () => {
    const customer = newCustomer();
    await consented(customer);
    transport.failures.push(new WhatsAppApiError(400, { error: { code: 131047, message: "Re-engagement message" } }));
    await app.say("menu", customer);
    const [bad] = await app.db.query<{ n: number }>("SELECT count(*)::int AS n FROM jobs WHERE kind = 'resend' AND status = 'queued'");
    expect(bad?.n).toBe(0);

    transport.failures.push(new WhatsAppApiError(401, { error: "token expired" }));
    await app.say("menu", customer);
    expect(alerts.recent[0]?.key).toBe("whatsapp-auth");
  });
});

describe("health checks", () => {
  it("reports readiness when the database answers", async () => {
    const { createServer, registerRoutes } = await import("../src/http/server.js");
    const server = createServer({ logger: false });
    registerRoutes(server, app);
    await server.ready();
    try {
      expect((await server.inject({ url: "/ready" })).json()).toEqual({ ok: true });
      expect((await server.inject({ url: "/health" })).statusCode).toBe(200);
    } finally {
      await server.close();
    }
  });
});
