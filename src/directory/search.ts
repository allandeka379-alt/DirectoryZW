import type { Db } from "../db/client.js";
import { searchTokens } from "../text.js";
import { haversineKm } from "./gazetteer.js";
import type { Taxonomy } from "./taxonomy.js";

export interface SearchQuery {
  categorySlug: string | null;
  text: string;
  lat?: number;
  lng?: number;
  limit: number;
  /** Show unverified businesses only when fewer verified ones than this match. */
  minVerified: number;
  /** Ignore businesses further away than this when we know where the customer is. */
  maxKm?: number;
  excludeIds?: string[];
  /**
   * Who is asking: the public ("retail", the default) sees businesses that sell to the public;
   * a business looking for supplies ("wholesale") sees those that sell to other businesses.
   */
  trade?: "retail" | "wholesale";
}

export interface BusinessHit {
  id: string;
  name: string;
  description: string;
  phone: string;
  verification: "verified" | "registered";
  areaName: string | null;
  city: string | null;
  distanceKm: number | null;
  ratingAvg: number | null;
  ratingCount: number;
  categoryMatch: boolean;
  score: number;
}

interface Row {
  id: string;
  name: string;
  description: string;
  phone: string;
  verification: "verified" | "registered";
  lat: number | null;
  lng: number | null;
  response_score: number;
  rating_sum: number;
  rating_count: number;
  area_name: string | null;
  city: string | null;
  category_match: boolean;
  text_rank: number;
}

/**
 * Find businesses for a request. The database decides what exists; ranking puts verified
 * businesses first and only shows unverified ones when there are too few verified matches.
 */
export async function searchBusinesses(db: Db, taxonomy: Taxonomy, q: SearchQuery): Promise<BusinessHit[]> {
  const category = taxonomy.get(q.categorySlug);
  if (category && (category.risk === "blocked" || category.risk === "restricted")) return [];
  const tokens = searchTokens(q.text);
  const tsquery = tokens.map((t) => (t.length >= 3 ? `${t}:*` : t)).join(" | ");
  const rows = await db.query<Row>(
    `WITH q AS (SELECT CASE WHEN $2 = '' THEN NULL ELSE to_tsquery('simple', $2) END AS tsq)
     SELECT b.id, b.name, b.description, b.phone, b.verification, b.lat, b.lng, b.response_score,
            b.rating_sum, b.rating_count, a.name AS area_name, a.city,
            ($1::text IS NOT NULL AND EXISTS (
              SELECT 1 FROM business_categories bc WHERE bc.business_id = b.id AND bc.category_slug = $1)) AS category_match,
            COALESCE(ts_rank(b.search_tsv, q.tsq), 0)::float8 AS text_rank
       FROM businesses b
       LEFT JOIN areas a ON a.id = b.area_id
       CROSS JOIN q
      WHERE b.status = 'active'
        AND NOT (b.id::text = ANY($3::text[]))
        -- the public doesn't see wholesale-only businesses; a business looking for supplies doesn't see retail-only ones
        AND b.trade <> $4
        AND (
          ($1::text IS NOT NULL AND EXISTS (
            SELECT 1 FROM business_categories bc WHERE bc.business_id = b.id AND bc.category_slug = $1))
          OR (q.tsq IS NOT NULL AND b.search_tsv @@ q.tsq)
        )
        AND NOT EXISTS (
          SELECT 1 FROM business_categories bc JOIN categories c ON c.slug = bc.category_slug
           WHERE bc.business_id = b.id AND c.risk IN ('blocked', 'restricted'))
      -- With many candidates, the ones kept are the category's, nearest first, then the best keyword matches.
      ORDER BY category_match DESC,
               CASE WHEN $5::float8 IS NULL OR b.lat IS NULL THEN 0 ELSE (b.lat - $5) ^ 2 + (b.lng - $6) ^ 2 END,
               text_rank DESC
      LIMIT 300`,
    [category?.slug ?? null, tsquery, q.excludeIds ?? [], q.trade === "wholesale" ? "retail" : "wholesale", q.lat ?? null, q.lng ?? null],
  );

  const located = q.lat != null && q.lng != null;
  const maxKm = category?.needsLocation === false ? undefined : (q.maxKm ?? 60);
  const hits: BusinessHit[] = [];
  for (const r of rows) {
    const distanceKm = located && r.lat != null && r.lng != null ? haversineKm(q.lat!, q.lng!, r.lat, r.lng) : null;
    if (maxKm != null && distanceKm != null && distanceKm > maxKm) continue;
    const ratingAvg = r.rating_count > 0 ? r.rating_sum / r.rating_count : null;
    let score = (r.category_match ? 1 : 0) + Math.min(r.text_rank * 5, 1) * 0.6 + r.response_score * 0.2;
    if (ratingAvg != null && r.rating_count >= 3) score += ((ratingAvg - 3) / 2) * 0.2;
    if (distanceKm != null) score -= (Math.min(distanceKm, 40) / 40) * 0.5;
    hits.push({
      id: r.id,
      name: r.name,
      description: r.description,
      phone: r.phone,
      verification: r.verification,
      areaName: r.area_name,
      city: r.city,
      distanceKm,
      ratingAvg,
      ratingCount: r.rating_count,
      categoryMatch: r.category_match,
      score,
    });
  }

  // When we know the category, keyword-only matches from other categories are noise.
  const relevant = category ? hits.filter((h) => h.categoryMatch) : hits;
  const byScore = (a: BusinessHit, b: BusinessHit) => b.score - a.score;
  const verified = relevant.filter((h) => h.verification === "verified").sort(byScore);
  const registered = relevant.filter((h) => h.verification === "registered").sort(byScore);
  if (category?.risk === "high_scam" || verified.length >= q.minVerified) return verified.slice(0, q.limit);
  return [...verified, ...registered].slice(0, q.limit);
}

/**
 * Suppliers in the categories related to this one (see relatedCategories in the seed data), for
 * when none in the category itself are nearby: verified first, then the rest, closest and best
 * first. A high-scam category is referred to verified businesses only.
 */
export async function searchRelated(
  db: Db,
  taxonomy: Taxonomy,
  q: {
    categorySlug: string;
    lat?: number;
    lng?: number;
    limit: number;
    minVerified: number;
    maxKm?: number;
    excludeIds?: string[];
    trade?: "retail" | "wholesale";
  },
): Promise<BusinessHit[]> {
  const category = taxonomy.get(q.categorySlug);
  if (!category) return [];
  const seen = new Set<string>();
  const hits: BusinessHit[] = [];
  for (const slug of category.related) {
    const related = taxonomy.get(slug);
    if (!related || related.risk === "blocked" || related.risk === "restricted") continue;
    const found = await searchBusinesses(db, taxonomy, { ...q, categorySlug: slug, text: "" });
    for (const h of found) {
      if (seen.has(h.id)) continue;
      seen.add(h.id);
      hits.push(h);
    }
  }
  const byScore = (a: BusinessHit, b: BusinessHit) => b.score - a.score;
  const verified = hits.filter((h) => h.verification === "verified").sort(byScore);
  const registered = category.risk === "high_scam" ? [] : hits.filter((h) => h.verification === "registered").sort(byScore);
  return [...verified, ...registered].slice(0, q.limit);
}
