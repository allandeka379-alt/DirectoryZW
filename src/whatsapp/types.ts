/** Two WhatsApp numbers: one for customers, one for businesses (and field teams). */
export type Channel = "customer" | "business";

export type InboundContent =
  | { type: "text"; text: string }
  | { type: "button_reply"; id: string; title: string }
  | { type: "list_reply"; id: string; title: string; description?: string }
  | { type: "location"; lat: number; lng: number; name?: string; address?: string }
  | { type: "image"; mediaId: string; caption?: string; mimeType?: string }
  | { type: "audio"; mediaId: string; voice: boolean; mimeType?: string }
  | { type: "unsupported"; rawType: string };

export interface InboundMessage {
  channel: Channel;
  waMessageId: string;
  /** WhatsApp ID: a phone number, or a business-scoped user ID for people who use usernames. */
  from: string;
  /** Digits-only phone number when WhatsApp shares one. */
  phone?: string;
  profileName?: string;
  timestamp: Date;
  content: InboundContent;
}

export interface StatusUpdate {
  channel: Channel;
  waMessageId: string;
  status: string;
  recipient: string;
  errors?: unknown;
}
