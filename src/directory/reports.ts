import type { Db } from "../db/client.js";
import { one } from "../db/client.js";
import { isUuid, markCatalogDirty } from "./businesses.js";

/** Reports this customer has made since `since`, for the daily limit. */
export async function reportsSince(db: Db, contactId: string, since: Date): Promise<number> {
  const row = await one<{ n: number }>(db, "SELECT count(*)::int AS n FROM reports WHERE contact_id = $1 AND created_at > $2", [
    contactId,
    since,
  ]);
  return row?.n ?? 0;
}

/**
 * Store a customer's report. It counts for more when they contacted the business through us.
 * When `pauseAfter` different customers who did so have open reports within 30 days, the
 * listing is paused until the team looks at it; one angry customer or a rival can't do that alone.
 */
export async function fileReport(
  db: Db,
  r: { contactId: string; businessId: string; reason: string },
  pauseAfter: number,
): Promise<{ paused: boolean; businessName: string } | undefined> {
  if (!isUuid(r.businessId)) return undefined;
  return db.transaction(async (tx) => {
    const business = await one<{ name: string; status: string }>(tx, "SELECT name, status FROM businesses WHERE id = $1", [r.businessId]);
    if (!business) return undefined;
    await tx.query(
      `INSERT INTO reports (contact_id, business_id, reason, had_introduction)
       VALUES ($1, $2, $3, EXISTS (SELECT 1 FROM introductions WHERE contact_id = $1 AND business_id = $2))`,
      [r.contactId, r.businessId, r.reason.slice(0, 1000)],
    );
    if (pauseAfter <= 0 || business.status !== "active") return { paused: false, businessName: business.name };
    const credible = await one<{ n: number }>(
      tx,
      `SELECT count(DISTINCT contact_id)::int AS n FROM reports
        WHERE business_id = $1 AND had_introduction AND status = 'open' AND created_at > now() - interval '30 days'`,
      [r.businessId],
    );
    if ((credible?.n ?? 0) < pauseAfter) return { paused: false, businessName: business.name };
    await tx.query("UPDATE businesses SET status = 'paused', paused_by = 'system', updated_at = now() WHERE id = $1", [r.businessId]);
    await markCatalogDirty(tx, r.businessId);
    await tx.query(
      "INSERT INTO ops_audit (actor, action, target, details) VALUES ('system', 'business.auto_pause', $1, $2)",
      [r.businessId, JSON.stringify({ reports: credible?.n })],
    );
    return { paused: true, businessName: business.name };
  });
}
