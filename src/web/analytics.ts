import type { Db } from "../db/client.js";
import { one } from "../db/client.js";

/** Harare is UTC+2 all year. */
const HARARE_DAY = "((%s AT TIME ZONE 'UTC') + interval '2 hours')::date";
const HARARE_HOUR = "extract(hour FROM (%s AT TIME ZONE 'UTC') + interval '2 hours')::int";
const day = (col: string) => HARARE_DAY.replace("%s", col);
const hour = (col: string) => HARARE_HOUR.replace("%s", col);

function harareDate(d: Date): string {
  return new Date(d.getTime() + 2 * 3600_000).toISOString().slice(0, 10);
}

/**
 * What the dashboard shows an owner about one listing over the last `days` days: how often it came up
 * in searches, the customers it was sent, how those went, and what people in its categories and city
 * asked for, including what nobody could supply. Counts only; never who the customers are.
 */
export async function businessAnalytics(db: Db, business: { id: string; area_id: number | null }, days: number, now: Date) {
  const since = new Date(now.getTime() - days * 24 * 3600_000);
  const before = new Date(since.getTime() - days * 24 * 3600_000);
  const id = business.id;

  const totals = await one<{
    shown: number;
    shown_prev: number;
    connections: number;
    connections_prev: number;
    sorted: number;
    couldnt_help: number;
    no_reply: number;
    not_yet: number;
    rating_sum: number;
    rating_count: number;
  }>(
    db,
    `SELECT
       (SELECT count(*)::int FROM request_results rr JOIN requests r ON r.id = rr.request_id WHERE rr.business_id = $1 AND r.created_at >= $2) AS shown,
       (SELECT count(*)::int FROM request_results rr JOIN requests r ON r.id = rr.request_id
         WHERE rr.business_id = $1 AND r.created_at >= $3 AND r.created_at < $2) AS shown_prev,
       (SELECT count(*)::int FROM introductions WHERE business_id = $1 AND created_at >= $2) AS connections,
       (SELECT count(*)::int FROM introductions WHERE business_id = $1 AND created_at >= $3 AND created_at < $2) AS connections_prev,
       (SELECT count(*)::int FROM introductions WHERE business_id = $1 AND created_at >= $2 AND outcome = 'sorted') AS sorted,
       (SELECT count(*)::int FROM introductions WHERE business_id = $1 AND created_at >= $2 AND outcome = 'couldnt_help') AS couldnt_help,
       (SELECT count(*)::int FROM introductions WHERE business_id = $1 AND created_at >= $2 AND outcome = 'no_reply') AS no_reply,
       (SELECT count(*)::int FROM introductions WHERE business_id = $1 AND created_at >= $2 AND outcome = 'not_yet') AS not_yet,
       (SELECT rating_sum FROM businesses WHERE id = $1) AS rating_sum,
       (SELECT rating_count FROM businesses WHERE id = $1) AS rating_count`,
    [id, since, before],
  );

  const shownByDay = await db.query<{ d: string; n: number }>(
    `SELECT ${day("r.created_at")}::text AS d, count(*)::int AS n
       FROM request_results rr JOIN requests r ON r.id = rr.request_id
      WHERE rr.business_id = $1 AND r.created_at >= $2 GROUP BY 1`,
    [id, since],
  );
  const connectionsByDay = await db.query<{ d: string; n: number }>(
    `SELECT ${day("created_at")}::text AS d, count(*)::int AS n FROM introductions WHERE business_id = $1 AND created_at >= $2 GROUP BY 1`,
    [id, since],
  );
  const shownMap = new Map(shownByDay.map((r) => [r.d, r.n]));
  const connMap = new Map(connectionsByDay.map((r) => [r.d, r.n]));
  const daily = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = harareDate(new Date(now.getTime() - i * 24 * 3600_000));
    daily.push({ date: d, shown: shownMap.get(d) ?? 0, connections: connMap.get(d) ?? 0 });
  }

  // What customers asked for when this business came up.
  const topAsks = await db.query<{ what: string; n: number }>(
    `SELECT coalesce(nullif(r.query, ''), c.name, 'other') AS what, count(*)::int AS n
       FROM request_results rr JOIN requests r ON r.id = rr.request_id LEFT JOIN categories c ON c.slug = r.category_slug
      WHERE rr.business_id = $1 AND r.created_at >= $2
      GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 8`,
    [id, since],
  );

  // Demand in the business's categories, in its city: what was asked, and what went unanswered.
  const market = `r.category_slug IN (SELECT category_slug FROM business_categories WHERE business_id = $1)
       AND r.buyer_business_id IS NULL AND r.created_at >= $2
       AND ($3::int IS NULL OR r.area_id IS NULL OR r.area_id IN (
             SELECT a.id FROM areas a WHERE a.city = (SELECT city FROM areas WHERE id = $3::int)))`;
  const marketParams = [id, since, business.area_id];
  const demand = await db.query<{ what: string; n: number; unmet: number }>(
    `SELECT coalesce(nullif(r.query, ''), c.name) AS what, count(*)::int AS n,
            count(*) FILTER (WHERE r.status = 'no_results' OR r.result_count = 0)::int AS unmet
       FROM requests r JOIN categories c ON c.slug = r.category_slug
      WHERE ${market}
      GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 10`,
    marketParams,
  );
  const marketTotals = await one<{ requests: number; unmet: number }>(
    db,
    `SELECT count(*)::int AS requests, count(*) FILTER (WHERE r.status = 'no_results' OR r.result_count = 0)::int AS unmet
       FROM requests r WHERE ${market}`,
    marketParams,
  );
  const byHour = await db.query<{ h: number; n: number }>(`SELECT ${hour("r.created_at")} AS h, count(*)::int AS n FROM requests r WHERE ${market} GROUP BY 1`, marketParams);
  const hours = Array.from({ length: 24 }, (_, h) => byHour.find((r) => r.h === h)?.n ?? 0);

  const t = totals!;
  return {
    days,
    kpis: {
      shown: t.shown,
      shownPrev: t.shown_prev,
      connections: t.connections,
      connectionsPrev: t.connections_prev,
      connectionRate: t.shown ? t.connections / t.shown : null,
      outcomes: { sorted: t.sorted, couldntHelp: t.couldnt_help, noReply: t.no_reply, notYet: t.not_yet },
      rating: t.rating_count ? { average: t.rating_sum / t.rating_count, count: t.rating_count } : null,
    },
    daily,
    topAsks,
    market: { requests: marketTotals?.requests ?? 0, unmet: marketTotals?.unmet ?? 0, demand, hours },
  };
}

/** Customers sent to this business, newest first, by reference code. */
export async function businessCustomers(db: Db, businessId: string, days: number, now: Date) {
  const rows = await db.query<{ ref: string; at: Date; what: string | null; outcome: string | null; rating: number | null }>(
    `SELECT i.ref_code AS ref, i.created_at AS at, coalesce(nullif(r.raw_text, ''), nullif(r.query, '')) AS what, i.outcome, i.rating
       FROM introductions i LEFT JOIN requests r ON r.id = i.request_id
      WHERE i.business_id = $1 AND i.created_at >= $2
      ORDER BY i.created_at DESC LIMIT 500`,
    [businessId, new Date(now.getTime() - days * 24 * 3600_000)],
  );
  return rows.map((r) => ({ ...r, at: new Date(r.at).toISOString() }));
}
