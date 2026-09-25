import crypto from "node:crypto";
import type { Channel, InboundContent, InboundMessage, StatusUpdate } from "./types.js";

/** Check Meta's X-Hub-Signature-256 header against the raw request body. */
export function verifySignature(rawBody: Buffer | string, header: string | undefined, appSecret: string): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = crypto.createHmac("sha256", appSecret).update(rawBody).digest();
  const given = Buffer.from(header.slice("sha256=".length), "hex");
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

export interface ParsedWebhook {
  messages: InboundMessage[];
  statuses: StatusUpdate[];
}

type Json = Record<string, any>;

/**
 * Turn a WhatsApp Cloud API webhook payload into our own message types. Messages for
 * phone numbers we don't own are ignored; unknown message types become "unsupported".
 */
export function parseWebhook(payload: unknown, phoneNumberIds: Record<Channel, string>): ParsedWebhook {
  const out: ParsedWebhook = { messages: [], statuses: [] };
  const body = payload as Json;
  if (body?.object !== "whatsapp_business_account" || !Array.isArray(body.entry)) return out;
  for (const entry of body.entry as Json[]) {
    for (const change of (entry.changes ?? []) as Json[]) {
      if (change.field !== "messages") continue;
      const value = (change.value ?? {}) as Json;
      const channel = channelFor(value.metadata?.phone_number_id, phoneNumberIds);
      if (!channel) continue;
      const names = new Map<string, string>();
      for (const c of (value.contacts ?? []) as Json[]) {
        const id = c.wa_id ?? c.user_id;
        if (id && c.profile?.name) names.set(String(id), String(c.profile.name));
      }
      for (const m of (value.messages ?? []) as Json[]) {
        const from = String(m.from ?? m.from_user_id ?? "");
        if (!from || !m.id) continue;
        out.messages.push({
          channel,
          waMessageId: String(m.id),
          from,
          phone: /^\d{7,15}$/.test(from) ? from : undefined,
          profileName: names.get(from),
          timestamp: m.timestamp ? new Date(Number(m.timestamp) * 1000) : new Date(),
          content: parseContent(m),
        });
      }
      for (const s of (value.statuses ?? []) as Json[]) {
        if (!s.id || !s.status) continue;
        out.statuses.push({
          channel,
          waMessageId: String(s.id),
          status: String(s.status),
          recipient: String(s.recipient_id ?? ""),
          errors: s.errors,
        });
      }
    }
  }
  return out;
}

function channelFor(phoneNumberId: unknown, ids: Record<Channel, string>): Channel | undefined {
  if (phoneNumberId === ids.customer) return "customer";
  if (phoneNumberId === ids.business) return "business";
  return undefined;
}

function parseContent(m: Json): InboundContent {
  switch (m.type) {
    case "text":
      return { type: "text", text: String(m.text?.body ?? "") };
    case "interactive": {
      const i = m.interactive ?? {};
      if (i.type === "button_reply") return { type: "button_reply", id: String(i.button_reply?.id), title: String(i.button_reply?.title ?? "") };
      if (i.type === "list_reply") {
        return { type: "list_reply", id: String(i.list_reply?.id), title: String(i.list_reply?.title ?? ""), description: i.list_reply?.description };
      }
      return { type: "unsupported", rawType: `interactive:${i.type}` };
    }
    case "button": // quick-reply button on a template message
      return { type: "button_reply", id: String(m.button?.payload ?? ""), title: String(m.button?.text ?? "") };
    case "location":
      return {
        type: "location",
        lat: Number(m.location?.latitude),
        lng: Number(m.location?.longitude),
        name: m.location?.name,
        address: m.location?.address,
      };
    case "image":
      return { type: "image", mediaId: String(m.image?.id ?? ""), caption: m.image?.caption, mimeType: m.image?.mime_type };
    case "audio":
      return { type: "audio", mediaId: String(m.audio?.id ?? ""), voice: Boolean(m.audio?.voice), mimeType: m.audio?.mime_type };
    default:
      return { type: "unsupported", rawType: String(m.type ?? "unknown") };
  }
}
