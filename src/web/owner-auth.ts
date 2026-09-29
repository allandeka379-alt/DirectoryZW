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

/** The link we send on WhatsApp. The page trades the token for a session with a POST, so link previews can't use it up. */
export function signInUrl(publicBaseUrl: string, token: string): string {
  return `${publicBaseUrl}/app/?signin=${encodeURIComponent(token)}`;
}

export async function createLoginLink(db: Db, contactId: string, now: Date): Promise<string> {
  const token = newToken();
  await db.query("INSERT INTO owner_login_links (token_hash, contact_id, expires_at) VALUES ($1, $2, $3)", [
    hash(token),
    contactId,
    new Date(now.getTime() + LOGIN_LINK_MINUTES * 60_000),
  ]);
  return token;
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
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return "";
}

export function sessionCookie(token: string, secure: boolean, maxAgeSeconds = OWNER_SESSION_DAYS * 24 * 3600): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/app; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? "; Secure" : ""}`;
}
