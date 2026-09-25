import type { Config } from "../config.js";
import type { Db } from "../db/client.js";
import type { Logger } from "../logger.js";
import type { OutboundMessage, ReplyButton } from "../whatsapp/outbound.js";
import type { Transport } from "../whatsapp/transport.js";
import type { Channel } from "../whatsapp/types.js";
import { findContact, logOutbound, type Contact } from "./store.js";

export interface TemplateSpec {
  name: string;
  params: string[];
  quickReplies?: ReplyButton[];
}

/** WhatsApp only allows free-form messages within 24 hours of the person's last message. */
const WINDOW_MS = 24 * 60 * 60 * 1000 - 5 * 60 * 1000;

export class Messenger {
  constructor(
    private readonly db: Db,
    private readonly transport: Transport,
    private readonly config: Config,
    private readonly log: Logger,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Reply to someone who just messaged us, so the window is open. */
  async reply(contact: Contact, msg: OutboundMessage): Promise<void> {
    await this.deliver(contact.channel, contact.wa_id, contact.id, msg);
  }

  /** Message someone who may not have written recently; falls back to an approved template. */
  async notify(channel: Channel, waId: string, msg: OutboundMessage, template: TemplateSpec): Promise<void> {
    const contact = await findContact(this.db, channel, waId);
    const last = contact?.last_inbound_at ? new Date(contact.last_inbound_at).getTime() : 0;
    const open = last > 0 && this.now().getTime() - last < WINDOW_MS;
    const final: OutboundMessage = open
      ? msg
      : {
          kind: "template",
          name: template.name,
          language: this.config.whatsapp.templates.language,
          bodyParams: template.params,
          quickReplies: template.quickReplies,
          fallback: msg,
        };
    await this.deliver(channel, waId, contact?.id ?? null, final);
  }

  private async deliver(channel: Channel, to: string, contactId: string | null, msg: OutboundMessage): Promise<void> {
    try {
      const id = await this.transport.send(channel, to, msg);
      await logOutbound(this.db, contactId, channel, id || null, msg);
    } catch (err) {
      this.log.error({ err: err instanceof Error ? err.message : String(err), channel, to }, "WhatsApp send failed");
      await logOutbound(this.db, contactId, channel, null, msg, "failed");
    }
  }
}
