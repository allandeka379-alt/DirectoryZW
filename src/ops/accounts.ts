import crypto from "node:crypto";
import { promisify } from "node:util";
import type { Db } from "../db/client.js";
import { one } from "../db/client.js";
import { isUuid } from "../directory/businesses.js";
import { hashToken, newToken } from "../field/agents.js";

export type Role = "admin" | "staff";
export const ROLES = ["admin", "staff"] as const;

/** Who is using the ops console or API. */
export interface Actor {
  /** Null for the shared OPS_TOKEN and the development login. */
  userId: string | null;
  name: string;
  role: Role;
}

export interface OpsUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  active: boolean;
  created_at: Date;
  last_login_at: Date | null;
}

const USER_COLUMNS = "id, name, email, role, active, created_at, last_login_at";
export const MIN_PASSWORD_LENGTH = 10;

const scrypt = promisify(crypto.scrypt) as (password: string, salt: Buffer, keylen: number, options: crypto.ScryptOptions) => Promise<Buffer>;
const SCRYPT = { N: 16384, r: 8, p: 1 };

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password.normalize("NFKC"), salt, 64, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, salt, hash] = stored.split("$");
  if (alg !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const key = await scrypt(password.normalize("NFKC"), Buffer.from(salt, "base64"), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });
  return crypto.timingSafeEqual(key, expected);
}

/** A readable one-time password for a new account: 4 groups of 4, e.g. "k7qm-2xpd-9wfr-h3tn". */
export function generatePassword(): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const chars = Array.from(crypto.randomBytes(16), (b) => alphabet[b % alphabet.length]);
  return [0, 4, 8, 12].map((i) => chars.slice(i, i + 4).join("")).join("-");
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function createUser(
  db: Db,
  input: { name: string; email: string; role: Role; password: string },
): Promise<OpsUser> {
  const user = await one<OpsUser>(
    db,
    `INSERT INTO ops_users (name, email, role, password_hash) VALUES ($1, $2, $3, $4) RETURNING ${USER_COLUMNS}`,
    [input.name.trim(), normalizeEmail(input.email), input.role, await hashPassword(input.password)],
  );
  return user!;
}

export async function listUsers(db: Db): Promise<OpsUser[]> {
  return db.query<OpsUser>(`SELECT ${USER_COLUMNS} FROM ops_users ORDER BY active DESC, name`);
}

export async function hasUsers(db: Db): Promise<boolean> {
  return !!(await one(db, "SELECT 1 FROM ops_users LIMIT 1"));
}

/** Change role, active flag or password. Deactivating or a new password signs the person out everywhere. */
export async function updateUser(
  db: Db,
  id: string,
  changes: { role?: Role; active?: boolean; password?: string; name?: string },
): Promise<OpsUser | undefined> {
  if (!isUuid(id)) return undefined;
  const hash = changes.password ? await hashPassword(changes.password) : null;
  const user = await one<OpsUser>(
    db,
    `UPDATE ops_users SET role = COALESCE($2, role), active = COALESCE($3, active),
            password_hash = COALESCE($4, password_hash), name = COALESCE($5, name)
      WHERE id = $1 RETURNING ${USER_COLUMNS}`,
    [id, changes.role ?? null, changes.active ?? null, hash, changes.name?.trim() || null],
  );
  if (user && (changes.active === false || changes.password)) {
    await db.query("DELETE FROM ops_sessions WHERE user_id = $1", [id]);
  }
  return user;
}

// A real hash to check against when the email is unknown, so timing doesn't reveal which emails exist.
let dummyHash: Promise<string> | undefined;

/** Check an email and password; on success start a session. The token goes to the browser once. */
export async function login(
  db: Db,
  email: string,
  password: string,
  sessionHours: number,
): Promise<{ token: string; user: OpsUser } | undefined> {
  const row = await one<OpsUser & { password_hash: string }>(
    db,
    `SELECT ${USER_COLUMNS}, password_hash FROM ops_users WHERE email = $1 AND active`,
    [normalizeEmail(email)],
  );
  if (!row) {
    await verifyPassword(password, await (dummyHash ??= hashPassword(crypto.randomUUID())));
    return undefined;
  }
  if (!(await verifyPassword(password, row.password_hash))) return undefined;
  const token = newToken();
  await db.query("INSERT INTO ops_sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + make_interval(hours => $3))", [
    hashToken(token),
    row.id,
    sessionHours,
  ]);
  await db.query("UPDATE ops_users SET last_login_at = now() WHERE id = $1", [row.id]);
  const { password_hash: _, ...user } = row;
  return { token, user };
}

/** Check someone's current password, e.g. before they change it. */
export async function checkPassword(db: Db, userId: string, password: string): Promise<boolean> {
  const row = await one<{ password_hash: string }>(db, "SELECT password_hash FROM ops_users WHERE id = $1 AND active", [userId]);
  return !!row && (await verifyPassword(password, row.password_hash));
}

export async function logout(db: Db, token: string): Promise<void> {
  await db.query("DELETE FROM ops_sessions WHERE token_hash = $1", [hashToken(token)]);
}

/** The person a session token belongs to, if the session is live and the account active. */
export async function actorForSession(db: Db, token: string): Promise<Actor | undefined> {
  if (!token || token.length < 20) return undefined;
  const row = await one<{ id: string; name: string; role: Role }>(
    db,
    `SELECT u.id, u.name, u.role FROM ops_sessions s JOIN ops_users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now() AND u.active`,
    [hashToken(token)],
  );
  return row ? { userId: row.id, name: row.name, role: row.role } : undefined;
}

/** Record who did what. Never put message text or other personal details in `details`. */
export async function logAction(
  db: Db,
  actor: Actor,
  action: string,
  target?: string | null,
  details: Record<string, unknown> = {},
): Promise<void> {
  await db.query("INSERT INTO ops_audit (user_id, actor, action, target, details) VALUES ($1, $2, $3, $4, $5)", [
    actor.userId,
    actor.name,
    action,
    target ?? null,
    JSON.stringify(details),
  ]);
}

/** Slows down password guessing: after 5 failures for an email, it's locked for 15 minutes. */
export class LoginThrottle {
  private readonly failures = new Map<string, { count: number; since: number }>();

  constructor(
    private readonly now: () => Date = () => new Date(),
    private readonly maxFailures = 5,
    private readonly windowMs = 15 * 60_000,
  ) {}

  blocked(email: string): boolean {
    const f = this.failures.get(normalizeEmail(email));
    if (!f) return false;
    if (this.now().getTime() - f.since > this.windowMs) {
      this.failures.delete(normalizeEmail(email));
      return false;
    }
    return f.count >= this.maxFailures;
  }

  failed(email: string): void {
    const key = normalizeEmail(email);
    const f = this.failures.get(key);
    if (!f || this.now().getTime() - f.since > this.windowMs) this.failures.set(key, { count: 1, since: this.now().getTime() });
    else f.count++;
  }

  succeeded(email: string): void {
    this.failures.delete(normalizeEmail(email));
  }
}
