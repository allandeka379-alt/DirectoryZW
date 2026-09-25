import type { Db } from "../db/client.js";
import { one } from "../db/client.js";
import { isUuid } from "./businesses.js";

/**
 * Keeping the promise the welcome message makes: businesses we verify are genuine and reliable,
 * and we look into every report. Customers' follow-up answers become a track record, verified
 * businesses that keep letting customers down go back to the field team, and reports can't sit
 * unread.
 */

/** Track records cover customers connected in this many days. */
export const TRACK_RECORD_DAYS = 90;
/** A track record is shown to customers only from this many answers, so one or two don't define a business. */
export const TRACK_RECORD_MIN = 5;

export interface TrackRecord {
  /** Customers who told us how it went: sorted, couldn't help or didn't reply ("not yet" isn't an answer). */
  answered: number;
  sorted: number;
  couldntHelp: number;
  noReply: number;
}

export async function trackRecord(db: Db, businessId: string): Promise<TrackRecord> {
  const row = await one<{ sorted: number; couldnt_help: number; no_reply: number }>(
    db,
    `SELECT count(*) FILTER (WHERE outcome = 'sorted')::int AS sorted,
            count(*) FILTER (WHERE outcome = 'couldnt_help')::int AS couldnt_help,
            count(*) FILTER (WHERE outcome = 'no_reply')::int AS no_reply
       FROM introductions
      WHERE business_id = $1 AND created_at > now() - make_interval(days => $2)`,
    [businessId, TRACK_RECORD_DAYS],
  );
  const sorted = row?.sorted ?? 0;
  const couldntHelp = row?.couldnt_help ?? 0;
  const noReply = row?.no_reply ?? 0;
  return { answered: sorted + couldntHelp + noReply, sorted, couldntHelp, noReply };
}

// ---------- Re-checks ----------

/** Verification is looked at again after this long. */
export const REVERIFY_AFTER_MONTHS = 12;

export const RECHECK_OUTCOMES = ["still_good", "unverified", "paused"] as const;
export type RecheckOutcome = (typeof RECHECK_OUTCOMES)[number];

export interface RecheckCandidate {
  id: string;
  name: string;
  phone: string;
  status: string;
  area: string | null;
  city: string | null;
  verified_at: Date | null;
  last_recheck: Date | null;
  /** Why it's on the list, most serious first. */
  reasons: string[];
}

interface CandidateRow {
  id: string;
  name: string;
  phone: string;
  status: string;
  area: string | null;
  city: string | null;
  verified_at: Date | null;
  rating_sum: number;
  rating_count: number;
  answered: number;
  sorted: number;
  no_reply_30d: number;
  open_reports: number;
  last_recheck: Date | null;
  last_report: Date | null;
}

/**
 * Verified businesses for the field team to look at again (visit or phone), and why:
 * - open reports from customers
 * - fewer than half the customers who answered the follow-up got what they needed (3 answers or more)
 * - two or more customers said they didn't reply, in the last 30 days
 * - an average rating under 3 from 3 or more customers
 * - verified more than a year ago
 * A business re-checked in the last 30 days only comes back for a report filed since.
 */
export async function recheckQueue(db: Db): Promise<RecheckCandidate[]> {
  const rows = await db.query<CandidateRow>(
    `SELECT b.id, b.name, b.phone, b.status, a.name AS area, a.city, b.verified_at, b.rating_sum, b.rating_count,
            (SELECT count(*)::int FROM introductions i WHERE i.business_id = b.id AND i.outcome IN ('sorted', 'couldnt_help', 'no_reply')
                AND i.created_at > now() - make_interval(days => $1)) AS answered,
            (SELECT count(*)::int FROM introductions i WHERE i.business_id = b.id AND i.outcome = 'sorted'
                AND i.created_at > now() - make_interval(days => $1)) AS sorted,
            (SELECT count(*)::int FROM introductions i WHERE i.business_id = b.id AND i.outcome = 'no_reply'
                AND i.created_at > now() - interval '30 days') AS no_reply_30d,
            (SELECT count(*)::int FROM reports r WHERE r.business_id = b.id AND r.status = 'open') AS open_reports,
            (SELECT max(r.created_at) FROM reports r WHERE r.business_id = b.id AND r.status = 'open') AS last_report,
            (SELECT max(rc.created_at) FROM rechecks rc WHERE rc.business_id = b.id) AS last_recheck
       FROM businesses b LEFT JOIN areas a ON a.id = b.area_id
      WHERE b.verification = 'verified' AND b.status IN ('active', 'paused')`,
    [TRACK_RECORD_DAYS],
  );
  const now = Date.now();
  const recently = (d: Date | null, days: number) => d != null && now - new Date(d).getTime() < days * 24 * 3600_000;
  const candidates: RecheckCandidate[] = [];
  for (const r of rows) {
    const newReport = r.last_report != null && (r.last_recheck == null || new Date(r.last_report) > new Date(r.last_recheck));
    if (recently(r.last_recheck, 30) && !newReport) continue;
    const reasons: string[] = [];
    if (r.open_reports) reasons.push(`${r.open_reports} open report${r.open_reports === 1 ? "" : "s"} from customers`);
    if (r.answered >= 3 && r.sorted * 2 < r.answered) reasons.push(`Only ${r.sorted} of ${r.answered} customers got what they needed`);
    if (r.no_reply_30d >= 2) reasons.push(`${r.no_reply_30d} customers said they didn't reply, in the last 30 days`);
    if (r.rating_count >= 3 && r.rating_sum / r.rating_count < 3) {
      reasons.push(`Rated ${(r.rating_sum / r.rating_count).toFixed(1)} on average by ${r.rating_count} customers`);
    }
    const monthsAgo = r.verified_at ? (now - new Date(r.verified_at).getTime()) / (30.44 * 24 * 3600_000) : null;
    if (monthsAgo != null && monthsAgo >= REVERIFY_AFTER_MONTHS && !recently(r.last_recheck, 365)) {
      reasons.push(`Verified ${Math.floor(monthsAgo)} months ago`);
    }
    if (!reasons.length) continue;
    candidates.push({
      id: r.id,
      name: r.name,
      phone: r.phone,
      status: r.status,
      area: r.area,
      city: r.city,
      verified_at: r.verified_at,
      last_recheck: r.last_recheck,
      reasons,
    });
  }
  // Reports first, then the rest by how many reasons.
  const reported = (c: RecheckCandidate) => (c.reasons[0]?.includes("report") ? 1 : 0);
  return candidates.sort((a, b) => reported(b) - reported(a) || b.reasons.length - a.reasons.length || a.name.localeCompare(b.name));
}

/**
 * The field team's verdict after looking again: still good (verification renewed), no longer
 * verified (shown only to fill gaps, with a warning), or paused. The business's open reports
 * have now been looked into, so they're closed: reviewed, or actioned when the tick is removed or
 * the listing paused. Returns false if there's no such business.
 */
export async function recordRecheck(
  db: Db,
  businessId: string,
  r: { outcome: RecheckOutcome; reasons: string[]; note?: string; by: string },
): Promise<boolean> {
  if (!isUuid(businessId)) return false;
  return db.transaction(async (tx) => {
    const business = await one<{ id: string }>(tx, "SELECT id FROM businesses WHERE id = $1", [businessId]);
    if (!business) return false;
    await tx.query("INSERT INTO rechecks (business_id, outcome, reasons, note, checked_by) VALUES ($1, $2, $3, $4, $5)", [
      businessId,
      r.outcome,
      r.reasons,
      r.note ?? null,
      r.by,
    ]);
    if (r.outcome === "still_good") {
      await tx.query("UPDATE businesses SET verified_at = now(), verified_by = $2, updated_at = now() WHERE id = $1", [businessId, r.by]);
    } else if (r.outcome === "unverified") {
      await tx.query(
        "UPDATE businesses SET verification = 'registered', verified_at = NULL, verified_by = NULL, updated_at = now() WHERE id = $1",
        [businessId],
      );
    } else {
      await tx.query("UPDATE businesses SET status = 'paused', updated_at = now() WHERE id = $1", [businessId]);
    }
    await tx.query("UPDATE reports SET status = $2 WHERE business_id = $1 AND status = 'open'", [
      businessId,
      r.outcome === "still_good" ? "reviewed" : "actioned",
    ]);
    return true;
  });
}

// ---------- Reports ----------

/**
 * Open reports that have waited more than a day and haven't been raised yet. They're marked as
 * raised, so the team is reminded about each one once.
 */
export async function reportsWaiting(db: Db): Promise<{ business: string; reason: string }[]> {
  return db.query<{ business: string; reason: string }>(
    `UPDATE reports rp SET reminded_at = now()
       FROM businesses b
      WHERE b.id = rp.business_id AND rp.status = 'open' AND rp.reminded_at IS NULL
        AND rp.created_at < now() - interval '1 day'
     RETURNING b.name AS business, rp.reason`,
  );
}
