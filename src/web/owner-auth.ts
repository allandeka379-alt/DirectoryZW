import crypto from "node:crypto";
import type { Db } from "../db/client.js";
import { one } from "../db/client.js";

/** A sign-in link works once, for this long. */
export const LOGIN_LINK_MINUTES = 15;
/** How long a dashboard session lasts without signing in again. */
export const OWNER_SESSION_DAYS = 30;
export const SESSION_COOKIE = "dz_owner";

export interface Owner {
  contactId: string;
  phone: string | null;
  name: string | null;
}

function hash(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function newToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

/**
 * The link we send on WhatsApp. The page trades the token for a session with a POST, so link
 * previews can't use it up. The token goes after "#", which browsers never send to a server, so
 * it stays out of every request log on the way.
 */
export function signInUrl(publicBaseUrl: string, token: string): string {
  return `${publicBaseUrl}/app/#signin=${encodeURIComponent(token)}`;
}

export async function createLoginLink(db: Db, contactId: string, now: Date, minutes = LOGIN_LINK_MINUTES): Promise<string> {
  const token = newToken();
  await db.query("INSERT INTO owner_login_links (token_hash, contact_id, expires_at) VALUES ($1, $2, $3)", [
    hash(token),
    contactId,
    new Date(now.getTime() + minutes * 60_000),
  ]);
  return token;
}

/** How long a sign-in link the team hands to an owner works: long enough to reach them. */
export const TEAM_LINK_HOURS = 24;

/**
 * The contact that manages a business: its owner, or, for a listing nobody has claimed yet, a
 * contact for the business's own number, which becomes its owner. When that number messages us on
 * WhatsApp, it's the same contact.
 */
export async function ownerContactFor(db: Db, b: { id: string; phone: string; owner_contact_id: string | null }): Promise<string> {
  if (b.owner_contact_id) return b.owner_contact_id;
  const contact = await one<{ id: string }>(
    db,
    `INSERT INTO contacts (channel, wa_id, phone) VALUES ('business', $1, $1)
     ON CONFLICT (channel, wa_id) DO UPDATE SET phone = COALESCE(contacts.phone, excluded.phone)
     RETURNING id`,
    [b.phone],
  );
  await db.query("UPDATE businesses SET owner_contact_id = $2 WHERE id = $1 AND owner_contact_id IS NULL", [b.id, contact!.id]);
  const owner = await one<{ owner_contact_id: string }>(db, "SELECT owner_contact_id FROM businesses WHERE id = $1", [b.id]);
  return owner!.owner_contact_id;
}

/** Use a sign-in link: the owner's contact ID, once, while it is fresh. */
export async function useLoginLink(db: Db, token: string, now: Date): Promise<string | undefined> {
  if (!token || token.length > 200) return undefined;
  const row = await one<{ contact_id: string }>(
    db,
    `UPDATE owner_login_links SET used_at = $2
      WHERE token_hash = $1 AND used_at IS NULL AND expires_at > $2
      RETURNING contact_id`,
    [hash(token), now],
  );
  return row?.contact_id;
}

export async function createOwnerSession(db: Db, contactId: string, now: Date): Promise<string> {
  const token = newToken();
  await db.query("INSERT INTO owner_sessions (token_hash, contact_id, expires_at) VALUES ($1, $2, $3)", [
    hash(token),
    contactId,
    new Date(now.getTime() + OWNER_SESSION_DAYS * 24 * 3600_000),
  ]);
  return token;
}

/** Who a session cookie belongs to, if it is still valid and the contact isn't blocked. */
export async function ownerForSession(db: Db, token: string, now: Date): Promise<Owner | undefined> {
  if (!token || token.length > 200) return undefined;
  const row = await one<{ contact_id: string; phone: string | null; profile_name: string | null }>(
    db,
    `SELECT s.contact_id, c.phone, c.profile_name
       FROM owner_sessions s JOIN contacts c ON c.id = s.contact_id
      WHERE s.token_hash = $1 AND s.expires_at > $2 AND NOT c.is_blocked`,
    [hash(token), now],
  );
  return row ? { contactId: row.contact_id, phone: row.phone, name: row.profile_name } : undefined;
}

export async function endOwnerSession(db: Db, token: string): Promise<void> {
  if (token) await db.query("DELETE FROM owner_sessions WHERE token_hash = $1", [hash(token)]);
}

/** Read one cookie from a Cookie header. */
export function readCookie(header: string | undefined, name: string): string {
  if (!header) return "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k !== name) continue;
    try {
      return decodeURIComponent(v.join("="));
    } catch {
      // A mangled cookie is no session, not a server error.
      return "";
    }
  }
  return "";
}

export function sessionCookie(token: string, secure: boolean, maxAgeSeconds = OWNER_SESSION_DAYS * 24 * 3600): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/app; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? "; Secure" : ""}`;
}
