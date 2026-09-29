import type { RequestInterpretation } from "../ai/types.js";
import type { Db } from "../db/client.js";
import { one } from "../db/client.js";
import { getBusiness } from "../directory/businesses.js";
import { haversineKm } from "../directory/gazetteer.js";
import { MATCH_THRESHOLD, priceOf, productQuery, productWords, scoreProduct, wordsToMatch } from "../directory/products.js";
import type { Services } from "./context.js";
import * as copy from "./copy.js";
import { getContactById } from "./store.js";

/**
 * "A store near you now has it." When a store lists (or restocks) something a customer asked for in
 * the last day and nobody had, the customer hears once, with the store and the price. Only inside
 * their free 24-hour window, never as a paid template; never to people who said stop; at most two a
 * day each. Alerts are stricter than results: only a close match.
 */

/** Alerts need a closer match than a results list. */
const ALERT_THRESHOLD = MATCH_THRESHOLD + 0.15;
const PER_CONTACT_PER_DAY = 2;

/**
 * A business's products changed on the dashboard (or from the admin portal): alert customers who
 * were waiting for them, and send the catalog what changed. Both run shortly after, once, however
 * many changes come in meanwhile (a bulk upload is one run).
 */
export async function productsChanged(svc: Services, businessId: string): Promise<void> {
  const now = svc.now().getTime();
  if (svc.config.products.alerts) {
    await svc.jobs.enqueueOnce("product_alerts", businessId, { businessId, since: new Date(now - 5_000).toISOString() }, new Date(now + 20_000));
  }
  if (svc.catalog) await svc.jobs.enqueueOnce("catalog_sync", "all", {}, new Date(now + 10_000));
}

interface WaitingRequest {
  id: string;
  contact_id: string;
  raw_text: string;
  query: string;
  interpretation: RequestInterpretation;
  category_slug: string | null;
  lat: number | null;
  lng: number | null;
  area_id: number | null;
  created_at: Date;
}

interface ChangedProduct {
  id: string;
  name: string;
  category: string | null;
  description: string;
  price_usd: string | null;
  price_text: string | null;
}

/** Send the alerts a business's recent product changes answer. Returns how many went out. */
export async function sendProductAlerts(svc: Services, businessId: string, since: Date): Promise<number> {
  if (!svc.config.products.alerts) return 0;
  const { db } = svc;
  const business = await getBusiness(db, businessId);
  if (!business || business.status !== "active" || business.trade === "wholesale") return 0;
  if (await blocked(db, businessId)) return 0;
  const products = await db.query<ChangedProduct>(
    `SELECT id, name, category, description, price_usd, price_text FROM offerings
      WHERE business_id = $1 AND archived_at IS NULL AND in_stock AND updated_at >= $2
      ORDER BY updated_at DESC LIMIT 500`,
    [businessId, since],
  );
  if (!products.length) return 0;
  const now = svc.now();
  const waiting = await db.query<WaitingRequest>(
    `SELECT r.id, r.contact_id, r.raw_text, r.query, r.interpretation, r.category_slug, r.lat, r.lng, r.area_id, r.created_at
       FROM requests r JOIN contacts c ON c.id = r.contact_id
      WHERE r.product_matches = 0 AND r.created_at >= $1 AND r.buyer_business_id IS NULL
        AND c.channel = 'customer' AND NOT c.is_blocked AND c.consent_at IS NOT NULL AND c.alerts_off_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM product_alerts pa WHERE pa.request_id = r.id)
        AND NOT EXISTS (SELECT 1 FROM introductions i WHERE i.request_id = r.id)
      ORDER BY r.created_at DESC LIMIT 500`,
    [new Date(now.getTime() - svc.config.products.alertHours * 3600_000)],
  );

  const tokens = products.map((p) => ({ p, words: productWords(p) }));
  let sent = 0;
  for (const r of waiting) {
    const category = svc.taxonomy.get(r.category_slug);
    // Services are answered by the trade, not by what's for sale.
    if (category && !category.goods) continue;
    if (r.lat != null && r.lng != null && business.lat != null && business.lng != null && category?.needsLocation !== false) {
      if (haversineKm(r.lat, r.lng, business.lat, business.lng) > 60) continue;
    }
    const budget = r.interpretation?.budget_usd ?? null;
    const query = productQuery(wordsToMatch(r.raw_text, r.query, r.interpretation?.area, svc.gazetteer), svc.lexicon, budget);
    let best: { p: ChangedProduct; score: number } | undefined;
    for (const t of tokens) {
      const { score } = scoreProduct(query, t.words);
      const price = t.p.price_usd == null ? null : Number(t.p.price_usd);
      if (score < ALERT_THRESHOLD || (budget != null && price != null && price > budget * 1.1)) continue;
      if (!best || score > best.score) best = { p: t.p, score };
    }
    if (!best) continue;
    if (await alertedToday(db, r.contact_id, now)) continue;
    const contact = await getContactById(db, r.contact_id);
    // Free only: inside the window their own request opened.
    if (!contact || !svc.messenger.windowClosesAt(contact)) continue;
    const claimed = await db.query(
      `INSERT INTO product_alerts (request_id, contact_id, business_id, offering_id, created_at) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (request_id) DO NOTHING RETURNING id`,
      [r.id, r.contact_id, businessId, best.p.id, now],
    );
    if (!claimed.length) continue;
    // So "See it" and "Other options" work from the alert as from a results list.
    const rank = await one<{ n: number }>(db, "SELECT count(*)::int AS n FROM request_results WHERE request_id = $1", [r.id]);
    await db.query(
      "INSERT INTO request_results (request_id, business_id, rank, offering_id) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING",
      [r.id, businessId, rank?.n ?? 0, best.p.id],
    );
    const area = svc.gazetteer.get(business.area_id)?.name ?? null;
    const distanceKm = r.lat != null && r.lng != null && business.lat != null && business.lng != null ? haversineKm(r.lat, r.lng, business.lat, business.lng) : null;
    const price = best.p.price_usd == null ? null : Number(best.p.price_usd);
    await svc.messenger.reply(
      contact,
      copy.productAlert(r.id, {
        firstName: contact.profile_name,
        asked: r.query || r.raw_text,
        business: { id: business.id, name: business.name, verified: business.verification === "verified", area, distanceKm },
        product: { name: best.p.name, price: priceOf({ price, priceText: best.p.price_text }) },
      }),
    );
    sent++;
  }
  if (sent) svc.log.info({ businessId, sent }, "Product alerts sent");
  return sent;
}

async function blocked(db: Db, businessId: string): Promise<boolean> {
  return Boolean(
    await one(
      db,
      `SELECT 1 FROM business_categories bc JOIN categories c ON c.slug = bc.category_slug
        WHERE bc.business_id = $1 AND c.risk IN ('blocked', 'restricted') LIMIT 1`,
      [businessId],
    ),
  );
}

async function alertedToday(db: Db, contactId: string, now: Date): Promise<boolean> {
  const row = await one<{ n: number }>(
    db,
    "SELECT count(*)::int AS n FROM product_alerts WHERE contact_id = $1 AND created_at > $2",
    [contactId, new Date(now.getTime() - 24 * 3600_000)],
  );
  return (row?.n ?? 0) >= PER_CONTACT_PER_DAY;
}

/** "No more alerts" (a button, or "stop"): until they say "alerts on". */
export async function setAlerts(db: Db, contactId: string, on: boolean, now: Date): Promise<void> {
  await db.query("UPDATE contacts SET alerts_off_at = $2 WHERE id = $1", [contactId, on ? null : now]);
}
