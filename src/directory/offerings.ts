import type { Db } from "../db/client.js";
import { searchTokens } from "../text.js";

export interface Offering {
  id: string;
  business_id: string;
  name: string;
  price_usd: string | null;
  price_text: string | null;
  created_at: Date;
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
