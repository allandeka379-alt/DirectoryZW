import type { Db } from "../db/client.js";
import { one } from "../db/client.js";
import { isUuid } from "../directory/businesses.js";
import type { RequestInterpretation } from "../ai/types.js";
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
  return row!;
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

/** Store an inbound message. Returns its row ID, or null if WhatsApp already delivered it. */
export async function logInbound(db: Db, m: InboundMessage): Promise<string | null> {
  const row = await one<{ id: string }>(
    db,
    `INSERT INTO messages (channel, direction, wa_message_id, kind, body) VALUES ($1, 'in', $2, $3, $4)
     ON CONFLICT DO NOTHING RETURNING id`,
    [m.channel, m.waMessageId, m.content.type, JSON.stringify(m.content)],
  );
  return row?.id ?? null;
}

export async function attachMessage(db: Db, messageId: string, contactId: string): Promise<void> {
  await db.query("UPDATE messages SET contact_id = $2 WHERE id = $1", [messageId, contactId]);
}

export async function logOutbound(
  db: Db,
  contactId: string | null,
  channel: Channel,
  waMessageId: string | null,
  msg: OutboundMessage,
  status = "sent",
): Promise<void> {
  await db.query(
    `INSERT INTO messages (contact_id, channel, direction, wa_message_id, kind, body, status)
     VALUES ($1, $2, 'out', $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
    [contactId, channel, waMessageId, msg.kind, JSON.stringify({ text: describe(msg), message: msg }), status],
  );
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
  },
): Promise<RequestRow> {
  const row = await one<RequestRow>(
    db,
    `INSERT INTO requests (contact_id, raw_text, interpretation, category_slug, query, area_id, lat, lng, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
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
    ],
  );
  return row!;
}

export async function getRequest(db: Db, id: string): Promise<RequestRow | undefined> {
  if (!isUuid(id)) return undefined;
  return one<RequestRow>(db, "SELECT * FROM requests WHERE id = $1", [id]);
}

export async function setRequestStatus(db: Db, id: string, status: RequestStatus, resultCount?: number): Promise<void> {
  await db.query("UPDATE requests SET status = $2, result_count = COALESCE($3, result_count) WHERE id = $1", [
    id,
    status,
    resultCount ?? null,
  ]);
}

export async function saveResults(db: Db, requestId: string, businessIds: string[]): Promise<void> {
  for (const [rank, businessId] of businessIds.entries()) {
    await db.query(
      "INSERT INTO request_results (request_id, business_id, rank) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
      [requestId, businessId, rank],
    );
  }
}

export async function createReport(db: Db, contactId: string, businessId: string, reason: string): Promise<void> {
  if (!isUuid(businessId)) return;
  await db.query("INSERT INTO reports (contact_id, business_id, reason) VALUES ($1, $2, $3)", [
    contactId,
    businessId,
    reason.slice(0, 1000),
  ]);
}
