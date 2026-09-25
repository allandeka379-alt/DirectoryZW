import { KeywordInterpreter } from "../src/ai/keyword-interpreter.js";
import { createApp, type App } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db/client.js";
import { silentLogger } from "../src/logger.js";
import { MemoryStore } from "../src/storage.js";
import type { OutboundMessage } from "../src/whatsapp/outbound.js";
import { SimulatorTransport, type SimulatedMessage } from "../src/whatsapp/transport.js";
import type { Channel, InboundContent } from "../src/whatsapp/types.js";

export const CUSTOMER = "263771111111";

export interface TestApp extends App {
  sim: SimulatorTransport;
  files: MemoryStore;
  clock: { now: Date };
  send(channel: Channel, from: string, content: InboundContent, name?: string): Promise<void>;
  /** Customer types text. */
  say(text: string, from?: string): Promise<void>;
  /** Customer taps a button or list row by its title in the last message that has it. */
  tap(title: string, channel?: Channel, from?: string): Promise<void>;
  outbox(channel: Channel, to: string): SimulatedMessage[];
  last(channel: Channel, to: string): OutboundMessage;
  advanceHours(hours: number): void;
  phoneOf(businessName: string): Promise<string>;
}

/**
 * A full app on an in-memory database, the simulator transport, the keyword interpreter,
 * in-memory file storage and a controllable clock. The clock starts at the real time because
 * the database stamps rows with its own now().
 */
export async function testApp(env: Record<string, string> = {}): Promise<TestApp> {
  const config = loadConfig({ NODE_ENV: "test", SEED_SAMPLE_DATA: "true", BRAND_NAME: "TestDir", ...env });
  const db = await openDb({});
  const sim = new SimulatorTransport();
  const files = new MemoryStore();
  const clock = { now: new Date() };
  const app = await createApp(config, {
    db,
    transport: sim,
    store: files,
    interpreter: new KeywordInterpreter(),
    log: silentLogger,
    now: () => clock.now,
  });
  let seq = 0;

  const send = async (channel: Channel, from: string, content: InboundContent, name?: string) => {
    await app.engine.enqueue({
      channel,
      waMessageId: `test-${++seq}`,
      from,
      phone: from,
      profileName: name,
      timestamp: clock.now,
      content,
    });
  };

  const outbox = (channel: Channel, to: string) => sim.since(channel, to, 0);

  const last = (channel: Channel, to: string) => {
    const msgs = outbox(channel, to);
    const m = msgs[msgs.length - 1];
    if (!m) throw new Error(`No messages to ${channel}:${to}`);
    return m.message;
  };

  const tap = async (title: string, channel: Channel = "customer", from = CUSTOMER) => {
    const msgs = outbox(channel, from).reverse();
    for (const { message: m } of msgs) {
      if (m.kind === "buttons") {
        const b = m.buttons.find((x) => x.title === title);
        if (b) return send(channel, from, { type: "button_reply", id: b.id, title: b.title });
      }
      if (m.kind === "list") {
        for (const s of m.sections) {
          const r = s.rows.find((x) => x.title === title || x.title.startsWith(title));
          if (r) return send(channel, from, { type: "list_reply", id: r.id, title: r.title });
        }
      }
    }
    throw new Error(`No button or row "${title}" in messages to ${channel}:${from}`);
  };

  return Object.assign(app, {
    sim,
    files,
    clock,
    send,
    say: (text: string, from = CUSTOMER) => send("customer", from, { type: "text", text }, "Tendai Moyo"),
    tap,
    outbox,
    last,
    advanceHours: (hours: number) => {
      clock.now = new Date(clock.now.getTime() + hours * 3600_000);
    },
    phoneOf: async (name: string) => {
      const rows = await app.db.query<{ phone: string }>("SELECT phone FROM businesses WHERE name = $1", [name]);
      if (!rows[0]) throw new Error(`No business named ${name}`);
      return rows[0].phone;
    },
  });
}

/** Text of a message, whatever its kind. */
export function textOf(m: OutboundMessage): string {
  switch (m.kind) {
    case "text":
      return m.text;
    case "buttons":
    case "list":
    case "cta_url":
    case "location_request":
      return m.body;
    case "contact_card":
      return m.name;
    case "template":
      return textOf(m.fallback);
  }
}
