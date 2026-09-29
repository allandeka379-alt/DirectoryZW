import type { Db } from "../db/client.js";
import { one } from "../db/client.js";
import { isUuid } from "../directory/businesses.js";
import type { RequestInterpretation } from "../ai/types.js";
import type { ReadingSummary } from "../ai/understanding.js";
import { describe, type OutboundMessage } from "../whatsapp/outbound.js";
import type { Channel, InboundMessage } from "../whatsapp/types.js";

export interface Contact {
  id: string;
  channel: Channel;
  wa_id: string;
  phone: string | null;
  profile_name: string | null;
  consent_at: Date | null;
  last_inbound_at: Date | null;
  is_blocked: boolean;
  created_at: Date;
}

export async function upsertContact(
  db: Db,
  m: { channel: Channel; waId: string; phone?: string; profileName?: string; at: Date },
): Promise<Contact> {
  const row = await one<Contact>(
    db,
    `INSERT INTO contacts (channel, wa_id, phone, profile_name, last_inbound_at) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (channel, wa_id) DO UPDATE SET
       phone = COALESCE(excluded.phone, contacts.phone),
       profile_name = COALESCE(excluded.profile_name, contacts.profile_name),
       last_inbound_at = GREATEST(contacts.last_inbound_at, excluded.last_inbound_at)
     RETURNING *`,
    [m.channel, m.waId, m.phone ?? null, m.profileName ?? null, m.at],
  );
  // One WhatsApp number: a message to either side opens the free 24-hour window for both.
  await db.query("UPDATE contacts SET last_inbound_at = GREATEST(last_inbound_at, $3) WHERE wa_id = $1 AND channel <> $2", [
    m.waId,
    m.channel,
    m.at,
  ]);
  return row!;
}

/** The same person on the other side of the conversation (a customer who also owns a business), if any. */
export async function otherSide(db: Db, contact: Pick<Contact, "wa_id" | "channel">): Promise<Contact | undefined> {
  return one<Contact>(db, "SELECT * FROM contacts WHERE wa_id = $1 AND channel <> $2", [contact.wa_id, contact.channel]);
}

export async function findContact(db: Db, channel: Channel, waId: string): Promise<Contact | undefined> {
  return one<Contact>(db, "SELECT * FROM contacts WHERE channel = $1 AND wa_id = $2", [channel, waId]);
}

export async function getContactById(db: Db, id: string): Promise<Contact | undefined> {
  if (!isUuid(id)) return undefined;
  return one<Contact>(db, "SELECT * FROM contacts WHERE id = $1", [id]);
}

export async function setConsent(db: Db, contactId: string): Promise<void> {
  await db.query("UPDATE contacts SET consent_at = COALESCE(consent_at, now()) WHERE id = $1", [contactId]);
}

export async function loadState<T>(db: Db, contactId: string): Promise<T> {
  const row = await one<{ state: T }>(db, "SELECT state FROM sessions WHERE contact_id = $1", [contactId]);
  return (row?.state ?? {}) as T;
}

export async function saveState(db: Db, contactId: string, state: unknown): Promise<void> {
  await db.query(
    `INSERT INTO sessions (contact_id, state, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (contact_id) DO UPDATE SET state = excluded.state, updated_at = now()`,
    [contactId, JSON.stringify(state ?? {})],
  );
}

/** Store an inbound message before handling it. Returns its row ID, or null if WhatsApp already delivered it. */
export async function logInbound(db: Db, m: InboundMessage): Promise<string | null> {
  const row = await one<{ id: string }>(
    db,
    `INSERT INTO messages (channel, direction, wa_message_id, kind, body, sender) VALUES ($1, 'in', $2, $3, $4, $5)
     ON CONFLICT DO NOTHING RETURNING id`,
    [
      m.channel,
      m.waMessageId,
      m.content.type,
      JSON.stringify(m.content),
      JSON.stringify({
        from: m.from,
        phone: m.phone ?? null,
        profileName: m.profileName ?? null,
        ...(m.route ? { route: true, contextId: m.contextId ?? null } : {}),
      }),
    ],
  );
  return row?.id ?? null;
}

export async function attachMessage(db: Db, messageId: string, contactId: string): Promise<void> {
  await db.query("UPDATE messages SET contact_id = $2 WHERE id = $1", [messageId, contactId]);
}

/** Store an outbound message. Returns its row ID. */
export async function logOutbound(
  db: Db,
  contactId: string | null,
  channel: Channel,
  waMessageId: string | null,
  msg: OutboundMessage,
  status = "sent",
): Promise<string | null> {
  const row = await one<{ id: string }>(
    db,
    `INSERT INTO messages (contact_id, channel, direction, wa_message_id, kind, body, status)
     VALUES ($1, $2, 'out', $3, $4, $5, $6) ON CONFLICT DO NOTHING RETURNING id`,
    [contactId, channel, waMessageId, msg.kind, JSON.stringify({ text: describe(msg), message: msg }), status],
  );
  return row?.id ?? null;
}

export async function updateMessageStatus(db: Db, waMessageId: string, status: string): Promise<void> {
  await db.query("UPDATE messages SET status = $2 WHERE wa_message_id = $1", [waMessageId, status]);
}

export type RequestStatus = "open" | "answered" | "no_results" | "connected" | "handoff" | "asked_around" | "closed";

export interface RequestRow {
  id: string;
  contact_id: string;
  raw_text: string;
  interpretation: RequestInterpretation;
  category_slug: string | null;
  query: string;
  area_id: number | null;
  lat: number | null;
  lng: number | null;
  status: RequestStatus;
  result_count: number;
  /** local, phrasebook, customer, claude or fallback ("photo" on requests from before typed messages only) */
  understood_by: string | null;
  /** exact, related, none, or retail (a business given retail stores because no wholesaler had it) */
  match: "exact" | "related" | "none" | "retail" | null;
  /** What the local engine made of it. */
  reading: ReadingSummary | null;
  /** When the customer said the results weren't what they asked for. */
  flagged_at: Date | null;
  /** Set when a business was looking for supplies: which of the owner's businesses it was for. */
  buyer_business_id: string | null;
  /** Businesses that listed a matching product when it was answered (null before products were searched). */
  product_matches: number | null;
  created_at: Date;
}

export async function createRequest(
  db: Db,
  r: {
    contactId: string;
    rawText: string;
    interpretation: RequestInterpretation;
    categorySlug: string | null;
    query: string;
    areaId?: number | null;
    lat?: number | null;
    lng?: number | null;
    status?: RequestStatus;
    understoodBy?: string | null;
    reading?: ReadingSummary | null;
    buyerBusinessId?: string | null;
  },
): Promise<RequestRow> {
  const row = await one<RequestRow>(
    db,
    `INSERT INTO requests (contact_id, raw_text, interpretation, category_slug, query, area_id, lat, lng, status, understood_by, reading, buyer_business_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
    [
      r.contactId,
      r.rawText.slice(0, 1000),
      JSON.stringify(r.interpretation),
      r.categorySlug,
      r.query,
      r.areaId ?? null,
      r.lat ?? null,
      r.lng ?? null,
      r.status ?? "open",
      r.understoodBy ?? null,
      r.reading ? JSON.stringify(r.reading) : null,
      r.buyerBusinessId ?? null,
    ],
  );
  return row!;
}

/** The customer said a request's results weren't what they asked for: it goes to the team's weekly check. */
export async function flagRequest(db: Db, requestId: string): Promise<void> {
  if (!isUuid(requestId)) return;
  await db.query("UPDATE requests SET flagged_at = COALESCE(flagged_at, now()) WHERE id = $1", [requestId]);
}

/** We asked "Did you mean…?" with these categories. Returns the question's ID. */
export async function recordQuestion(db: Db, q: { contactId: string; signature: string | null; options: string[] }): Promise<string> {
  const row = await one<{ id: string }>(
    db,
    "INSERT INTO clarifications (contact_id, signature, options) VALUES ($1, $2, $3) RETURNING id",
    [q.contactId, q.signature, q.options],
  );
  return row!.id;
}

/** What the customer picked: a category slug, or "other" for "Something else". */
export async function recordAnswer(db: Db, questionId: string, chosen: string): Promise<void> {
  if (!isUuid(questionId)) return;
  await db.query("UPDATE clarifications SET chosen = $2, answered_at = now() WHERE id = $1 AND chosen IS NULL", [questionId, chosen]);
}

export async function getRequest(db: Db, id: string): Promise<RequestRow | undefined> {
  if (!isUuid(id)) return undefined;
  return one<RequestRow>(db, "SELECT * FROM requests WHERE id = $1", [id]);
}

export async function setRequestStatus(
  db: Db,
  id: string,
  status: RequestStatus,
  resultCount?: number,
  match?: RequestRow["match"],
  /** How many businesses listed a matching product: 0 lets a later listing send an alert. */
  productMatches?: number,
): Promise<void> {
  await db.query(
    `UPDATE requests SET status = $2, result_count = COALESCE($3, result_count), match = COALESCE($4, match),
            product_matches = COALESCE($5, product_matches)
      WHERE id = $1`,
    [id, status, resultCount ?? null, match ?? null, productMatches ?? null],
  );
}

/** The businesses shown for a request, in order, with the product shown for each. */
export async function saveResults(db: Db, requestId: string, results: { businessId: string; offeringId?: string | null }[]): Promise<void> {
  for (const [rank, r] of results.entries()) {
    await db.query(
      "INSERT INTO request_results (request_id, business_id, rank, offering_id) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING",
      [requestId, r.businessId, rank, r.offeringId ?? null],
    );
  }
}
