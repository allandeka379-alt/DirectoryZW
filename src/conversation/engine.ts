import type { OutboundMessage } from "../whatsapp/outbound.js";
import type { InboundMessage } from "../whatsapp/types.js";
import { handleBusinessTurn, type BusinessState } from "./business.js";
import type { Services, Turn } from "./context.js";
import { handleCustomerTurn, type CustomerState } from "./customer.js";
import { attachMessage, loadState, logInbound, saveState, upsertContact } from "./store.js";

/**
 * Routes each inbound message to the customer or business flow. Messages from the same
 * person are handled one at a time, in order; repeats of a WhatsApp message ID are ignored.
 */
export class ConversationEngine {
  private readonly chains = new Map<string, Promise<void>>();

  constructor(private readonly svc: Services) {}

  enqueue(msg: InboundMessage): Promise<void> {
    const key = `${msg.channel}:${msg.from}`;
    const run = (this.chains.get(key) ?? Promise.resolve())
      .then(() => this.handle(msg))
      .catch((err) =>
        this.svc.log.error({ err: err instanceof Error ? err.stack : String(err), from: msg.from }, "Failed to handle message"),
      );
    this.chains.set(key, run);
    void run.finally(() => {
      if (this.chains.get(key) === run) this.chains.delete(key);
    });
    return run;
  }

  async handle(msg: InboundMessage): Promise<void> {
    const { db } = this.svc;
    const messageId = await logInbound(db, msg);
    if (!messageId) return; // WhatsApp delivered this one already
    const contact = await upsertContact(db, {
      channel: msg.channel,
      waId: msg.from,
      phone: msg.phone,
      profileName: msg.profileName,
      at: msg.timestamp,
    });
    await attachMessage(db, messageId, contact.id);
    const state = await loadState<Record<string, unknown>>(db, contact.id);
    let prefix: string | undefined;
    const turn: Turn<Record<string, unknown>> = {
      svc: this.svc,
      contact,
      inbound: msg,
      state,
      reply: (m) => {
        const merged = prefix ? withPrefix(m, prefix) : undefined;
        if (merged) prefix = undefined;
        return this.svc.messenger.reply(contact, merged ?? m);
      },
      prefixNext: (line) => {
        prefix = prefix ? `${prefix}\n${line}` : line;
      },
    };
    if (msg.channel === "customer") await handleCustomerTurn(turn as Turn<CustomerState>);
    else await handleBusinessTurn(turn as Turn<BusinessState>);
    if (prefix) await this.svc.messenger.reply(contact, { kind: "text", text: prefix });
    await saveState(db, contact.id, turn.state);
  }

  /** Resolves once every queued message has been handled. */
  async idle(): Promise<void> {
    while (this.chains.size) await Promise.all([...this.chains.values()]);
  }
}

/** The message with a line added at the top of its text, or undefined when it has no text to add to. */
function withPrefix(m: OutboundMessage, line: string): OutboundMessage | undefined {
  switch (m.kind) {
    case "text":
      return { ...m, text: `${line}\n\n${m.text}` };
    case "buttons":
    case "list":
    case "cta_url":
    case "location_request":
      return { ...m, body: `${line}\n\n${m.body}` };
    default:
      return undefined;
  }
}
