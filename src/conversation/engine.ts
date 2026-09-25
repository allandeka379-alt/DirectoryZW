import type { OutboundMessage } from "../whatsapp/outbound.js";
import type { Channel, InboundContent, InboundMessage } from "../whatsapp/types.js";
import { handleBusinessTurn, type BusinessState } from "./business.js";
import type { Services, Turn } from "./context.js";
import * as copy from "./copy.js";
import { handleCustomerTurn, type CustomerState } from "./customer.js";
import { attachMessage, loadState, logInbound, saveState, upsertContact } from "./store.js";

/** A message that keeps failing is dropped (and the team alerted) after this many tries. */
const MAX_ATTEMPTS = 3;
/** Unprocessed messages older than this are assumed lost to a crash or restart... */
const RECOVER_AFTER_MS = 5 * 60_000;
/** ...unless they are older than this, when a late reply would only confuse. */
const RECOVER_WITHIN_MS = 24 * 3600_000;
/** How often someone over a limit is told so; other messages are ignored quietly. */
const LIMIT_NOTICE_EVERY_MS = 10 * 60_000;

interface SavedMessage {
  id: string;
  channel: Channel;
  wa_message_id: string | null;
  body: InboundContent;
  sender: { from?: string; phone?: string | null; profileName?: string | null } | null;
  created_at: Date;
}

/**
 * Routes each inbound message to the customer or business flow. Every message is saved before it
 * is handled, so a crash can't lose it. Messages from the same person are handled one at a time,
 * in order; repeats of a WhatsApp message ID are ignored.
 */
export class ConversationEngine {
  private readonly chains = new Map<string, Promise<void>>();
  private readonly inFlight = new Set<string>();

  constructor(private readonly svc: Services) {}

  /** For the webhook: save the message, then handle it in the background. */
  async receive(msg: InboundMessage): Promise<void> {
    const id = await logInbound(this.svc.db, msg);
    if (id) void this.schedule(id, msg);
  }

  /** Save and handle a message, resolving once it has been handled (simulator and tests). */
  async enqueue(msg: InboundMessage): Promise<void> {
    const id = await logInbound(this.svc.db, msg);
    if (id) await this.schedule(id, msg);
  }

  /** Handle messages a crash or restart left unprocessed. Returns how many were picked up. */
  async recover(): Promise<number> {
    const { db, now } = this.svc;
    const rows = await db.query<SavedMessage>(
      `SELECT id, channel, wa_message_id, body, sender, created_at FROM messages
        WHERE direction = 'in' AND processed_at IS NULL AND attempts < $1 AND created_at > $2 AND created_at < $3
        ORDER BY created_at LIMIT 200`,
      [MAX_ATTEMPTS, new Date(now().getTime() - RECOVER_WITHIN_MS), new Date(now().getTime() - RECOVER_AFTER_MS)],
    );
    let picked = 0;
    for (const row of rows) {
      if (this.inFlight.has(row.id)) continue;
      const msg = toInbound(row);
      if (!msg) {
        await db.query("UPDATE messages SET processed_at = now() WHERE id = $1", [row.id]);
        continue;
      }
      this.svc.log.warn({ messageId: row.id, from: msg.from }, "Handling a message left over from before a restart");
      void this.schedule(row.id, msg);
      picked++;
    }
    return picked;
  }

  /** Resolves once every queued message has been handled. */
  async idle(): Promise<void> {
    while (this.chains.size) await Promise.all([...this.chains.values()]);
  }

  private schedule(id: string, msg: InboundMessage): Promise<void> {
    const key = `${msg.channel}:${msg.from}`;
    this.inFlight.add(id);
    const run = (this.chains.get(key) ?? Promise.resolve()).then(() => this.process(id, msg));
    this.chains.set(key, run);
    void run.finally(() => {
      this.inFlight.delete(id);
      if (this.chains.get(key) === run) this.chains.delete(key);
    });
    return run;
  }

  /** Handle one saved message. Never throws: a failure is counted, and recover() tries again later. */
  private async process(id: string, msg: InboundMessage): Promise<void> {
    const { db, log, alerts } = this.svc;
    try {
      await this.handle(id, msg);
      await db.query("UPDATE messages SET processed_at = now() WHERE id = $1", [id]);
    } catch (err) {
      log.error({ err: err instanceof Error ? err.stack : String(err), from: msg.from }, "Failed to handle message");
      try {
        const [row] = await db.query<{ attempts: number }>(
          "UPDATE messages SET attempts = attempts + 1 WHERE id = $1 RETURNING attempts",
          [id],
        );
        if (!row || row.attempts >= MAX_ATTEMPTS) {
          await db.query("UPDATE messages SET processed_at = now() WHERE id = $1", [id]);
          alerts.send("inbound", `A ${msg.channel} message failed ${MAX_ATTEMPTS} times and was dropped: ${String(err).slice(0, 200)}`);
        }
      } catch (inner) {
        log.error({ err: String(inner) }, "Could not record a failed message");
      }
    }
  }

  private async handle(id: string, msg: InboundMessage): Promise<void> {
    const { db, messenger } = this.svc;
    const contact = await upsertContact(db, {
      channel: msg.channel,
      waId: msg.from,
      phone: msg.phone,
      profileName: msg.profileName,
      at: msg.timestamp,
    });
    await attachMessage(db, id, contact.id);
    if (contact.is_blocked) return;
    const state = await loadState<Record<string, unknown>>(db, contact.id);
    let prefix: string | undefined;
    const deferred: (() => Promise<void>)[] = [];
    const turn: Turn<Record<string, unknown>> = {
      svc: this.svc,
      contact,
      inbound: msg,
      state,
      reply: (m) => {
        const merged = prefix ? withPrefix(m, prefix) : undefined;
        if (merged) prefix = undefined;
        return messenger.reply(contact, merged ?? m);
      },
      prefixNext: (line) => {
        prefix = prefix ? `${prefix}\n${line}` : line;
      },
      defer: (fn) => {
        deferred.push(fn);
      },
    };
    if (!(await this.overLimit(turn))) {
      if (msg.channel === "customer") await handleCustomerTurn(turn as Turn<CustomerState>);
      else await handleBusinessTurn(turn as Turn<BusinessState>);
    }
    if (prefix) await messenger.reply(contact, { kind: "text", text: prefix });
    await saveState(db, contact.id, turn.state);
    for (const fn of deferred) await fn();
  }

  /**
   * Floods from one number (a stuck script, someone tapping wildly, or photos sent to run up our
   * Claude bill) are dropped. The sender hears why once in a while, not on every message.
   */
  private async overLimit(t: Turn<Record<string, unknown>>): Promise<boolean> {
    const { db, config, now } = this.svc;
    const [counts] = await db.query<{ minute: number; day: number; media: number }>(
      `SELECT count(*) FILTER (WHERE created_at > now() - interval '1 minute')::int AS minute,
              count(*)::int AS day,
              count(*) FILTER (WHERE kind IN ('image', 'audio'))::int AS media
         FROM messages
        WHERE contact_id = $1 AND direction = 'in' AND created_at > now() - interval '1 day'`,
      [t.contact.id],
    );
    if (!counts) return false;
    const { perMinute, perDay, mediaPerDay } = config.limits;
    const isMedia = t.inbound.content.type === "image" || t.inbound.content.type === "audio";
    let notice: OutboundMessage | undefined;
    if (counts.minute > perMinute || counts.day > perDay) notice = copy.slowDown();
    else if (isMedia && counts.media > mediaPerDay) notice = copy.tooMuchMedia();
    if (!notice) return false;
    const last = Number(t.state._limitNoticeAt ?? 0);
    if (now().getTime() - last >= LIMIT_NOTICE_EVERY_MS) {
      t.state._limitNoticeAt = now().getTime();
      await t.reply(notice);
    }
    this.svc.log.warn({ contactId: t.contact.id, ...counts }, "Message over the per-number limit ignored");
    return true;
  }
}

/** Rebuild a saved message for handling again. */
function toInbound(row: SavedMessage): InboundMessage | undefined {
  if (!row.sender?.from || !row.wa_message_id) return undefined;
  return {
    channel: row.channel,
    waMessageId: row.wa_message_id,
    from: row.sender.from,
    phone: row.sender.phone ?? undefined,
    profileName: row.sender.profileName ?? undefined,
    timestamp: new Date(row.created_at),
    content: row.body,
  };
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
