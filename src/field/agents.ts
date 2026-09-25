import crypto from "node:crypto";
import type { Db } from "../db/client.js";
import { one } from "../db/client.js";
import { isUuid } from "../directory/businesses.js";

export interface Agent {
  id: string;
  name: string;
  phone: string | null;
  city: string | null;
  active: boolean;
  created_at: Date;
  last_seen_at: Date | null;
}

const PUBLIC_COLUMNS = "id, name, phone, city, active, created_at, last_seen_at";

export function newToken(): string {
  return crypto.randomBytes(24).toString("base64url");
}

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/** The link a team lead sends to a new agent. The token sits after "#", so it never reaches server logs. */
export function setupUrl(publicBaseUrl: string, token: string): string {
  return `${publicBaseUrl}/field/#token=${token}`;
}

export async function createAgent(
  db: Db,
  input: { name: string; phone?: string | null; city?: string | null },
): Promise<{ agent: Agent; token: string }> {
  const token = newToken();
  const agent = await one<Agent>(
    db,
    `INSERT INTO agents (name, phone, city, token_hash) VALUES ($1, $2, $3, $4) RETURNING ${PUBLIC_COLUMNS}`,
    [input.name.trim(), input.phone ?? null, input.city ?? null, hashToken(token)],
  );
  return { agent: agent!, token };
}

/** The active agent a token belongs to, if any. Records when they were last seen. */
export async function agentByToken(db: Db, token: string): Promise<Agent | undefined> {
  if (!token || token.length < 20) return undefined;
  return one<Agent>(
    db,
    `UPDATE agents SET last_seen_at = now() WHERE token_hash = $1 AND active RETURNING ${PUBLIC_COLUMNS}`,
    [hashToken(token)],
  );
}

export async function getAgent(db: Db, id: string): Promise<Agent | undefined> {
  if (!isUuid(id)) return undefined;
  return one<Agent>(db, `SELECT ${PUBLIC_COLUMNS} FROM agents WHERE id = $1`, [id]);
}

/** Issue a new token; the old setup link stops working. */
export async function resetAgentToken(db: Db, id: string): Promise<string | undefined> {
  if (!isUuid(id)) return undefined;
  const token = newToken();
  const rows = await db.query("UPDATE agents SET token_hash = $2 WHERE id = $1 RETURNING id", [id, hashToken(token)]);
  return rows.length ? token : undefined;
}

export async function setAgentActive(db: Db, id: string, active: boolean): Promise<boolean> {
  if (!isUuid(id)) return false;
  const rows = await db.query("UPDATE agents SET active = $2 WHERE id = $1 RETURNING id", [id, active]);
  return rows.length > 0;
}

export interface AgentStats extends Agent {
  registered_7d: number;
  registered_30d: number;
  verified_30d: number;
  audits_passed: number;
  audits_failed: number;
  /** Businesses this agent registered that have since been connected with at least one customer. */
  with_customers: number;
}

export async function agentStats(db: Db): Promise<AgentStats[]> {
  return db.query<AgentStats>(
    `SELECT a.id, a.name, a.phone, a.city, a.active, a.created_at, a.last_seen_at,
       (SELECT count(*)::int FROM businesses b WHERE b.registered_by = a.id AND b.created_at > now() - interval '7 days') AS registered_7d,
       (SELECT count(*)::int FROM businesses b WHERE b.registered_by = a.id AND b.created_at > now() - interval '30 days') AS registered_30d,
       (SELECT count(*)::int FROM businesses b WHERE b.registered_by = a.id AND b.verification = 'verified'
          AND b.created_at > now() - interval '30 days') AS verified_30d,
       (SELECT count(*)::int FROM audits au WHERE au.agent_id = a.id AND au.outcome = 'confirmed') AS audits_passed,
       (SELECT count(*)::int FROM audits au WHERE au.agent_id = a.id AND au.outcome <> 'confirmed') AS audits_failed,
       (SELECT count(DISTINCT i.business_id)::int FROM introductions i JOIN businesses b ON b.id = i.business_id
         WHERE b.registered_by = a.id) AS with_customers
     FROM agents a ORDER BY a.active DESC, a.name`,
  );
}
