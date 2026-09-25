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
    const turn: Turn<Record<string, unknown>> = {
      svc: this.svc,
      contact,
      inbound: msg,
      state,
      reply: (m) => this.svc.messenger.reply(contact, m),
    };
    if (msg.channel === "customer") await handleCustomerTurn(turn as Turn<CustomerState>);
    else await handleBusinessTurn(turn as Turn<BusinessState>);
    await saveState(db, contact.id, turn.state);
  }

  /** Resolves once every queued message has been handled. */
  async idle(): Promise<void> {
    while (this.chains.size) await Promise.all([...this.chains.values()]);
  }
}
