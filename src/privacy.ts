import type { Db } from "./db/client.js";
import { one } from "./db/client.js";
import { isUuid } from "./directory/businesses.js";
import type { FileStore } from "./storage.js";

/**
 * Delete everything held about one WhatsApp contact: their messages, requests, introductions and
 * saved chat state. Reports and business tips they sent stay, with the link to them removed.
 * Businesses they own stay listed (see eraseBusiness). Returns what was deleted.
 */
export async function eraseContact(db: Db, contactId: string): Promise<{ messages: number; requests: number } | undefined> {
  if (!isUuid(contactId)) return undefined;
  return db.transaction(async (tx) => {
    const contact = await one<{ id: string; channel: string; wa_id: string }>(tx, "SELECT id, channel, wa_id FROM contacts WHERE id = $1", [
      contactId,
    ]);
    if (!contact) return undefined;
    const messages = (
      await tx.query(
        // Their messages, including any saved but not yet linked to them (so a restart can't bring them back).
        `DELETE FROM messages WHERE contact_id = $1 OR (contact_id IS NULL AND channel = $2 AND sender->>'from' = $3) RETURNING id`,
        [contactId, contact.channel, contact.wa_id],
      )
    ).length;
    const requests = (await tx.query("DELETE FROM requests WHERE contact_id = $1 RETURNING id", [contactId])).length;
    // Messages still waiting to be resent to them.
    await tx.query("DELETE FROM jobs WHERE kind = 'resend' AND status = 'queued' AND payload->>'channel' = $1 AND payload->>'to' = $2", [
      contact.channel,
      contact.wa_id,
    ]);
    // Sessions and introductions go with the contact (ON DELETE CASCADE).
    await tx.query("DELETE FROM contacts WHERE id = $1", [contactId]);
    return { messages, requests };
  });
}

/**
 * Delete a business listing completely: categories, photos (and their files), price list,
 * call-backs and introductions.
 */
export async function eraseBusiness(db: Db, store: FileStore, businessId: string): Promise<boolean> {
  if (!isUuid(businessId)) return false;
  const deleted = await db.transaction(async (tx) => {
    const business = await one<{ phone: string }>(tx, "SELECT phone FROM businesses WHERE id = $1", [businessId]);
    if (!business) return undefined;
    const photos = await tx.query<{ storage_key: string }>("SELECT storage_key FROM business_photos WHERE business_id = $1", [businessId]);
    await tx.query("DELETE FROM businesses WHERE id = $1", [businessId]);
    return photos.map((p) => p.storage_key);
  });
  if (!deleted) return false;
  // Files go after the rows, so a failure here leaves orphaned files rather than broken listings.
  for (const key of deleted) await store.delete(key);
  return true;
}

/** Everything held about one contact, for a data request. */
export async function exportContact(db: Db, contactId: string): Promise<Record<string, unknown> | undefined> {
  if (!isUuid(contactId)) return undefined;
  const contact = await one<Record<string, unknown>>(
    db,
    `SELECT channel, wa_id, phone, profile_name, consent_at, last_inbound_at, is_blocked, blocked_reason, alerts_off_at, stopped_at, created_at
       FROM contacts WHERE id = $1`,
    [contactId],
  );
  if (!contact) return undefined;
  const [messages, requests, shown, introductions, reports, recommendations, businesses, questions, alerts, chat, aiUse] = await Promise.all([
    // Their messages, including any saved but not yet linked to them.
    db.query(
      `SELECT direction, kind, body, notes, created_at FROM messages
        WHERE contact_id = $1 OR (contact_id IS NULL AND channel = $2 AND sender->>'from' = $3) ORDER BY created_at`,
      [contactId, contact.channel, contact.wa_id],
    ),
    db.query(
      `SELECT r.raw_text, r.query, r.category_slug, a.name AS area, r.lat, r.lng, r.status, r.created_at
         FROM requests r LEFT JOIN areas a ON a.id = r.area_id WHERE r.contact_id = $1 ORDER BY r.created_at`,
      [contactId],
    ),
    // The businesses we showed them for each request.
    db.query(
      `SELECT r.created_at AS request_at, b.name AS business, rr.rank
         FROM request_results rr JOIN requests r ON r.id = rr.request_id JOIN businesses b ON b.id = rr.business_id
        WHERE r.contact_id = $1 ORDER BY r.created_at, rr.rank`,
      [contactId],
    ),
    db.query(
      `SELECT i.ref_code, b.name AS business, i.outcome, i.rating, i.created_at
         FROM introductions i JOIN businesses b ON b.id = i.business_id WHERE i.contact_id = $1 ORDER BY i.created_at`,
      [contactId],
    ),
    db.query(
      `SELECT b.name AS business, rp.reason, rp.status, rp.created_at
         FROM reports rp JOIN businesses b ON b.id = rp.business_id WHERE rp.contact_id = $1 ORDER BY rp.created_at`,
      [contactId],
    ),
    db.query("SELECT name, what, area_text, phone, status, created_at FROM recommendations WHERE contact_id = $1 ORDER BY created_at", [contactId]),
    db.query(
      `SELECT name, phone, description, status, verification, created_at FROM businesses WHERE owner_contact_id = $1 ORDER BY created_at`,
      [contactId],
    ),
    // "Did you mean…?" questions we asked them, and what they picked.
    db.query("SELECT options, chosen, created_at FROM clarifications WHERE contact_id = $1 ORDER BY created_at", [contactId]),
    // Alerts we sent them about stores that listed what they asked for.
    db.query(
      `SELECT b.name AS business, o.name AS product, pa.created_at
         FROM product_alerts pa JOIN businesses b ON b.id = pa.business_id LEFT JOIN offerings o ON o.id = pa.offering_id
        WHERE pa.contact_id = $1 ORDER BY pa.created_at`,
      [contactId],
    ),
    // Where their chat with us had got to.
    db.query("SELECT state, updated_at FROM sessions WHERE contact_id = $1", [contactId]),
    // When Claude read one of their messages (no text is kept there).
    db.query("SELECT feature, model, created_at FROM ai_usage WHERE contact_id = $1 ORDER BY created_at", [contactId]),
  ]);
  return {
    exported_at: new Date().toISOString(),
    contact,
    messages,
    requests,
    businesses_shown: shown,
    introductions,
    reports,
    recommendations,
    businesses,
    questions,
    alerts,
    chat_state: chat[0] ?? null,
    ai_use: aiUse,
  };
}

export interface RetentionResult {
  messages: number;
  requests: number;
  questions: number;
  sessions: number;
  jobs: number;
  opsSessions: number;
  /** Expired dashboard sessions and sign-in links, and website registrations never finished. */
  ownerSessions: number;
  loginLinks: number;
  webRegistrations: number;
  /** People who haven't written for a long time: their number and name removed. */
  idleContacts: number;
  alerts: number;
  codeAttempts: number;
}

/**
 * The daily clean-up. Chats are kept for `messageDays`; requests keep their category, area and
 * outcome for statistics, but lose the customer's words, search phrase and shared location (and
 * what the engine noted about them) after `requestDays`, when "Did you mean…?" questions and the
 * alerts we sent go too. Someone who hasn't written for `requestDays` loses their number and
 * name, unless they manage a listing, are blocked, or wait for a person. Idle chat state,
 * finished jobs and expired sessions go as well.
 */
export async function applyRetention(db: Db, now: Date, keep: { messageDays: number; requestDays: number }): Promise<RetentionResult> {
  const daysAgo = (days: number) => new Date(now.getTime() - days * 24 * 3600_000);
  const count = async (sql: string, params: unknown[]) => (await db.query(sql, params)).length;
  return {
    messages: await count("DELETE FROM messages WHERE created_at < $1 RETURNING id", [daysAgo(keep.messageDays)]),
    requests: await count(
      `UPDATE requests SET raw_text = '', query = '', interpretation = '{}'::jsonb, reading = NULL, lat = NULL, lng = NULL
        WHERE created_at < $1 AND (raw_text <> '' OR query <> '' OR lat IS NOT NULL) RETURNING id`,
      [daysAgo(keep.requestDays)],
    ),
    questions: await count("DELETE FROM clarifications WHERE created_at < $1 RETURNING id", [daysAgo(keep.requestDays)]),
    // A chat waiting for a person is kept however old it is.
    sessions: await count(
      "DELETE FROM sessions WHERE updated_at < $1 AND COALESCE(state->>'stage', '') <> 'handoff' RETURNING contact_id",
      [daysAgo(90)],
    ),
    jobs: await count("DELETE FROM jobs WHERE status IN ('done', 'failed') AND created_at < $1 RETURNING id", [daysAgo(30)]),
    opsSessions: await count("DELETE FROM ops_sessions WHERE expires_at < $1 RETURNING token_hash", [now]),
    ownerSessions: await count("DELETE FROM owner_sessions WHERE expires_at < $1 RETURNING token_hash", [now]),
    loginLinks: await count("DELETE FROM owner_login_links WHERE expires_at < $1 RETURNING token_hash", [daysAgo(1)]),
    webRegistrations: await count(
      "DELETE FROM web_registrations WHERE completed_at IS NULL AND expires_at < $1 RETURNING id",
      [daysAgo(7)],
    ),
    // The row stays, anonymous, so the statistics it's part of stay whole. If they write again,
    // they start afresh as someone new.
    idleContacts: await count(
      `UPDATE contacts c SET wa_id = 'gone-' || c.id::text, phone = NULL, profile_name = NULL
        WHERE c.last_inbound_at < $1 AND c.wa_id NOT LIKE 'gone-%' AND NOT c.is_blocked
          AND NOT EXISTS (SELECT 1 FROM businesses b WHERE b.owner_contact_id = c.id AND b.status <> 'removed')
          AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.contact_id = c.id AND s.state->>'stage' = 'handoff')
        RETURNING c.id`,
      [daysAgo(keep.requestDays)],
    ),
    alerts: await count("DELETE FROM product_alerts WHERE created_at < $1 RETURNING id", [daysAgo(keep.requestDays)]),
    codeAttempts: await count("DELETE FROM code_attempts WHERE created_at < $1 RETURNING sender", [daysAgo(7)]),
  };
}
