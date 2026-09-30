import type { Db } from "../db/client.js";
import { one } from "../db/client.js";
import { isUuid, markCatalogDirty } from "../directory/businesses.js";

export const AUDIT_OUTCOMES = ["confirmed", "details_wrong", "wrong_number", "not_a_business", "refused"] as const;
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

export interface AuditCandidate {
  id: string;
  name: string;
  phone: string;
  verification: string;
  area: string | null;
  agent_id: string;
  agent: string;
  created_at: Date;
}

/**
 * Field registrations to phone back and check: a random share of each agent's recent,
 * unaudited registrations, at least one per agent.
 */
export async function auditQueue(db: Db, opts: { days: number; percent: number; limit: number }): Promise<AuditCandidate[]> {
  return db.query<AuditCandidate>(
    `WITH candidates AS (
       SELECT b.id, b.name, b.phone, b.verification, ar.name AS area, a.id AS agent_id, a.name AS agent, b.created_at,
              row_number() OVER (PARTITION BY b.registered_by ORDER BY random()) AS pick,
              count(*) OVER (PARTITION BY b.registered_by) AS total
         FROM businesses b
         JOIN agents a ON a.id = b.registered_by
         LEFT JOIN areas ar ON ar.id = b.area_id
        WHERE b.audit_status IS NULL AND b.status <> 'removed'
          AND b.created_at > now() - make_interval(days => $1))
     SELECT id, name, phone, verification, area, agent_id, agent, created_at FROM candidates
      WHERE pick <= GREATEST(1, ceil(total * $2::float8 / 100.0))
      ORDER BY agent, created_at LIMIT $3`,
    [opts.days, opts.percent, opts.limit],
  );
}

/**
 * Record a call-back result. A wrong number or "not a business" hides the listing until someone fixes it.
 * Returns false if the business doesn't exist.
 */
export async function recordAudit(
  db: Db,
  businessId: string,
  audit: { outcome: AuditOutcome; note?: string; by: string },
): Promise<boolean> {
  if (!isUuid(businessId)) return false;
  return db.transaction(async (tx) => {
    const business = await one<{ registered_by: string | null }>(tx, "SELECT registered_by FROM businesses WHERE id = $1", [businessId]);
    if (!business) return false;
    await tx.query("INSERT INTO audits (business_id, agent_id, outcome, note, audited_by) VALUES ($1, $2, $3, $4, $5)", [
      businessId,
      business.registered_by,
      audit.outcome,
      audit.note ?? null,
      audit.by,
    ]);
    const hide = audit.outcome === "wrong_number" || audit.outcome === "not_a_business";
    await tx.query(
      `UPDATE businesses SET audit_status = $2, status = CASE WHEN $3 THEN 'paused' ELSE status END,
              paused_by = CASE WHEN $3 THEN 'team' ELSE paused_by END, updated_at = now()
        WHERE id = $1`,
      [businessId, audit.outcome === "confirmed" ? "passed" : "failed", hide],
    );
    if (hide) await markCatalogDirty(tx, businessId);
    return true;
  });
}
