import type { Db } from "../db/client.js";
import { one } from "../db/client.js";
import { isUuid } from "./businesses.js";

export type RecommendationStatus = "new" | "contacted" | "listed" | "rejected";
export const RECOMMENDATION_STATUSES = ["new", "contacted", "listed", "rejected"] as const;

/** A customer's tip about a business we should list. The field team follows it up. */
export async function createRecommendation(
  db: Db,
  r: {
    contactId: string;
    name: string;
    what: string;
    categorySlug: string | null;
    areaText: string | null;
    areaId: number | null;
    phone: string | null;
  },
): Promise<string> {
  const row = await one<{ id: string }>(
    db,
    `INSERT INTO recommendations (contact_id, name, what, category_slug, area_text, area_id, phone)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [r.contactId, r.name.slice(0, 80), r.what.slice(0, 300), r.categorySlug, r.areaText?.slice(0, 80) ?? null, r.areaId, r.phone],
  );
  return row!.id;
}

export async function setRecommendationStatus(db: Db, id: string, status: RecommendationStatus): Promise<boolean> {
  if (!isUuid(id)) return false;
  return (await db.query("UPDATE recommendations SET status = $2 WHERE id = $1 RETURNING id", [id, status])).length > 0;
}
