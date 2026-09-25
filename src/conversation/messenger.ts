import type { Alerts } from "../alerts.js";
import type { Config } from "../config.js";
import type { Db } from "../db/client.js";
import { one } from "../db/client.js";
import type { JobQueue } from "../jobs/queue.js";
import type { Logger } from "../logger.js";
import type { OutboundMessage, ReplyButton } from "../whatsapp/outbound.js";
import { isAuthError, isRetryable, type Transport } from "../whatsapp/transport.js";
import type { Channel } from "../whatsapp/types.js";
import { findContact, logOutbound, type Contact } from "./store.js";

export interface TemplateSpec {
  name: string;
  params: string[];
  quickReplies?: ReplyButton[];
}

/** WhatsApp only allows free-form messages within 24 hours of the person's last message. */
const WINDOW_MS = 24 * 60 * 60 * 1000 - 5 * 60 * 1000;
/** First retry of a failed send; the job queue spaces out later ones. */
const RETRY_AFTER_MS = 60_000;

export interface MessengerOptions {
  now?: () => Date;
  /** Failed sends are retried through the job queue; without it they are only logged. */
  jobs?: JobQueue;
  alerts?: Alerts;
}

export class Messenger {
  private readonly now: () => Date;

  constructor(
    private readonly db: Db,
    private readonly transport: Transport,
    private readonly config: Config,
    private readonly log: Logger,
    private readonly opts: MessengerOptions = {},
  ) {
    this.now = opts.now ?? (() => new Date());
  }

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

  /**
   * Try a failed message again, from the "resend" job. Throws so the queue tries later; on the
   * last attempt, or when retrying can't help, the message is marked failed instead.
   */
  async resend(rowId: string, channel: Channel, to: string, lastAttempt: boolean): Promise<void> {
    const row = await one<{ status: string; body: { message: OutboundMessage } }>(
      this.db,
      "SELECT status, body FROM messages WHERE id = $1",
      [rowId],
    );
    if (!row || row.status !== "retrying") return;
    try {
      const id = await this.transport.send(channel, to, row.body.message);
      await this.db.query("UPDATE messages SET status = 'sent', wa_message_id = $2 WHERE id = $1", [rowId, id || null]);
    } catch (err) {
      this.watch(err);
      if (isRetryable(err) && !lastAttempt) throw err;
      await this.db.query("UPDATE messages SET status = 'failed' WHERE id = $1", [rowId]);
      this.log.error({ err: errorText(err), channel, to }, "WhatsApp send failed for good");
      if (isRetryable(err)) this.opts.alerts?.send("whatsapp-send", `Messages to WhatsApp are still failing after retries: ${errorText(err)}`);
    }
  }

  private async deliver(channel: Channel, to: string, contactId: string | null, msg: OutboundMessage): Promise<void> {
    try {
      const id = await this.transport.send(channel, to, msg);
      await logOutbound(this.db, contactId, channel, id || null, msg);
    } catch (err) {
      const retry = !!this.opts.jobs && isRetryable(err);
      this.log.error({ err: errorText(err), channel, to, retry }, "WhatsApp send failed");
      this.watch(err);
      const rowId = await logOutbound(this.db, contactId, channel, null, msg, retry ? "retrying" : "failed");
      if (retry && rowId) {
        await this.opts.jobs!.enqueue("resend", { rowId, channel, to }, new Date(this.now().getTime() + RETRY_AFTER_MS));
      }
    }
  }

  private watch(err: unknown): void {
    if (isAuthError(err)) {
      this.opts.alerts?.send("whatsapp-auth", "WhatsApp rejected the access token, so no messages are going out. Check WHATSAPP_ACCESS_TOKEN.");
    }
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 300) : String(err);
}
