import type { ProductHit, ProductMatch } from "./products.js";
import type { BusinessHit } from "./search.js";

/** A business in a customer's results, with the product it lists for what they asked, if any. */
export interface Supplier extends BusinessHit {
  product: ProductMatch | null;
  /** How many of its products match. */
  productMatches: number;
  /** Its lowest price among them. */
  fromPrice: number | null;
}

const DAY = 24 * 3600_000;

/** A product-only hit's standing before its product counts: how it answers, its rating, how far. */
function businessScore(p: ProductHit): number {
  let score = p.responseScore * 0.2;
  if (p.ratingAvg != null && p.ratingCount >= 3) score += ((p.ratingAvg - 3) / 2) * 0.2;
  if (p.distanceKm != null) score -= (Math.min(p.distanceKm, 40) / 40) * 0.5;
  return score;
}

/** A price the store hasn't touched in a month may be out of date; one never set can't be compared. */
function freshness(m: ProductMatch, now: Date): number {
  if (m.price == null && !m.priceText) return -0.1;
  if (!m.priceUpdatedAt) return -0.15;
  const days = (now.getTime() - m.priceUpdatedAt.getTime()) / DAY;
  return days > 90 ? -0.3 : days > 30 ? -0.15 : 0;
}

export interface MergeOptions {
  limit: number;
  /** Unverified businesses fill in when fewer verified ones than this are found. */
  minVerified: number;
  /** High-scam categories: verified businesses only. */
  verifiedOnly: boolean;
  now: Date;
}

/**
 * One list from two searches: businesses in the category, and businesses that list a matching
 * product. Verified businesses come first, those that list it before those that don't. Businesses
 * that listed themselves fill in when too few verified ones are found, and when no verified
 * business lists the product but they do (after the first verified ones).
 */
export function mergeSuppliers(byCategory: BusinessHit[], byProduct: ProductHit[], opts: MergeOptions): Supplier[] {
  const all = new Map<string, Supplier>();
  for (const h of byCategory) all.set(h.id, { ...h, product: null, productMatches: 0, fromPrice: null });
  for (const p of byProduct) {
    const known = all.get(p.businessId);
    const base: BusinessHit = known ?? {
      id: p.businessId,
      name: p.name,
      description: p.description,
      phone: p.phone,
      verification: p.verification,
      areaName: p.areaName,
      city: p.city,
      distanceKm: p.distanceKm,
      ratingAvg: p.ratingAvg,
      ratingCount: p.ratingCount,
      categoryMatch: false,
      score: businessScore(p),
    };
    all.set(p.businessId, {
      ...base,
      product: p.best,
      productMatches: p.matches,
      fromPrice: p.fromPrice,
      score: base.score + 1.2 * p.best.score + freshness(p.best, opts.now),
    });
  }

  // Among equally good products, the cheaper one first.
  const priced = [...all.values()].filter((s) => s.product?.price != null);
  if (priced.length > 1) {
    const prices = priced.map((s) => s.product!.price!);
    const [lo, hi] = [Math.min(...prices), Math.max(...prices)];
    if (hi > lo) for (const s of priced) s.score += 0.15 * (1 - (s.product!.price! - lo) / (hi - lo));
  }

  const byScore = (a: Supplier, b: Supplier) => b.score - a.score;
  const group = (verified: boolean, listed: boolean) =>
    [...all.values()].filter((s) => (s.verification === "verified") === verified && !!s.product === listed).sort(byScore);
  const [vListed, vOther, rListed, rOther] = [group(true, true), group(true, false), group(false, true), group(false, false)];

  const verified = [...vListed, ...vOther];
  if (opts.verifiedOnly) return verified.slice(0, opts.limit);
  if (verified.length < opts.minVerified) return [...verified, ...rListed, ...rOther].slice(0, opts.limit);
  if (!vListed.length && rListed.length) {
    return [...vOther.slice(0, opts.minVerified), ...rListed, ...vOther.slice(opts.minVerified)].slice(0, opts.limit);
  }
  return verified.slice(0, opts.limit);
}
