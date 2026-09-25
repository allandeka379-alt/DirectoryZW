import type { Db } from "../db/client.js";
import { one } from "../db/client.js";

export interface Business {
  id: string;
  name: string;
  description: string;
  keywords: string;
  phone: string;
  area_id: number | null;
  lat: number | null;
  lng: number | null;
  verification: "verified" | "registered";
  status: "active" | "paused" | "removed";
  source: "field" | "self" | "import";
  owner_contact_id: string | null;
  opted_in_at: Date | null;
  response_score: number;
  rating_sum: number;
  rating_count: number;
}

export interface NewBusiness {
  name: string;
  description?: string;
  keywords?: string;
  phone: string;
  areaId?: number | null;
  lat?: number | null;
  lng?: number | null;
  categories: string[];
  source: Business["source"];
  verified?: boolean;
  verifiedBy?: string;
  ownerContactId?: string | null;
  optedIn?: boolean;
  /** Field registrations: the agent, the app's idempotency key, GPS accuracy and the checklist. */
  registeredBy?: string | null;
  clientRef?: string | null;
  gpsAccuracyM?: number | null;
  checks?: Record<string, boolean>;
}

export async function createBusiness(db: Db, b: NewBusiness): Promise<string> {
  return db.transaction(async (tx) => {
    const row = await one<{ id: string }>(
      tx,
      `INSERT INTO businesses (name, description, keywords, phone, area_id, lat, lng, verification, verified_at,
         verified_by, source, owner_contact_id, opted_in_at, registered_by, client_ref, gps_accuracy_m, checks)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) RETURNING id`,
      [
        b.name.trim(),
        (b.description ?? "").trim(),
        (b.keywords ?? "").trim(),
        b.phone,
        b.areaId ?? null,
        b.lat ?? null,
        b.lng ?? null,
        b.verified ? "verified" : "registered",
        b.verified ? new Date() : null,
        b.verified ? (b.verifiedBy ?? null) : null,
        b.source,
        b.ownerContactId ?? null,
        b.optedIn ? new Date() : null,
        b.registeredBy ?? null,
        b.clientRef ?? null,
        b.gpsAccuracyM ?? null,
        JSON.stringify(b.checks ?? {}),
      ],
    );
    for (const slug of new Set(b.categories)) {
      await tx.query("INSERT INTO business_categories (business_id, category_slug) VALUES ($1, $2)", [row!.id, slug]);
    }
    return row!.id;
  });
}

export async function getBusiness(db: Db, id: string): Promise<Business | undefined> {
  if (!isUuid(id)) return undefined;
  return one<Business>(db, "SELECT * FROM businesses WHERE id = $1", [id]);
}

export async function businessesOwnedBy(db: Db, contactId: string): Promise<Business[]> {
  return db.query<Business>(
    "SELECT * FROM businesses WHERE owner_contact_id = $1 AND status <> 'removed' ORDER BY created_at",
    [contactId],
  );
}

/** Link businesses registered by a field agent to the owner's WhatsApp contact when their number messages us. */
export async function claimBusinessesByPhone(db: Db, contactId: string, phone: string): Promise<void> {
  await db.query(
    "UPDATE businesses SET owner_contact_id = $1, updated_at = now() WHERE phone = $2 AND owner_contact_id IS NULL",
    [contactId, phone],
  );
}

export async function setBusinessStatus(db: Db, id: string, status: Business["status"]): Promise<void> {
  await db.query("UPDATE businesses SET status = $2, updated_at = now() WHERE id = $1", [id, status]);
}

export async function verifyBusiness(db: Db, id: string, by: string): Promise<void> {
  await db.query(
    "UPDATE businesses SET verification = 'verified', verified_at = now(), verified_by = $2, updated_at = now() WHERE id = $1",
    [id, by],
  );
}

export async function recordRating(db: Db, id: string, rating: number): Promise<void> {
  await db.query(
    "UPDATE businesses SET rating_sum = rating_sum + $2, rating_count = rating_count + 1, updated_at = now() WHERE id = $1",
    [id, rating],
  );
}

/** Nudge how quickly a business answers customers (0 = never, 1 = always). */
export async function adjustResponseScore(db: Db, id: string, delta: number): Promise<void> {
  await db.query(
    "UPDATE businesses SET response_score = LEAST(1, GREATEST(0, response_score + $2)), updated_at = now() WHERE id = $1",
    [id, delta],
  );
}

/** Replace what a business says it sells and the categories it is listed under. */
export async function updateBusinessOffer(
  db: Db,
  id: string,
  offer: { description: string; keywords: string; categories: string[] },
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.query("UPDATE businesses SET description = $2, keywords = $3, updated_at = now() WHERE id = $1", [
      id,
      offer.description,
      offer.keywords,
    ]);
    await tx.query("DELETE FROM business_categories WHERE business_id = $1", [id]);
    for (const slug of new Set(offer.categories)) {
      await tx.query("INSERT INTO business_categories (business_id, category_slug) VALUES ($1, $2)", [id, slug]);
    }
  });
}

export async function updateBusinessLocation(db: Db, id: string, loc: { areaId: number | null; lat: number; lng: number }): Promise<void> {
  await db.query("UPDATE businesses SET area_id = $2, lat = $3, lng = $4, updated_at = now() WHERE id = $1", [
    id,
    loc.areaId,
    loc.lat,
    loc.lng,
  ]);
}

export async function categoriesOf(db: Db, businessId: string): Promise<string[]> {
  const rows = await db.query<{ category_slug: string }>(
    "SELECT category_slug FROM business_categories WHERE business_id = $1 ORDER BY category_slug",
    [businessId],
  );
  return rows.map((r) => r.category_slug);
}

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
