import type { Db } from "../db/client.js";
import { one } from "../db/client.js";
import { align, bucketSql, harareLocal, Params, periodFor, ratio, sum } from "./periods.js";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const FINAL = "('sorted', 'couldnt_help', 'no_reply')";

/** How far customers were from the shop when they asked, in bands. */
const BANDS: [number, string][] = [
  [2, "Under 2 km"],
  [5, "2 to 5 km"],
  [10, "5 to 10 km"],
  [20, "10 to 20 km"],
  [Infinity, "Over 20 km"],
];

/** Kilometres between two points, along the earth's surface. */
function km(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(x)));
}

type Pair = { cur: number[]; prev: number[] };
const measure = (x: Pair) => ({ value: sum(x.cur), prev: sum(x.prev), series: x.cur, prevSeries: x.prev });
/** A share: this period and the one before, per bucket, and the counts behind it (for rolling shares). */
const rate = (n: Pair, d: Pair) => ({
  value: ratio(sum(n.cur), sum(d.cur)),
  prev: ratio(sum(n.prev), sum(d.prev)),
  series: n.cur.map((v, i) => ratio(v, d.cur[i] ?? 0)),
  prevSeries: n.prev.map((v, i) => ratio(v, d.prev[i] ?? 0)),
  parts: { num: n.cur, den: d.cur, prevNum: n.prev, prevDen: d.prev },
});

interface ListingRef {
  id: string;
  area_id: number | null;
  lat?: number | null;
  lng?: number | null;
}

/**
 * What the dashboard shows an owner about one listing over a period (7, 30 or 90 days, or 12 months),
 * against the period before: how often it came up in searches and where in the list, the customers
 * it was sent and how they found it, the products that brought them, where customers asked from, and
 * what people in its categories and city asked for, including what it missed. Counts only; never who
 * the customers are, and nothing about other stores (not even their prices next to its own).
 */
export async function businessAnalytics(db: Db, business: ListingRef, days: number, now: Date) {
  const p = periodFor(days, now);
  const id = business.id;
  const g = p.grain;

  // The market: requests from the public in this business's categories, in its city (anywhere, if
  // it has no area). Requests that didn't say where count too.
  const market = (q: Params) => {
    const biz = q.add(id);
    const area = q.add(business.area_id);
    const sql = `r.category_slug IN (SELECT category_slug FROM business_categories WHERE business_id = ${biz})
       AND r.buyer_business_id IS NULL
       AND (${area}::int IS NULL OR r.area_id IS NULL OR r.area_id IN (
             SELECT a.id FROM areas a WHERE a.city = (SELECT city FROM areas WHERE id = ${area}::int)))`;
    return { sql, biz };
  };
  const shownToMe = (biz: string) => `EXISTS (SELECT 1 FROM request_results x WHERE x.request_id = r.id AND x.business_id = ${biz})`;
  const chose = (biz: string, extra = "") => `EXISTS (SELECT 1 FROM introductions i WHERE i.request_id = r.id AND i.business_id = ${biz}${extra})`;

  const qShown = new Params(id, p.prevStart, p.end);
  const qConn = new Params(id, p.prevStart, p.end);
  const qMarket = new Params(p.prevStart, p.end);
  const marketBoth = market(qMarket);
  const qFunnel = new Params(p.start, p.end);
  const marketNow = market(qFunnel);
  const qAsks = new Params(id, p.start, p.end);
  const qDemand = new Params(p.start, p.end);
  const marketDemand = market(qDemand);
  const qMissed = new Params(p.start, p.end);
  const marketMissed = market(qMissed);
  const qHeat = new Params(p.start, p.end);
  const marketHeat = market(qHeat);
  const qCats = new Params(p.prevStart, p.end, p.start);
  const catBiz = qCats.add(id);
  const catArea = qCats.add(business.area_id);
  const qProducts = new Params(id, p.start, p.end);
  const qAreas = new Params(id, p.start, p.end);

  const [shownRows, connRows, marketRows, funnel, topAsks, demand, missed, heatRows, categories, products, areaRows, totals] = await Promise.all([
    // Each search this business came up in: its place in the list, whether a product of its was shown,
    // and whether the customer then chose it.
    db.query<{ k: string; n: number; pos: number; products: number; chosen: number }>(
      `SELECT ${bucketSql("r.created_at", g)} AS k, count(*)::int AS n, COALESCE(sum(rr.rank + 1), 0)::int AS pos,
              count(rr.offering_id)::int AS products,
              count(*) FILTER (WHERE EXISTS (SELECT 1 FROM introductions i WHERE i.request_id = rr.request_id AND i.business_id = rr.business_id))::int AS chosen
         FROM request_results rr JOIN requests r ON r.id = rr.request_id
        WHERE rr.business_id = $1 AND r.created_at >= $2 AND r.created_at < $3
        GROUP BY 1`,
      qShown.list,
    ),
    // Customers sent, and how they answered our follow-up.
    db.query<{ k: string; n: number; sorted: number; couldnt_help: number; no_reply: number; not_yet: number; answered: number; rated: number; stars: number }>(
      `SELECT ${bucketSql("i.created_at", g)} AS k, count(*)::int AS n,
              count(*) FILTER (WHERE i.outcome = 'sorted')::int AS sorted,
              count(*) FILTER (WHERE i.outcome = 'couldnt_help')::int AS couldnt_help,
              count(*) FILTER (WHERE i.outcome = 'no_reply')::int AS no_reply,
              count(*) FILTER (WHERE i.outcome = 'not_yet')::int AS not_yet,
              count(*) FILTER (WHERE i.outcome IN ${FINAL})::int AS answered,
              count(i.rating)::int AS rated, COALESCE(sum(i.rating), 0)::int AS stars
         FROM introductions i
        WHERE i.business_id = $1 AND i.created_at >= $2 AND i.created_at < $3
        GROUP BY 1`,
      qConn.list,
    ),
    // The market, and this business's share of it.
    db.query<{ k: string; n: number; unmet: number; mine: number }>(
      `SELECT ${bucketSql("r.created_at", g)} AS k, count(*)::int AS n,
              count(*) FILTER (WHERE r.status = 'no_results' OR r.result_count = 0)::int AS unmet,
              count(*) FILTER (WHERE ${shownToMe(marketBoth.biz)})::int AS mine
         FROM requests r
        WHERE r.created_at >= $1 AND r.created_at < $2 AND ${marketBoth.sql}
        GROUP BY 1`,
      qMarket.list,
    ),
    // From demand to customers, this period: each stage within the one before.
    one<{ asked: number; shown: number; chosen: number; answered: number; sorted: number }>(
      db,
      `SELECT count(*)::int AS asked,
              count(*) FILTER (WHERE ${shownToMe(marketNow.biz)})::int AS shown,
              count(*) FILTER (WHERE ${shownToMe(marketNow.biz)} AND ${chose(marketNow.biz)})::int AS chosen,
              count(*) FILTER (WHERE ${shownToMe(marketNow.biz)} AND ${chose(marketNow.biz, ` AND i.outcome IN ${FINAL}`)})::int AS answered,
              count(*) FILTER (WHERE ${shownToMe(marketNow.biz)} AND ${chose(marketNow.biz, " AND i.outcome = 'sorted'")})::int AS sorted
         FROM requests r WHERE r.created_at >= $1 AND r.created_at < $2 AND ${marketNow.sql}`,
      qFunnel.list,
    ),
    // What customers asked for when this business came up.
    db.query<{ what: string; n: number }>(
      `SELECT coalesce(nullif(r.query, ''), c.name, 'other') AS what, count(*)::int AS n
         FROM request_results rr JOIN requests r ON r.id = rr.request_id LEFT JOIN categories c ON c.slug = r.category_slug
        WHERE rr.business_id = $1 AND r.created_at >= $2 AND r.created_at < $3
        GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 8`,
      qAsks.list,
    ),
    // What the market asked for, and what nobody near them had.
    db.query<{ what: string; n: number; unmet: number }>(
      `SELECT coalesce(nullif(r.query, ''), c.name) AS what, count(*)::int AS n,
              count(*) FILTER (WHERE r.status = 'no_results' OR r.result_count = 0)::int AS unmet
         FROM requests r JOIN categories c ON c.slug = r.category_slug
        WHERE r.created_at >= $1 AND r.created_at < $2 AND ${marketDemand.sql}
        GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 10`,
      qDemand.list,
    ),
    // Searches in its categories it didn't come up in: something to add, or a search it lost to stores
    // nearer the customer (it lists the thing already, or the search was a general one).
    db.query<{ what: string; n: number; unmet: number; listed: boolean; general: boolean }>(
      `SELECT m.what, m.n, m.unmet, m.general,
              EXISTS (SELECT 1 FROM offerings o WHERE o.business_id = ${marketMissed.biz} AND o.archived_at IS NULL
                         AND (position(lower(o.name) IN m.what) > 0 OR position(m.what IN lower(o.name)) > 0)) AS listed
         FROM (SELECT lower(coalesce(nullif(r.query, ''), c.name)) AS what, count(*)::int AS n,
                      count(*) FILTER (WHERE r.status = 'no_results' OR r.result_count = 0)::int AS unmet,
                      bool_or(r.query = '' OR lower(r.query) = lower(c.name) OR lower(r.query) = ANY(c.synonyms || c.extra_synonyms)
                              OR lower(r.query) ~ '\\m(shop|shops|store|stores|supplier|suppliers|service|services|company|near me)\\M') AS general
                 FROM requests r JOIN categories c ON c.slug = r.category_slug
                WHERE r.created_at >= $1 AND r.created_at < $2 AND ${marketMissed.sql} AND NOT ${shownToMe(marketMissed.biz)}
                GROUP BY 1) m
        ORDER BY m.n DESC, m.what LIMIT 10`,
      qMissed.list,
    ),
    // When the market asks: day of the week by hour, Harare time.
    db.query<{ d: number; h: number; n: number }>(
      `SELECT extract(isodow FROM ${harareLocal("r.created_at")})::int AS d, extract(hour FROM ${harareLocal("r.created_at")})::int AS h,
              count(*)::int AS n
         FROM requests r WHERE r.created_at >= $1 AND r.created_at < $2 AND ${marketHeat.sql}
        GROUP BY 1, 2`,
      qHeat.list,
    ),
    // Each of its categories: requests now and before, and how many showed this business.
    db.query<{ slug: string; name: string; requests: number; prev: number; mine: number }>(
      `SELECT c.slug, c.name,
              count(r.id) FILTER (WHERE r.created_at >= $3)::int AS requests,
              count(r.id) FILTER (WHERE r.created_at < $3)::int AS prev,
              count(r.id) FILTER (WHERE r.created_at >= $3 AND ${shownToMe(catBiz)})::int AS mine
         FROM business_categories bc JOIN categories c ON c.slug = bc.category_slug
         LEFT JOIN requests r ON r.category_slug = bc.category_slug AND r.created_at >= $1 AND r.created_at < $2
              AND r.buyer_business_id IS NULL
              AND (${catArea}::int IS NULL OR r.area_id IS NULL OR r.area_id IN (
                    SELECT a.id FROM areas a WHERE a.city = (SELECT city FROM areas WHERE id = ${catArea}::int)))
        WHERE bc.business_id = ${catBiz}
        GROUP BY c.slug, c.name ORDER BY requests DESC, c.name`,
      qCats.list,
    ),
    // The products shown with this business, and how often the customer chose it after seeing one.
    db.query<{ id: string; name: string; price: number | null; unit: string | null; shown: number; chosen: number }>(
      `SELECT o.id, o.name, o.price_usd::float8 AS price, o.unit, count(*)::int AS shown,
              count(*) FILTER (WHERE EXISTS (SELECT 1 FROM introductions i WHERE i.request_id = rr.request_id AND i.business_id = rr.business_id))::int AS chosen
         FROM request_results rr JOIN requests r ON r.id = rr.request_id JOIN offerings o ON o.id = rr.offering_id
        WHERE rr.business_id = $1 AND r.created_at >= $2 AND r.created_at < $3
        GROUP BY o.id, o.name, o.price_usd, o.unit ORDER BY shown DESC, chosen DESC, o.name LIMIT 8`,
      qProducts.list,
    ),
    // Where the people it was shown to asked from.
    db.query<{ id: number; name: string; city: string; lat: number; lng: number; shown: number; chosen: number }>(
      `SELECT a.id, a.name, a.city, a.lat, a.lng, count(*)::int AS shown,
              count(*) FILTER (WHERE EXISTS (SELECT 1 FROM introductions i WHERE i.request_id = rr.request_id AND i.business_id = rr.business_id))::int AS chosen
         FROM request_results rr JOIN requests r ON r.id = rr.request_id JOIN areas a ON a.id = r.area_id
        WHERE rr.business_id = $1 AND r.created_at >= $2 AND r.created_at < $3
        GROUP BY a.id, a.name, a.city, a.lat, a.lng ORDER BY shown DESC, a.name LIMIT 200`,
      qAreas.list,
    ),
    one<{ rating_sum: number; rating_count: number }>(db, "SELECT rating_sum, rating_count FROM businesses WHERE id = $1", [id]),
  ]);

  const shown = align(p, shownRows, (r) => r.n);
  const position = align(p, shownRows, (r) => r.pos);
  const productViews = align(p, shownRows, (r) => r.products);
  const chosen = align(p, shownRows, (r) => r.chosen);
  const conn = (key: keyof (typeof connRows)[number]) => align(p, connRows, (r) => Number(r[key]));
  const connections = conn("n");
  const answered = conn("answered");
  const sorted = conn("sorted");
  const marketN = align(p, marketRows, (r) => r.n);
  const marketUnmet = align(p, marketRows, (r) => r.unmet);
  const mine = align(p, marketRows, (r) => r.mine);

  const values = WEEKDAYS.map(() => Array.from({ length: 24 }, () => 0));
  for (const r of heatRows) values[r.d - 1]![r.h] = r.n;
  const hours = Array.from({ length: 24 }, (_, h) => values.reduce((s, row) => s + row[h]!, 0));

  // How far away customers were: by area, measured from the shop's own pin.
  const here = business.lat != null && business.lng != null ? { lat: business.lat, lng: business.lng } : null;
  const areas = areaRows.map((a) => ({ ...a, km: here ? Math.round(km(here, a) * 10) / 10 : null }));
  const distance = here
    ? BANDS.map(([upTo, label], i) => {
        const from = i ? BANDS[i - 1]![0] : 0;
        const inBand = areas.filter((a) => a.km != null && a.km >= from && a.km < upTo);
        return { label, shown: sum(inBand.map((a) => a.shown)), chosen: sum(inBand.map((a) => a.chosen)) };
      })
    : null;

  const t = totals!;
  const outcomes = (side: "cur" | "prev") => ({
    sorted: sum(sorted[side]),
    couldntHelp: sum(conn("couldnt_help")[side]),
    noReply: sum(conn("no_reply")[side]),
    notYet: sum(conn("not_yet")[side]),
  });
  const f = funnel ?? { asked: 0, shown: 0, chosen: 0, answered: 0, sorted: 0 };
  return {
    days,
    grain: g,
    buckets: p.buckets,
    prevBuckets: p.prevBuckets,
    kpis: {
      shown: sum(shown.cur),
      shownPrev: sum(shown.prev),
      connections: sum(connections.cur),
      connectionsPrev: sum(connections.prev),
      // Of the searches it came up in, the share where the customer chose it.
      connectionRate: ratio(sum(chosen.cur), sum(shown.cur)),
      outcomes: outcomes("cur"),
      outcomesPrev: outcomes("prev"),
      rating: t.rating_count ? { average: t.rating_sum / t.rating_count, count: t.rating_count } : null,
    },
    measures: {
      shown: measure(shown),
      connections: measure(connections),
      chosen: rate(chosen, shown),
      satisfaction: rate(sorted, answered),
      share: rate(mine, marketN),
      position: rate(position, shown),
      productViews: measure(productViews),
      rating: rate(conn("stars"), conn("rated")),
    },
    daily: p.buckets.map((date, i) => ({ date, shown: shown.cur[i]!, connections: connections.cur[i]! })),
    previous: p.prevBuckets.map((date, i) => ({ date, shown: shown.prev[i]!, connections: connections.prev[i]! })),
    funnel: [
      { key: "asked", label: "People asked for what you sell", value: f.asked },
      { key: "shown", label: "Your business came up", value: f.shown },
      { key: "chosen", label: "They chose you", value: f.chosen },
      { key: "answered", label: "Answered our follow-up", value: f.answered },
      { key: "sorted", label: "Said “Yes, sorted”", value: f.sorted },
    ],
    topAsks,
    products,
    areas: areas.slice(0, 8),
    distance,
    heat: { rows: WEEKDAYS, values },
    market: {
      requests: sum(marketN.cur),
      requestsPrev: sum(marketN.prev),
      unmet: sum(marketUnmet.cur),
      unmetPrev: sum(marketUnmet.prev),
      mine: sum(mine.cur),
      minePrev: sum(mine.prev),
      series: marketN.cur,
      prevSeries: marketN.prev,
      demand,
      missed,
      hours,
      categories,
    },
  };
}

/**
 * Everyone we sent to a business: when, their reference code and what they asked for. Never how
 * each of them answered our follow-up or rated it: the business knows who a code belongs to, and
 * customers answer honestly only if it stays private. The Overview shows the totals.
 */
export async function businessCustomers(db: Db, businessId: string, days: number, now: Date) {
  const p = periodFor(days, now);
  const rows = await db.query<{ ref: string; at: Date; what: string | null }>(
    `SELECT i.ref_code AS ref, i.created_at AS at, coalesce(nullif(r.raw_text, ''), nullif(r.query, '')) AS what
       FROM introductions i LEFT JOIN requests r ON r.id = i.request_id
      WHERE i.business_id = $1 AND i.created_at >= $2
      ORDER BY i.created_at DESC LIMIT 500`,
    [businessId, p.start],
  );
  return rows.map((r) => ({ ...r, at: new Date(r.at).toISOString() }));
}
