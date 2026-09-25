import crypto from "node:crypto";
import type { FoundBusiness } from "../ai/online-finder.js";
import type { Db } from "../db/client.js";
import { one } from "../db/client.js";
import { isUuid } from "./businesses.js";
import { haversineKm, type Gazetteer } from "./gazetteer.js";

/** A business found on the web. Unverified; deleted when it expires or the field team closes it. */
export interface OnlineLead {
  id: string;
  name: string;
  phone: string;
  description: string;
  area_text: string | null;
  area_id: number | null;
  lat: number | null;
  lng: number | null;
  category_slug: string | null;
  query: string;
  source_url: string;
  source_title: string | null;
  status: "new" | "invited";
  times_shown: number;
  times_connected: number;
  found_at: Date;
  expires_at: Date;
}

export function phoneHash(phone: string): string {
  return crypto.createHash("sha256").update(`online-optout:${phone}`).digest("hex");
}

/** Leads found earlier for the same category (or the same words), still valid and near the customer. */
export async function cachedLeads(
  db: Db,
  q: { categorySlug: string | null; query: string; lat?: number; lng?: number; maxKm: number; limit: number; now: Date },
): Promise<OnlineLead[]> {
  if (!q.categorySlug && !q.query) return [];
  const rows = await db.query<OnlineLead>(
    `SELECT l.* FROM online_leads l
      WHERE l.expires_at > $3
        AND ($1::text IS NOT NULL AND l.category_slug = $1 OR $1::text IS NULL AND l.query = $2)
        AND NOT EXISTS (SELECT 1 FROM businesses b WHERE b.phone = l.phone)
      ORDER BY l.times_connected DESC, l.found_at DESC
      LIMIT 50`,
    [q.categorySlug, q.query, q.now],
  );
  return rows
    .filter((l) => q.lat == null || q.lng == null || l.lat == null || l.lng == null || haversineKm(q.lat, q.lng, l.lat, l.lng) <= q.maxKm)
    .slice(0, q.limit);
}

/**
 * Store what a web search found. Numbers already in the directory (whatever their status, so a
 * business that left stays gone) and numbers that opted out are skipped. The searched place stands
 * in for a lead's location when the web page doesn't say where it is.
 */
export async function saveLeads(
  db: Db,
  gazetteer: Gazetteer,
  found: FoundBusiness[],
  ctx: { categorySlug: string | null; query: string; place?: { lat: number; lng: number }; expiresAt: Date },
): Promise<OnlineLead[]> {
  const saved: OnlineLead[] = [];
  for (const f of found) {
    const blocked = await one(
      db,
      `SELECT 1 FROM businesses WHERE phone = $1
        UNION ALL SELECT 1 FROM online_optouts WHERE phone_hash = $2 LIMIT 1`,
      [f.phone, phoneHash(f.phone)],
    );
    if (blocked) continue;
    const area = f.area ? gazetteer.match(f.area) : undefined;
    const lat = area?.lat ?? ctx.place?.lat ?? null;
    const lng = area?.lng ?? ctx.place?.lng ?? null;
    const row = await one<OnlineLead>(
      db,
      `INSERT INTO online_leads (name, phone, description, area_text, area_id, lat, lng, category_slug, query,
                                 source_url, source_title, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (phone) DO UPDATE SET expires_at = GREATEST(online_leads.expires_at, excluded.expires_at)
       RETURNING *`,
      [
        f.name,
        f.phone,
        f.description,
        f.area,
        area?.id ?? null,
        lat,
        lng,
        ctx.categorySlug,
        ctx.query.slice(0, 80),
        f.sourceUrl,
        f.sourceTitle,
        ctx.expiresAt,
      ],
    );
    if (row) saved.push(row);
  }
  return saved;
}

/** Remember which leads a request showed, in order, and count the showing. */
export async function linkLeadsToRequest(db: Db, requestId: string, leadIds: string[]): Promise<void> {
  for (const [rank, leadId] of leadIds.entries()) {
    const inserted = await db.query(
      "INSERT INTO request_online_results (request_id, lead_id, rank) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING lead_id",
      [requestId, leadId, rank],
    );
    if (inserted.length) await db.query("UPDATE online_leads SET times_shown = times_shown + 1 WHERE id = $1", [leadId]);
  }
}

export async function leadsForRequest(db: Db, requestId: string): Promise<OnlineLead[]> {
  return db.query<OnlineLead>(
    `SELECT l.* FROM request_online_results r JOIN online_leads l ON l.id = r.lead_id
      WHERE r.request_id = $1 ORDER BY r.rank`,
    [requestId],
  );
}

export async function getLead(db: Db, id: string): Promise<OnlineLead | undefined> {
  if (!isUuid(id)) return undefined;
  return one<OnlineLead>(db, "SELECT * FROM online_leads WHERE id = $1", [id]);
}

export async function markLeadConnected(db: Db, id: string): Promise<void> {
  await db.query("UPDATE online_leads SET times_connected = times_connected + 1 WHERE id = $1", [id]);
}

export async function setLeadStatus(db: Db, id: string, status: OnlineLead["status"]): Promise<boolean> {
  if (!isUuid(id)) return false;
  return (await db.query("UPDATE online_leads SET status = $2 WHERE id = $1 RETURNING id", [id, status])).length > 0;
}

/**
 * The field team is done with a lead. It is deleted either way; when the business asked not to
 * be shown, a hash of its number is kept so web searches never bring it back.
 */
export async function closeLead(db: Db, id: string, reason: "listed" | "declined" | "wrong"): Promise<boolean> {
  const lead = await getLead(db, id);
  if (!lead) return false;
  await db.transaction(async (tx) => {
    if (reason === "declined") {
      await tx.query("INSERT INTO online_optouts (phone_hash) VALUES ($1) ON CONFLICT DO NOTHING", [phoneHash(lead.phone)]);
    }
    await tx.query("DELETE FROM online_leads WHERE id = $1", [lead.id]);
  });
  return true;
}

/** Delete leads past their expiry. Returns how many went. */
export async function expireLeads(db: Db, now: Date): Promise<number> {
  return (await db.query("DELETE FROM online_leads WHERE expires_at <= $1 RETURNING id", [now])).length;
}

/** Web searches this customer triggered since `since`, for the daily limit. */
export async function onlineSearchesSince(db: Db, contactId: string, since: Date): Promise<number> {
  const row = await one<{ n: number }>(
    db,
    "SELECT count(*)::int AS n FROM requests WHERE contact_id = $1 AND online_searched_at > $2",
    [contactId, since],
  );
  return row?.n ?? 0;
}
