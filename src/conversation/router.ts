import type { Db } from "../db/client.js";
import { one } from "../db/client.js";
import { normalizeText } from "../text.js";
import { REGISTRATION_CODE } from "../web/registration.js";
import type { Channel, InboundMessage } from "../whatsapp/types.js";
import { ERASE_WORDS, PRODUCT_CODE } from "./customer.js";

/**
 * One WhatsApp number serves customers and businesses. Each message goes to one side:
 * - a tap goes back to the side that sent the button or list it came from;
 * - "I want to register a business" starts a registration, and "my business" opens the business menu;
 * - while the business side was the last to reply (within the hour), it keeps what it's waiting for:
 *   the next step of a registration, edit or supplier search, its own commands, and "menu", "cancel"
 *   or "back";
 * - "delete my data" from someone who owns a listing goes to the business side, which deletes both;
 * - a website registration code ("REG-123456") finishes that registration, and "dashboard" from someone
 *   who owns a listing gets them a sign-in link for the web dashboard;
 * - everything else is a customer looking for something.
 */
export async function chooseSide(db: Db, msg: InboundMessage): Promise<Channel> {
  const c = msg.content;
  // About one of our products (its card, a cart, or its page's code): the customer side.
  if (msg.referredProduct || c.type === "order" || (c.type === "text" && PRODUCT_CODE.test(c.text))) return "customer";
  if (c.type === "button_reply" || c.type === "list_reply") {
    return (await sideThatSent(db, msg.from, c.id, msg.contextId)) ?? (await recentSide(db, msg.from)) ?? "customer";
  }
  const text = c.type === "text" ? normalizeText(c.text) : "";
  if (c.type === "text" && REGISTRATION_CODE.test(c.text)) return "business";
  if (text && isRegisterIntent(text)) return "business";
  if (DASHBOARD.has(text) && (await ownsListing(db, msg.from))) return "business";
  if (MY_BUSINESS.has(text)) return "business";
  if (ERASE.has(text) && (await ownsListing(db, msg.from))) return "business";

  if ((await recentSide(db, msg.from)) !== "business") return "customer";
  if (NAVIGATION.has(text) || BUSINESS_COMMANDS.has(text)) return "business";
  const busy = await businessBusy(db, msg.from);
  if (c.type === "text" || c.type === "location") return busy ? "business" : "customer";
  // Photos and voice notes get "please type" from whichever side was talking.
  return "business";
}

/** "I want to register a business", "register my shop", "list my business", "sign up"... */
export function isRegisterIntent(text: string): boolean {
  const t = normalizeText(text);
  return REGISTER_ALONE.has(t) || REGISTER_PHRASE.test(t);
}

const REGISTER_ALONE = new Set(["register", "join", "sign up", "signup", "register business", "list my business", "add my business"]);
// "Register a company" stays a search: people also look for agents who register companies.
const REGISTER_PHRASE =
  /\b(?:register|list|add|sign ?up)\s+(?:(?:my|our)\s+(?:business|businesses|shop|store|company|stall|salon|restaurant)|(?:a|the)\s+(?:business|shop|store))\b/;
/** Asking for a sign-in link to the web dashboard. "dashboard" alone stays a search for people who don't own a listing. */
export const DASHBOARD = new Set(["dashboard", "my dashboard", "open dashboard", "dashboard link", "login", "log in", "sign in", "signin"]);
export const MY_BUSINESS = new Set(["my business", "my businesses", "business menu", "my shop", "my listing", "my listings", "manage my business"]);
const NAVIGATION = new Set(["menu", "cancel", "stop", "back", "exit", "help"]);
const BUSINESS_COMMANDS = new Set([
  "summary",
  "stats",
  "customers",
  "my customers",
  "leads",
  "pause",
  "resume",
  "remove",
  "find a supplier",
  "find supplier",
  "suppliers",
  "supplier",
  "wholesale",
  "wholesalers",
  "buy stock",
  "restock",
]);
const ERASE = new Set(ERASE_WORDS.map(normalizeText));

/** How long the business side keeps a conversation after its last reply. */
const BUSINESS_HOLD = "1 hour";

/** The side that sent the message a tap answers: by WhatsApp's reply context, else by the button or row ID. */
async function sideThatSent(db: Db, waId: string, id: string, contextId?: string): Promise<Channel | undefined> {
  if (contextId) {
    const row = await one<{ channel: Channel }>(
      db,
      "SELECT channel FROM messages WHERE wa_message_id = $1 AND direction = 'out'",
      [contextId],
    );
    if (row) return row.channel;
  }
  const row = await one<{ channel: Channel }>(
    db,
    `SELECT m.channel FROM messages m JOIN contacts c ON c.id = m.contact_id
      WHERE c.wa_id = $1 AND m.direction = 'out' AND m.created_at > now() - interval '30 days'
        AND position($2 in m.body::text) > 0
      ORDER BY m.created_at DESC LIMIT 1`,
    [waId, `"id": ${JSON.stringify(id)}`],
  );
  return row?.channel;
}

/** Which side last replied to this person, if it was within the hour. */
async function recentSide(db: Db, waId: string): Promise<Channel | undefined> {
  const row = await one<{ channel: Channel }>(
    db,
    `SELECT m.channel FROM messages m JOIN contacts c ON c.id = m.contact_id
      WHERE c.wa_id = $1 AND m.direction = 'out' AND m.created_at > now() - interval '${BUSINESS_HOLD}'
      ORDER BY m.created_at DESC LIMIT 1`,
    [waId],
  );
  return row?.channel;
}

/** The business side is in the middle of something: a registration, an edit or a supplier search. */
async function businessBusy(db: Db, waId: string): Promise<boolean> {
  const row = await one<{ busy: boolean }>(
    db,
    `SELECT (s.state->>'stage' IS NOT NULL OR jsonb_typeof(s.state->'buying') = 'object') AS busy
       FROM sessions s JOIN contacts c ON c.id = s.contact_id
      WHERE c.wa_id = $1 AND c.channel = 'business'`,
    [waId],
  );
  return row?.busy ?? false;
}

async function ownsListing(db: Db, waId: string): Promise<boolean> {
  const row = await one<{ owns: boolean }>(
    db,
    `SELECT EXISTS (SELECT 1 FROM businesses b JOIN contacts c ON c.id = b.owner_contact_id
                     WHERE c.wa_id = $1 AND b.status <> 'removed') AS owns`,
    [waId],
  );
  return row?.owns ?? false;
}
