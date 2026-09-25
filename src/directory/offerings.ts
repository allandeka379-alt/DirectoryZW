import crypto from "node:crypto";
import type { PriceListItem } from "../ai/vision.js";
import type { Db } from "../db/client.js";
import type { FileStore } from "../storage.js";
import { searchTokens } from "../text.js";
import type { Media } from "../whatsapp/media.js";

export interface Offering {
  id: string;
  business_id: string;
  name: string;
  price_usd: string | null;
  price_text: string | null;
  created_at: Date;
}

const PHOTO_EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };

/** Keep a photo of a business (shopfront, inside, price list). Returns the photo ID. */
export async function saveBusinessPhoto(
  db: Db,
  store: FileStore,
  businessId: string,
  kind: "shopfront" | "inside" | "price_list",
  image: Media,
): Promise<string> {
  const id = crypto.randomUUID();
  const key = `photos/${businessId}/${id}.${PHOTO_EXT[image.mimeType] ?? "bin"}`;
  await store.put(key, image.data, image.mimeType);
  await db.query(
    "INSERT INTO business_photos (id, business_id, kind, storage_key, content_type, bytes) VALUES ($1, $2, $3, $4, $5, $6)",
    [id, businessId, kind, key, image.mimeType, image.data.length],
  );
  return id;
}

/** Replace a business's items with a newly read price list. The item names become searchable. */
export async function replaceOfferings(db: Db, businessId: string, items: PriceListItem[], photoId: string | null): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.query("DELETE FROM offerings WHERE business_id = $1", [businessId]);
    for (const item of items) {
      await tx.query(
        "INSERT INTO offerings (business_id, name, price_usd, price_text, photo_id) VALUES ($1, $2, $3, $4, $5)",
        [businessId, item.name, item.price_usd, item.price_text, photoId],
      );
    }
    const text = items.map((i) => i.name).join(" ").slice(0, 4000);
    await tx.query("UPDATE businesses SET offerings_text = $2, updated_at = now() WHERE id = $1", [businessId, text]);
  });
}

/** Price-list items that match what the customer asked for, best first. */
export async function matchingOfferings(db: Db, businessId: string, text: string, limit = 3): Promise<Offering[]> {
  const tokens = searchTokens(text);
  if (!tokens.length) return [];
  const tsquery = tokens.map((t) => (t.length >= 3 ? `${t}:*` : t)).join(" | ");
  return db.query<Offering>(
    `SELECT o.*, ts_rank(to_tsvector('simple', o.name), q) AS rank
       FROM offerings o, to_tsquery('simple', $2) q
      WHERE o.business_id = $1 AND to_tsvector('simple', o.name) @@ q
      ORDER BY rank DESC, o.name LIMIT $3`,
    [businessId, tsquery, limit],
  );
}

/** "$11.50", or the price as written when it isn't in US dollars. */
export function priceLabel(o: { price_usd: string | number | null; price_text: string | null }): string | null {
  if (o.price_usd != null) return `$${Number(o.price_usd).toFixed(2)}`;
  return o.price_text;
}
