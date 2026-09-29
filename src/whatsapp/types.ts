/**
 * One WhatsApp number, two sides of the conversation: customers looking for something, and
 * businesses managing their listings (see conversation/router.ts for which side a message goes to).
 */
export type Channel = "customer" | "business";

export type InboundContent =
  | { type: "text"; text: string }
  | { type: "button_reply"; id: string; title: string }
  | { type: "list_reply"; id: string; title: string; description?: string }
  | { type: "location"; lat: number; lng: number; name?: string; address?: string }
  | { type: "image"; mediaId: string; caption?: string; mimeType?: string }
  | { type: "audio"; mediaId: string; voice: boolean; mimeType?: string }
  /** A cart sent from our catalog's product cards (if WhatsApp's cart is switched on). */
  | { type: "order"; catalogId: string; items: { retailerId: string; quantity: number; price?: number; currency?: string }[]; text?: string }
  | { type: "unsupported"; rawType: string };

export interface InboundMessage {
  channel: Channel;
  /** Arrived on our WhatsApp number: the router picks the side before it's handled. */
  route?: boolean;
  /** The message a tap or reply answers, when WhatsApp says. */
  contextId?: string;
  /** The product a customer is asking about, when they wrote from one of our product cards. */
  referredProduct?: { catalogId: string; retailerId: string };
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
  waMessageId: string;
  status: string;
  recipient: string;
  errors?: unknown;
}
