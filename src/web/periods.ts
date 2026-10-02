import { harareStartOfDay } from "../time.js";

/**
 * Reporting periods for the dashboards. A period is a run of whole Harare days ending today (or, for a
 * year, the last 52 Monday-to-Sunday weeks, this week included), with the same run just before it to
 * compare against. Every series has one value per bucket, so totals always equal the sum of the bars.
 */

const DAY = 24 * 3600_000;
/** Harare is UTC+2 all year. */
const HARARE = 2 * 3600_000;

/** The periods the dashboards offer: 7, 30 and 90 days, and 12 months. */
export const PERIOD_DAYS = [7, 30, 90, 365] as const;

export type Grain = "day" | "week";

export interface Period {
  /** As asked: 7, 30, 90 or 365. */
  days: number;
  /** Days up to 90 days; weeks for a year. */
  grain: Grain;
  /** Harare midnight at the start of the first bucket. */
  start: Date;
  /** Now: the period runs up to the present moment. */
  end: Date;
  /** The start of the period before, which ends where this one starts. */
  prevStart: Date;
  /** Each bucket's first Harare date ("2026-09-29"), oldest first. */
  buckets: string[];
  /** The same number of buckets in the period before. */
  prevBuckets: string[];
}

/** "2026-09-29" in Harare. */
export function harareDate(d: Date): string {
  return new Date(d.getTime() + HARARE).toISOString().slice(0, 10);
}

export function periodFor(days: number, now: Date): Period {
  const today = harareStartOfDay(now);
  if (days <= 90) {
    const start = new Date(today.getTime() - (days - 1) * DAY);
    const prevStart = new Date(start.getTime() - days * DAY);
    const keys = (from: Date) => Array.from({ length: days }, (_, i) => harareDate(new Date(from.getTime() + i * DAY)));
    return { days, grain: "day", start, end: now, prevStart, buckets: keys(start), prevBuckets: keys(prevStart) };
  }
  // A year: 52 weeks, Monday to Sunday, the last one being this week.
  const weekday = (new Date(today.getTime() + HARARE).getUTCDay() + 6) % 7; // 0 = Monday
  const thisMonday = new Date(today.getTime() - weekday * DAY);
  const start = new Date(thisMonday.getTime() - 51 * 7 * DAY);
  const prevStart = new Date(start.getTime() - 52 * 7 * DAY);
  const keys = (from: Date) => Array.from({ length: 52 }, (_, i) => harareDate(new Date(from.getTime() + i * 7 * DAY)));
  return { days, grain: "week", start, end: now, prevStart, buckets: keys(start), prevBuckets: keys(prevStart) };
}

/** The Harare date and time of a timestamp column, as SQL. */
export const harareLocal = (col: string) => `((${col} AT TIME ZONE 'UTC') + interval '2 hours')`;

/** The bucket a timestamp falls in, as text that matches the period's bucket keys. */
export function bucketSql(col: string, grain: Grain): string {
  return grain === "day" ? `${harareLocal(col)}::date::text` : `date_trunc('week', ${harareLocal(col)})::date::text`;
}

/** Spread rows keyed by bucket over this period and the one before, filling quiet buckets with zero. */
export function align<T extends { k: string }>(period: Period, rows: T[], value: (row: T) => number): { cur: number[]; prev: number[] } {
  const byKey = new Map(rows.map((r) => [r.k, Number(value(r)) || 0]));
  return { cur: period.buckets.map((k) => byKey.get(k) ?? 0), prev: period.prevBuckets.map((k) => byKey.get(k) ?? 0) };
}

export const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

/** A ratio, or null when there's nothing to divide by. */
export const ratio = (n: number, of: number) => (of > 0 ? n / of : null);

/** Running totals, starting from what there was before the first bucket. */
export function cumulative(base: number, values: number[]): number[] {
  let running = base;
  return values.map((v) => (running += v));
}

// ----- Filters -----

/** What a dashboard is narrowed to. An area wins over its city; a category over its group. */
export interface Scope {
  city?: string | null;
  areaId?: number | null;
  category?: string | null;
  group?: string | null;
}

/** Numbered query parameters, added as a query is built. */
export class Params {
  readonly list: unknown[] = [];
  constructor(...first: unknown[]) {
    this.list.push(...first);
  }
  add(value: unknown): string {
    this.list.push(value);
    return `$${this.list.length}`;
  }
}

/** Conditions on requests (alias `r`) for a scope, each starting with " AND". */
export function requestScope(s: Scope, p: Params, r = "r", { place = true, kind = true } = {}): string {
  const parts: string[] = [];
  if (place && s.areaId != null) parts.push(`${r}.area_id = ${p.add(s.areaId)}`);
  else if (place && s.city) parts.push(`${r}.area_id IN (SELECT id FROM areas WHERE city = ${p.add(s.city)})`);
  if (kind && s.category) parts.push(`${r}.category_slug = ${p.add(s.category)}`);
  else if (kind && s.group) parts.push(`${r}.category_slug IN (SELECT slug FROM categories WHERE group_name = ${p.add(s.group)})`);
  return parts.map((x) => ` AND ${x}`).join("");
}

/** Conditions on businesses (alias `b`) for a scope, each starting with " AND". */
export function businessScope(s: Scope, p: Params, b = "b", { place = true, kind = true } = {}): string {
  const parts: string[] = [];
  if (place && s.areaId != null) parts.push(`${b}.area_id = ${p.add(s.areaId)}`);
  else if (place && s.city) parts.push(`${b}.area_id IN (SELECT id FROM areas WHERE city = ${p.add(s.city)})`);
  if (kind && s.category) {
    parts.push(`EXISTS (SELECT 1 FROM business_categories bc WHERE bc.business_id = ${b}.id AND bc.category_slug = ${p.add(s.category)})`);
  } else if (kind && s.group) {
    parts.push(
      `EXISTS (SELECT 1 FROM business_categories bc JOIN categories c ON c.slug = bc.category_slug
                WHERE bc.business_id = ${b}.id AND c.group_name = ${p.add(s.group)})`,
    );
  }
  return parts.map((x) => ` AND ${x}`).join("");
}

/** Whether a scope narrows requests at all (so introductions need joining to their request). */
export const scopesRequests = (s: Scope) => s.areaId != null || !!s.city || !!s.category || !!s.group;
