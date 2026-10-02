import type { Db } from "../db/client.js";
import { one } from "../db/client.js";
import { STALE_PRICE_DAYS } from "../web/catalog.js";
import {
  align,
  bucketSql,
  businessScope,
  cumulative,
  harareLocal,
  Params,
  type Period,
  ratio,
  requestScope,
  type Scope,
  scopesRequests,
  sum,
} from "../web/periods.js";

/**
 * The admin portal's analytics: an executive overview, then demand, supply and customer experience.
 * Each page covers one period and compares it with the period just before; filters narrow it to a
 * city or area, and a category group or category. Counts and shares only, never who a customer is.
 *
 * Definitions (docs/DASHBOARDS.md):
 * - a request is anything someone asked us; a search is a request we understood as a search;
 * - found a supplier: a search we answered with at least one business;
 * - a connection is a customer choosing a business (an introduction, with its reference code);
 * - "Yes, sorted" counts final follow-up answers only (sorted, couldn't help, no reply), not "Not yet".
 */

/**
 * A stat tile's numbers: this period, the period before, and one value per bucket for each. A share
 * also carries what it's made of per bucket, so a sparkline can show a steadier rolling share.
 */
export interface Measure {
  value: number | null;
  prev: number | null;
  series: (number | null)[];
  prevSeries: (number | null)[];
  parts?: { num: number[]; den: number[]; prevNum: number[]; prevDen: number[] };
}

type Pair = { cur: number[]; prev: number[] };

const countOf = (x: Pair): Measure => ({ value: sum(x.cur), prev: sum(x.prev), series: x.cur, prevSeries: x.prev });

function rateOf(num: Pair, den: Pair): Measure {
  return {
    value: ratio(sum(num.cur), sum(den.cur)),
    prev: ratio(sum(num.prev), sum(den.prev)),
    series: num.cur.map((n, i) => ratio(n, den.cur[i] ?? 0)),
    prevSeries: num.prev.map((n, i) => ratio(n, den.prev[i] ?? 0)),
    parts: { num: num.cur, den: den.cur, prevNum: num.prev, prevDen: den.prev },
  };
}

/** Something that builds up (businesses, products): its level after each bucket, now and at the start. */
function levelOf(base: number, added: Pair): Measure {
  const prevSeries = cumulative(base, added.prev);
  const atStart = prevSeries.at(-1) ?? base;
  const series = cumulative(atStart, added.cur);
  return { value: series.at(-1) ?? atStart, prev: atStart, series, prevSeries };
}

const SEARCH = "r.interpretation->>'intent' = 'search'";
const CONNECTED = "EXISTS (SELECT 1 FROM introductions i WHERE i.request_id = r.id)";
const FINAL = "('sorted', 'couldnt_help', 'no_reply')";
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// ---------- Building blocks shared by the pages ----------

/** Requests per bucket: all of them, searches, those that found a supplier, and those that led to a connection. */
async function requestCounts(db: Db, scope: Scope, p: Period) {
  const q = new Params(p.prevStart, p.end);
  const rows = await db.query<{ k: string; n: number; searches: number; found: number; unmet: number; connected: number; b2b: number; handoffs: number; local: number; read: number }>(
    `SELECT ${bucketSql("r.created_at", p.grain)} AS k, count(*)::int AS n,
            count(*) FILTER (WHERE ${SEARCH})::int AS searches,
            count(*) FILTER (WHERE r.result_count > 0)::int AS found,
            count(*) FILTER (WHERE ${SEARCH} AND r.result_count = 0)::int AS unmet,
            count(*) FILTER (WHERE ${CONNECTED})::int AS connected,
            count(*) FILTER (WHERE r.buyer_business_id IS NOT NULL)::int AS b2b,
            count(*) FILTER (WHERE r.match = 'none' OR r.status = 'handoff' OR r.interpretation->>'intent' = 'human')::int AS handoffs,
            count(*) FILTER (WHERE r.understood_by IN ('local', 'phrasebook', 'customer'))::int AS local,
            count(*) FILTER (WHERE r.understood_by IS NOT NULL)::int AS read
       FROM requests r
      WHERE r.created_at >= $1 AND r.created_at < $2${requestScope(scope, q)}
      GROUP BY 1`,
    q.list,
  );
  const of = (key: keyof (typeof rows)[number]) => align(p, rows, (r) => Number(r[key]));
  return {
    requests: of("n"),
    searches: of("searches"),
    found: of("found"),
    unmet: of("unmet"),
    connected: of("connected"),
    b2b: of("b2b"),
    handoffs: of("handoffs"),
    local: of("local"),
    read: of("read"),
  };
}

/** People who asked: distinct per bucket, and distinct over each whole period. */
async function customerCounts(db: Db, scope: Scope, p: Period): Promise<Measure> {
  let q = new Params(p.prevStart, p.end);
  const rows = await db.query<{ k: string; n: number }>(
    `SELECT ${bucketSql("r.created_at", p.grain)} AS k, count(DISTINCT r.contact_id)::int AS n
       FROM requests r WHERE r.created_at >= $1 AND r.created_at < $2${requestScope(scope, q)} GROUP BY 1`,
    q.list,
  );
  q = new Params(p.prevStart, p.end, p.start);
  const totals = await one<{ cur: number; prev: number }>(
    db,
    `SELECT count(DISTINCT r.contact_id) FILTER (WHERE r.created_at >= $3)::int AS cur,
            count(DISTINCT r.contact_id) FILTER (WHERE r.created_at < $3)::int AS prev
       FROM requests r WHERE r.created_at >= $1 AND r.created_at < $2${requestScope(scope, q)}`,
    q.list,
  );
  const per = align(p, rows, (r) => r.n);
  return { value: totals?.cur ?? 0, prev: totals?.prev ?? 0, series: per.cur, prevSeries: per.prev };
}

/** Connections per bucket, by how the customer answered our follow-up. Scoped through the request. */
async function connectionCounts(db: Db, scope: Scope, p: Period) {
  const q = new Params(p.prevStart, p.end);
  const scoped = scopesRequests(scope);
  const rows = await db.query<{ k: string; n: number; sorted: number; couldnt_help: number; no_reply: number; not_yet: number; answered: number; rated: number; stars: number }>(
    `SELECT ${bucketSql("i.created_at", p.grain)} AS k, count(*)::int AS n,
            count(*) FILTER (WHERE i.outcome = 'sorted')::int AS sorted,
            count(*) FILTER (WHERE i.outcome = 'couldnt_help')::int AS couldnt_help,
            count(*) FILTER (WHERE i.outcome = 'no_reply')::int AS no_reply,
            count(*) FILTER (WHERE i.outcome = 'not_yet')::int AS not_yet,
            count(*) FILTER (WHERE i.outcome IN ${FINAL})::int AS answered,
            count(i.rating)::int AS rated,
            COALESCE(sum(i.rating), 0)::int AS stars
       FROM introductions i${scoped ? " JOIN requests r ON r.id = i.request_id" : ""}
      WHERE i.created_at >= $1 AND i.created_at < $2${scoped ? requestScope(scope, q) : ""}
      GROUP BY 1`,
    q.list,
  );
  const of = (key: keyof (typeof rows)[number]) => align(p, rows, (r) => Number(r[key]));
  return {
    connections: of("n"),
    sorted: of("sorted"),
    couldntHelp: of("couldnt_help"),
    noReply: of("no_reply"),
    notYet: of("not_yet"),
    answered: of("answered"),
    rated: of("rated"),
    stars: of("stars"),
  };
}

/** Live businesses and their products, built up over time (by when each was added). */
async function supplyLevels(db: Db, scope: Scope, p: Period) {
  let q = new Params(p.prevStart);
  const bScope = businessScope(scope, q);
  const base = await one<{ businesses: number; verified: number; products: number }>(
    db,
    `SELECT
       (SELECT count(*)::int FROM businesses b WHERE b.status = 'active' AND b.created_at < $1${bScope}) AS businesses,
       (SELECT count(*)::int FROM businesses b WHERE b.status = 'active' AND b.verification = 'verified'
           AND COALESCE(b.verified_at, b.created_at) < $1${bScope}) AS verified,
       (SELECT count(*)::int FROM offerings o JOIN businesses b ON b.id = o.business_id
         WHERE o.archived_at IS NULL AND b.status = 'active' AND o.created_at < $1${bScope}) AS products`,
    q.list,
  );
  q = new Params(p.prevStart);
  const bScope2 = businessScope(scope, q);
  const added = await db.query<{ k: string; kind: string; n: number }>(
    `SELECT ${bucketSql("b.created_at", p.grain)} AS k, 'businesses' AS kind, count(*)::int AS n
       FROM businesses b WHERE b.status = 'active' AND b.created_at >= $1${bScope2} GROUP BY 1
     UNION ALL
     SELECT ${bucketSql("COALESCE(b.verified_at, b.created_at)", p.grain)} AS k, 'verified' AS kind, count(*)::int AS n
       FROM businesses b WHERE b.status = 'active' AND b.verification = 'verified'
        AND COALESCE(b.verified_at, b.created_at) >= $1${bScope2} GROUP BY 1
     UNION ALL
     SELECT ${bucketSql("o.created_at", p.grain)} AS k, 'products' AS kind, count(*)::int AS n
       FROM offerings o JOIN businesses b ON b.id = o.business_id
      WHERE o.archived_at IS NULL AND b.status = 'active' AND o.created_at >= $1${bScope2} GROUP BY 1`,
    q.list,
  );
  const kind = (name: string) => align(p, added.filter((r) => r.kind === name), (r) => r.n);
  const newBusinesses = kind("businesses");
  return {
    businesses: levelOf(base?.businesses ?? 0, newBusinesses),
    verified: levelOf(base?.verified ?? 0, kind("verified")),
    products: levelOf(base?.products ?? 0, kind("products")),
    newBusinesses: countOf(newBusinesses),
    newProducts: countOf(kind("products")),
  };
}

/** From asking to "Yes, sorted", for requests made in this period. Each stage is a share of the first. */
async function requestFunnel(db: Db, scope: Scope, p: Period) {
  const q = new Params(p.start, p.end);
  const f = await one<{ asked: number; understood: number; found: number; connected: number; answered: number; sorted: number }>(
    db,
    `SELECT count(*)::int AS asked,
            count(*) FILTER (WHERE ${SEARCH})::int AS understood,
            count(*) FILTER (WHERE r.result_count > 0)::int AS found,
            count(*) FILTER (WHERE ${CONNECTED})::int AS connected,
            count(*) FILTER (WHERE EXISTS (SELECT 1 FROM introductions i WHERE i.request_id = r.id AND i.outcome IN ${FINAL}))::int AS answered,
            count(*) FILTER (WHERE EXISTS (SELECT 1 FROM introductions i WHERE i.request_id = r.id AND i.outcome = 'sorted'))::int AS sorted
       FROM requests r WHERE r.created_at >= $1 AND r.created_at < $2${requestScope(scope, q)}`,
    q.list,
  );
  return [
    { key: "asked", label: "Asked us", value: f?.asked ?? 0 },
    { key: "understood", label: "Understood as a search", value: f?.understood ?? 0 },
    { key: "found", label: "Found a supplier", value: f?.found ?? 0 },
    { key: "connected", label: "Connected to a business", value: f?.connected ?? 0 },
    { key: "answered", label: "Answered our follow-up", value: f?.answered ?? 0 },
    { key: "sorted", label: "Said “Yes, sorted”", value: f?.sorted ?? 0 },
  ];
}

/** Requests per category in this period and the one before, and how many found nobody. Leaves out
 *  the category filter (and the group filter, unless asked), so the chosen one shows among the rest. */
async function categoryDemand(db: Db, scope: Scope, p: Period, { keepGroup = false } = {}) {
  const q = new Params(p.prevStart, p.end, p.start);
  const kindScope = keepGroup && scope.group && !scope.category ? requestScope({ group: scope.group }, q, "r", { place: false }) : "";
  return db.query<{ slug: string; name: string; group: string; requests: number; prev: number; unmet: number; connected: number }>(
    `SELECT c.slug, c.name, c.group_name AS "group",
            count(*) FILTER (WHERE r.created_at >= $3)::int AS requests,
            count(*) FILTER (WHERE r.created_at < $3)::int AS prev,
            count(*) FILTER (WHERE r.created_at >= $3 AND ${SEARCH} AND r.result_count = 0)::int AS unmet,
            count(*) FILTER (WHERE r.created_at >= $3 AND ${CONNECTED})::int AS connected
       FROM requests r JOIN categories c ON c.slug = r.category_slug
      WHERE r.created_at >= $1 AND r.created_at < $2 AND c.group_name <> 'Blocked'${requestScope(scope, q, "r", { kind: false })}${kindScope}
      GROUP BY c.slug, c.name, c.group_name
      ORDER BY requests DESC, c.name`,
    q.list,
  );
}

/** Live and verified businesses per category, for the same place. */
async function categorySupply(db: Db, scope: Scope) {
  const q = new Params();
  return db.query<{ slug: string; businesses: number; verified: number }>(
    `SELECT bc.category_slug AS slug, count(*)::int AS businesses,
            count(*) FILTER (WHERE b.verification = 'verified')::int AS verified
       FROM business_categories bc JOIN businesses b ON b.id = bc.business_id
      WHERE b.status = 'active'${businessScope(scope, q, "b", { kind: false })}
      GROUP BY 1`,
    q.list,
  );
}

/** Demand and supply side by side for every category with either: where to sign businesses up next. */
async function categoryTable(db: Db, scope: Scope, p: Period) {
  const [demand, supply, names] = await Promise.all([
    categoryDemand(db, scope, p, { keepGroup: true }),
    categorySupply(db, scope),
    db.query<{ slug: string; name: string; group: string }>(`SELECT slug, name, group_name AS "group" FROM categories WHERE group_name <> 'Blocked'`),
  ]);
  const supplyOf = new Map(supply.map((s) => [s.slug, s]));
  const rows = new Map(demand.map((d) => [d.slug, { ...d, businesses: 0, verified: 0 }]));
  for (const s of supply) {
    if (rows.has(s.slug)) continue;
    const c = names.find((n) => n.slug === s.slug);
    if (!c || (scope.group && !scope.category && c.group !== scope.group)) continue;
    rows.set(s.slug, { ...c, requests: 0, prev: 0, unmet: 0, connected: 0, businesses: 0, verified: 0 });
  }
  return [...rows.values()]
    .map((r) => {
      const s = supplyOf.get(r.slug);
      const businesses = s?.businesses ?? 0;
      return { ...r, businesses, verified: s?.verified ?? 0, perBusiness: businesses ? r.requests / businesses : null };
    })
    .sort((a, b) => b.requests - a.requests || b.businesses - a.businesses || a.name.localeCompare(b.name));
}

/** Where requests came from: suburbs when narrowed to a city (or an area), otherwise cities. Leaves
 *  out the area filter so the chosen area shows among the rest of its city. */
async function demandMap(db: Db, scope: Scope, p: Period) {
  let city = scope.city ?? null;
  if (scope.areaId != null) city = (await one<{ city: string }>(db, "SELECT city FROM areas WHERE id = $1", [scope.areaId]))?.city ?? city;
  const q = new Params(p.start, p.end);
  const kind = requestScope(scope, q, "r", { place: false });
  if (city) {
    const cityParam = q.add(city);
    const points = await db.query<{ id: number; name: string; lat: number; lng: number; requests: number; unmet: number }>(
      `SELECT a.id, a.name, a.lat, a.lng, count(*)::int AS requests,
              count(*) FILTER (WHERE ${SEARCH} AND r.result_count = 0)::int AS unmet
         FROM requests r JOIN areas a ON a.id = r.area_id
        WHERE r.created_at >= $1 AND r.created_at < $2 AND a.city = ${cityParam} AND a.name <> a.city${kind}
        GROUP BY a.id, a.name, a.lat, a.lng ORDER BY requests DESC, a.name LIMIT 80`,
      q.list,
    );
    const q2 = new Params(p.start, p.end);
    const kind2 = requestScope(scope, q2, "r", { place: false });
    const c2 = q2.add(city);
    // Requests that named only the city ("in Harare"), which have no suburb to show.
    const rest = await one<{ city_wide: number }>(
      db,
      `SELECT count(*) FILTER (WHERE a.name = a.city)::int AS city_wide
         FROM requests r JOIN areas a ON a.id = r.area_id
        WHERE r.created_at >= $1 AND r.created_at < $2 AND a.city = ${c2}${kind2}`,
      q2.list,
    );
    const centre = await one<{ lat: number; lng: number }>(db, "SELECT lat, lng FROM areas WHERE city = $1 AND name = $1", [city]);
    return { level: "area" as const, city, centre: centre ?? null, points, cityWide: rest?.city_wide ?? 0 };
  }
  const points = await db.query<{ id: string; name: string; lat: number; lng: number; requests: number; unmet: number }>(
    `SELECT a.city AS id, a.city AS name,
            COALESCE(max(c.lat), avg(a.lat))::float8 AS lat, COALESCE(max(c.lng), avg(a.lng))::float8 AS lng,
            count(*)::int AS requests, count(*) FILTER (WHERE ${SEARCH} AND r.result_count = 0)::int AS unmet
       FROM requests r JOIN areas a ON a.id = r.area_id
       LEFT JOIN areas c ON c.city = a.city AND c.name = a.city
      WHERE r.created_at >= $1 AND r.created_at < $2${kind}
      GROUP BY a.city ORDER BY requests DESC, a.city`,
    q.list,
  );
  const q3 = new Params(p.start, p.end);
  const unplaced = await one<{ n: number }>(
    db,
    `SELECT count(*)::int AS n FROM requests r WHERE r.created_at >= $1 AND r.created_at < $2 AND r.area_id IS NULL${requestScope(scope, q3, "r", { place: false })}`,
    q3.list,
  );
  return { level: "city" as const, city: null, centre: null, points, unplaced: unplaced?.n ?? 0 };
}

/** Requests by day of the week and hour of the day, Harare time. Monday first. */
async function weekHours(db: Db, scope: Scope, p: Period) {
  const q = new Params(p.start, p.end);
  const rows = await db.query<{ d: number; h: number; n: number }>(
    `SELECT extract(isodow FROM ${harareLocal("r.created_at")})::int AS d, extract(hour FROM ${harareLocal("r.created_at")})::int AS h,
            count(*)::int AS n
       FROM requests r WHERE r.created_at >= $1 AND r.created_at < $2${requestScope(scope, q)}
      GROUP BY 1, 2`,
    q.list,
  );
  const values = WEEKDAYS.map(() => Array.from({ length: 24 }, () => 0));
  for (const r of rows) values[r.d - 1]![r.h] = r.n;
  return { rows: WEEKDAYS, values };
}

/** What the filters can be set to. */
export async function filterOptions(db: Db) {
  const [cities, categories] = await Promise.all([
    db.query<{ city: string }>("SELECT DISTINCT city FROM areas ORDER BY city"),
    db.query<{ slug: string; name: string; group: string }>(
      `SELECT slug, name, group_name AS "group" FROM categories WHERE group_name <> 'Blocked' ORDER BY group_name, name`,
    ),
  ]);
  return {
    cities: cities.map((c) => c.city),
    groups: [...new Set(categories.map((c) => c.group))],
    categories,
  };
}

/** The names behind a scope, for the page's subtitle and filter chips. */
async function describeScope(db: Db, scope: Scope) {
  const area = scope.areaId != null ? await one<{ id: number; name: string; city: string }>(db, "SELECT id, name, city FROM areas WHERE id = $1", [scope.areaId]) : null;
  const category = scope.category ? await one<{ slug: string; name: string; group: string }>(db, `SELECT slug, name, group_name AS "group" FROM categories WHERE slug = $1`, [scope.category]) : null;
  return { city: area?.city ?? scope.city ?? null, area: area ?? null, category: category ?? null, group: category?.group ?? scope.group ?? null };
}

function periodInfo(p: Period) {
  return { days: p.days, grain: p.grain, start: p.start.toISOString(), end: p.end.toISOString(), prevStart: p.prevStart.toISOString(), buckets: p.buckets, prevBuckets: p.prevBuckets };
}

// ---------- The pages ----------

/** The executive overview: headline measures, the funnel, demand by category and place, and when. */
export async function overviewInsights(db: Db, scope: Scope, p: Period) {
  const [r, customers, c, supply, funnel, categories, map, heat, described] = await Promise.all([
    requestCounts(db, scope, p),
    customerCounts(db, scope, p),
    connectionCounts(db, scope, p),
    supplyLevels(db, scope, p),
    requestFunnel(db, scope, p),
    categoryDemand(db, scope, p),
    demandMap(db, scope, p),
    weekHours(db, scope, p),
    describeScope(db, scope),
  ]);
  return {
    period: periodInfo(p),
    scope: described,
    kpis: {
      requests: countOf(r.requests),
      customers,
      found: rateOf(r.found, r.searches),
      connections: countOf(c.connections),
      connectionRate: rateOf(r.connected, r.requests),
      sorted: rateOf(c.sorted, c.answered),
      businesses: supply.businesses,
      products: supply.products,
    },
    newBusinesses: supply.newBusinesses.value,
    newProducts: supply.newProducts.value,
    funnel,
    categories: categories.slice(0, 10),
    map,
    heat,
  };
}

/** Demand: what people ask for, where, how well we answer it, and what nobody could supply. */
export async function demandInsights(db: Db, scope: Scope, p: Period) {
  const q1 = new Params(p.prevStart, p.end);
  const q2 = new Params(p.start, p.end);
  const q3 = new Params(p.start, p.end);
  const q4 = new Params(p.start, p.end);
  const q5 = new Params(p.start, p.end);
  const [r, table, byGroup, top, unmet, cells, understood, described] = await Promise.all([
    requestCounts(db, scope, p),
    categoryTable(db, scope, p),
    db.query<{ k: string; g: string; n: number }>(
      `SELECT ${bucketSql("r.created_at", p.grain)} AS k, COALESCE(c.group_name, 'Other') AS g, count(*)::int AS n
         FROM requests r LEFT JOIN categories c ON c.slug = r.category_slug
        WHERE r.created_at >= $1 AND r.created_at < $2${requestScope(scope, q1)}
        GROUP BY 1, 2`,
      q1.list,
    ),
    db.query<{ what: string; n: number; unmet: number }>(
      `SELECT lower(r.query) AS what, count(*)::int AS n, count(*) FILTER (WHERE r.result_count = 0)::int AS unmet
         FROM requests r
        WHERE r.created_at >= $1 AND r.created_at < $2 AND r.query <> '' AND ${SEARCH}${requestScope(scope, q2)}
        GROUP BY 1 ORDER BY n DESC, what LIMIT 12`,
      q2.list,
    ),
    db.query<{ what: string; n: number; category: string | null; areas: string[] | null }>(
      `WITH unmet AS (
         SELECT lower(r.query) AS what, r.category_slug, r.area_id
           FROM requests r
          WHERE r.created_at >= $1 AND r.created_at < $2 AND r.query <> '' AND ${SEARCH} AND r.result_count = 0${requestScope(scope, q3)}),
       top AS (
         SELECT u.what, count(*)::int AS n, min(c.name) AS category
           FROM unmet u LEFT JOIN categories c ON c.slug = u.category_slug
          GROUP BY u.what ORDER BY n DESC, u.what LIMIT 12),
       places AS (
         SELECT u.what, a.name, row_number() OVER (PARTITION BY u.what ORDER BY count(*) DESC, a.name) AS rank
           FROM unmet u JOIN areas a ON a.id = u.area_id
          WHERE a.name <> a.city AND u.what IN (SELECT what FROM top)
          GROUP BY u.what, a.name)
       SELECT t.what, t.n, t.category,
              ARRAY(SELECT p.name FROM places p WHERE p.what = t.what AND p.rank <= 3 ORDER BY p.rank) AS areas
         FROM top t ORDER BY t.n DESC, t.what`,
      q3.list,
    ),
    db.query<{ area_id: number; area: string; city: string; category: string; short: string; n: number }>(
      `SELECT a.id AS area_id, a.name AS area, a.city, c.name AS category, COALESCE(c.short_name, c.name) AS short, count(*)::int AS n
         FROM requests r JOIN areas a ON a.id = r.area_id JOIN categories c ON c.slug = r.category_slug
        WHERE r.created_at >= $1 AND r.created_at < $2 AND c.group_name <> 'Blocked' AND a.name <> a.city${requestScope(scope, q4)}
        GROUP BY 1, 2, 3, 4, 5`,
      q4.list,
    ),
    db.query<{ by: string; n: number }>(
      `SELECT COALESCE(r.understood_by, 'unknown') AS by, count(*)::int AS n
         FROM requests r WHERE r.created_at >= $1 AND r.created_at < $2${requestScope(scope, q5)} GROUP BY 1 ORDER BY n DESC`,
      q5.list,
    ),
    describeScope(db, scope),
  ]);

  // The five busiest groups this period, everything else as "Other".
  const totals = new Map<string, number>();
  const groupKeys = new Set(p.buckets);
  for (const row of byGroup) if (groupKeys.has(row.k)) totals.set(row.g, (totals.get(row.g) ?? 0) + row.n);
  const leaders = [...totals.entries()]
    .filter(([g]) => g !== "Other")
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([g]) => g);
  const groupSeries = [...leaders, "Other"].map((name) => ({
    name,
    values: align(
      p,
      byGroup.filter((row) => (name === "Other" ? !leaders.includes(row.g) : row.g === name)).reduce<{ k: string; n: number }[]>((acc, row) => {
        const hit = acc.find((x) => x.k === row.k);
        if (hit) hit.n += row.n;
        else acc.push({ k: row.k, n: row.n });
        return acc;
      }, []),
      (row) => row.n,
    ).cur,
  }));

  // Areas against categories: the ten busiest areas by the eight busiest categories.
  const byArea = new Map<number, { name: string; n: number }>();
  const byCat = new Map<string, number>();
  for (const c of cells) {
    const a = byArea.get(c.area_id) ?? { name: scope.city || scope.areaId != null ? c.area : `${c.area}, ${c.city}`, n: 0 };
    a.n += c.n;
    byArea.set(c.area_id, a);
    byCat.set(c.category, (byCat.get(c.category) ?? 0) + c.n);
  }
  const areaIds = [...byArea.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 10).map(([id]) => id);
  const catNames = [...byCat.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name]) => name);
  const matrix = areaIds.map((id) => catNames.map((cat) => cells.find((c) => c.area_id === id && c.category === cat)?.n ?? 0));

  return {
    period: periodInfo(p),
    scope: described,
    kpis: {
      requests: countOf(r.requests),
      found: rateOf(r.found, r.searches),
      unmet: countOf(r.unmet),
      b2b: countOf(r.b2b),
      handoffs: rateOf(r.handoffs, r.requests),
      local: rateOf(r.local, r.read),
    },
    byGroup: groupSeries,
    categories: table,
    topSearches: top,
    unmetSearches: unmet.map((u) => ({ ...u, areas: u.areas ?? [] })),
    areaCategory: {
      rows: areaIds.map((id) => byArea.get(id)!.name),
      rowIds: areaIds,
      cols: catNames.map((name) => cells.find((c) => c.category === name)?.short ?? name),
      colNames: catNames,
      values: matrix,
    },
    understood,
  };
}

/** Supply: businesses and products, how they joined, where demand outruns them, and who does best. */
export async function supplyInsights(db: Db, scope: Scope, p: Period, now: Date) {
  const qs = new Params(p.start);
  const qc = new Params(new Date(now.getTime() - STALE_PRICE_DAYS * 24 * 3600_000));
  const qo = new Params(p.prevStart, p.end, p.start);
  const qa = new Params(p.prevStart, p.end);
  const ql = new Params(p.start, p.end);
  const qw = new Params(p.start, p.end);
  const qp = new Params(p.prevStart, p.end);
  const [supply, sources, catalogue, owners, ownerSeries, signups, signupSeries, activity, table, leaders, watch, described] = await Promise.all([
    supplyLevels(db, scope, p),
    db.query<{ how: string; n: number; recent: number }>(
      `SELECT CASE WHEN EXISTS (SELECT 1 FROM web_registrations w WHERE w.business_id = b.id) THEN 'website'
                   WHEN b.source = 'self' THEN 'whatsapp' ELSE b.source END AS how,
              count(*)::int AS n, count(*) FILTER (WHERE b.created_at >= $1)::int AS recent
         FROM businesses b WHERE b.status = 'active'${businessScope(scope, qs)}
        GROUP BY 1 ORDER BY n DESC`,
      qs.list,
    ),
    one<{ total: number; priced: number; photo: number; fresh: number; in_stock: number; with_products: number; businesses: number }>(
      db,
      `SELECT count(o.id)::int AS total,
              count(o.id) FILTER (WHERE o.price_usd IS NOT NULL)::int AS priced,
              count(o.id) FILTER (WHERE o.photo_id IS NOT NULL)::int AS photo,
              count(o.id) FILTER (WHERE o.price_usd IS NOT NULL AND o.price_updated_at >= $1)::int AS fresh,
              count(o.id) FILTER (WHERE o.in_stock)::int AS in_stock,
              count(DISTINCT o.business_id)::int AS with_products,
              (SELECT count(*)::int FROM businesses b WHERE b.status = 'active'${businessScope(scope, qc)}) AS businesses
         FROM businesses b JOIN offerings o ON o.business_id = b.id AND o.archived_at IS NULL
        WHERE b.status = 'active'${businessScope(scope, qc)}`,
      qc.list,
    ),
    one<{ cur: number; prev: number; owners: number }>(
      db,
      `SELECT count(DISTINCT s.contact_id) FILTER (WHERE s.created_at >= $3)::int AS cur,
              count(DISTINCT s.contact_id) FILTER (WHERE s.created_at < $3)::int AS prev,
              (SELECT count(DISTINCT b.owner_contact_id)::int FROM businesses b WHERE b.status = 'active' AND b.owner_contact_id IS NOT NULL${businessScope(scope, qo)}) AS owners
         FROM owner_sessions s
        WHERE s.created_at >= $1 AND s.created_at < $2
          AND s.contact_id IN (SELECT b.owner_contact_id FROM businesses b WHERE b.status = 'active'${businessScope(scope, qo)})`,
      qo.list,
    ),
    db.query<{ k: string; n: number }>(
      `SELECT ${bucketSql("s.created_at", p.grain)} AS k, count(DISTINCT s.contact_id)::int AS n
         FROM owner_sessions s
        WHERE s.created_at >= $1 AND s.created_at < $2
          AND s.contact_id IN (SELECT b.owner_contact_id FROM businesses b WHERE b.status = 'active'${businessScope(scope, qa)})
        GROUP BY 1`,
      qa.list,
    ),
    one<{ started: number; completed: number; listed: number }>(
      db,
      `SELECT count(*)::int AS started, count(*) FILTER (WHERE w.completed_at IS NOT NULL)::int AS completed,
              count(*) FILTER (WHERE EXISTS (SELECT 1 FROM businesses b WHERE b.id = w.business_id AND b.status = 'active'))::int AS listed
         FROM web_registrations w WHERE w.created_at >= $1 AND w.created_at < $2`,
      [p.start, p.end],
    ),
    db.query<{ k: string; n: number; done: number }>(
      `SELECT ${bucketSql("w.created_at", p.grain)} AS k, count(*)::int AS n, count(*) FILTER (WHERE w.completed_at IS NOT NULL)::int AS done
         FROM web_registrations w WHERE w.created_at >= $1 AND w.created_at < $2 GROUP BY 1`,
      [p.prevStart, p.end],
    ),
    db.query<{ k: string; n: number }>(
      `SELECT ${bucketSql("pc.created_at", p.grain)} AS k, count(*)::int AS n
         FROM offering_price_changes pc JOIN businesses b ON b.id = pc.business_id
        WHERE pc.created_at >= $1 AND pc.created_at < $2${businessScope(scope, qp)}
        GROUP BY 1`,
      qp.list,
    ),
    categoryTable(db, scope, p),
    db.query<{
      id: string;
      name: string;
      verification: string;
      area: string | null;
      category: string | null;
      shown: number;
      connections: number;
      sorted: number;
      answered: number;
      rating: number | null;
      products: number;
    }>(
      `WITH shown AS (
         SELECT rr.business_id, count(*)::int AS n FROM request_results rr JOIN requests r ON r.id = rr.request_id
          WHERE r.created_at >= $1 AND r.created_at < $2 GROUP BY 1),
       conn AS (
         SELECT i.business_id, count(*)::int AS n, count(*) FILTER (WHERE i.outcome = 'sorted')::int AS sorted,
                count(*) FILTER (WHERE i.outcome IN ${FINAL})::int AS answered
           FROM introductions i WHERE i.created_at >= $1 AND i.created_at < $2 GROUP BY 1)
       SELECT b.id, b.name, b.verification, a.name AS area,
              (SELECT c.name FROM business_categories bc JOIN categories c ON c.slug = bc.category_slug
                WHERE bc.business_id = b.id ORDER BY c.name LIMIT 1) AS category,
              COALESCE(s.n, 0)::int AS shown, COALESCE(cn.n, 0)::int AS connections,
              COALESCE(cn.sorted, 0)::int AS sorted, COALESCE(cn.answered, 0)::int AS answered,
              CASE WHEN b.rating_count > 0 THEN b.rating_sum::float8 / b.rating_count END AS rating,
              (SELECT count(*)::int FROM offerings o WHERE o.business_id = b.id AND o.archived_at IS NULL) AS products
         FROM businesses b LEFT JOIN areas a ON a.id = b.area_id
         LEFT JOIN shown s ON s.business_id = b.id LEFT JOIN conn cn ON cn.business_id = b.id
        WHERE b.status = 'active' AND (COALESCE(s.n, 0) > 0 OR COALESCE(cn.n, 0) > 0)${businessScope(scope, ql)}
        ORDER BY connections DESC, shown DESC, b.name LIMIT 15`,
      ql.list,
    ),
    db.query<{ id: string; name: string; area: string | null; verification: string; shown: number; connections: number; reports: number; score: number }>(
      `WITH shown AS (
         SELECT rr.business_id, count(*)::int AS n FROM request_results rr JOIN requests r ON r.id = rr.request_id
          WHERE r.created_at >= $1 AND r.created_at < $2 GROUP BY 1),
       conn AS (SELECT business_id, count(*)::int AS n FROM introductions WHERE created_at >= $1 AND created_at < $2 GROUP BY 1),
       open_reports AS (SELECT business_id, count(*)::int AS n FROM reports WHERE status = 'open' GROUP BY 1)
       SELECT b.id, b.name, a.name AS area, b.verification, COALESCE(s.n, 0)::int AS shown, COALESCE(cn.n, 0)::int AS connections,
              COALESCE(o.n, 0)::int AS reports, b.response_score AS score
         FROM businesses b LEFT JOIN areas a ON a.id = b.area_id LEFT JOIN shown s ON s.business_id = b.id
         LEFT JOIN conn cn ON cn.business_id = b.id LEFT JOIN open_reports o ON o.business_id = b.id
        WHERE b.status = 'active'${businessScope(scope, qw)}
          AND ((COALESCE(s.n, 0) >= 5 AND COALESCE(cn.n, 0) = 0) OR COALESCE(o.n, 0) > 0 OR b.response_score < 0.3)
        ORDER BY COALESCE(o.n, 0) DESC, COALESCE(s.n, 0) DESC, b.name LIMIT 12`,
      qw.list,
    ),
    describeScope(db, scope),
  ]);

  const ownersPer = align(p, ownerSeries, (r) => r.n);
  const started = align(p, signupSeries, (r) => r.n);
  const done = align(p, signupSeries, (r) => r.done);
  const cat = catalogue ?? { total: 0, priced: 0, photo: 0, fresh: 0, in_stock: 0, with_products: 0, businesses: 0 };
  return {
    period: periodInfo(p),
    scope: described,
    kpis: {
      businesses: supply.businesses,
      verified: supply.verified,
      newBusinesses: supply.newBusinesses,
      signups: countOf(started),
      owners: { value: owners?.cur ?? 0, prev: owners?.prev ?? 0, series: ownersPer.cur, prevSeries: ownersPer.prev },
      products: supply.products,
    },
    owners: owners?.owners ?? 0,
    growth: { businesses: supply.businesses.series, verified: supply.verified.series },
    sources,
    signups: { started: signups?.started ?? 0, completed: signups?.completed ?? 0, listed: signups?.listed ?? 0, completedSeries: done.cur },
    catalogue: {
      total: cat.total,
      priced: cat.priced,
      photo: cat.photo,
      fresh: cat.fresh,
      inStock: cat.in_stock,
      withProducts: cat.with_products,
      businesses: cat.businesses,
      staleDays: STALE_PRICE_DAYS,
    },
    activity: { added: supply.newProducts.series, priceChanges: align(p, activity, (r) => r.n).cur },
    coverage: table,
    leaders,
    watch: watch.map((w) => ({
      ...w,
      reasons: [
        w.reports ? `${w.reports} open report${w.reports === 1 ? "" : "s"}` : null,
        w.shown >= 5 && !w.connections ? `shown ${w.shown} times, never chosen` : null,
        w.score < 0.3 ? "rarely replies to customers" : null,
      ].filter(Boolean),
    })),
  };
}

/** Customer experience: who asks, who comes back, how follow-ups were answered, ratings and reports. */
export async function customerInsights(db: Db, scope: Scope, p: Period, now: Date) {
  const qn = new Params(p.prevStart, p.end);
  const qr = new Params(p.prevStart, p.end, p.start);
  const qx = new Params(p.prevStart, p.end);
  const qa = new Params(p.prevStart, p.end);
  const qs = new Params(p.prevStart, p.end);
  const qt = new Params(p.start, p.end);
  const scoped = scopesRequests(scope);
  // Weekly cohorts: the last eight whole weeks of first-time customers, and how many came back in each week after.
  const weekStart = (d: Date) => {
    const local = new Date(d.getTime() + 2 * 3600_000);
    const monday = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - ((local.getUTCDay() + 6) % 7) * 24 * 3600_000;
    return new Date(monday - 2 * 3600_000);
  };
  const thisWeek = weekStart(now);
  const cohortFrom = new Date(thisWeek.getTime() - 8 * 7 * 24 * 3600_000);
  const qc = new Params(cohortFrom, thisWeek);
  const qd = new Params(cohortFrom);
  const placeOnly = (q: Params) => requestScope(scope, q, "r", { kind: false });

  const [customers, mix, repeat, c, ratings, reports, alerts, stopped, cohortSizes, cohortActivity, described] = await Promise.all([
    customerCounts(db, scope, p),
    // New and returning customers per bucket: new in the bucket of their first request ever.
    db.query<{ k: string; fresh: number; back: number }>(
      `WITH firsts AS (SELECT contact_id, min(created_at) AS first_at FROM requests GROUP BY contact_id)
       SELECT ${bucketSql("r.created_at", p.grain)} AS k,
              count(DISTINCT r.contact_id) FILTER (WHERE ${bucketSql("f.first_at", p.grain)} = ${bucketSql("r.created_at", p.grain)})::int AS fresh,
              count(DISTINCT r.contact_id) FILTER (WHERE ${bucketSql("f.first_at", p.grain)} < ${bucketSql("r.created_at", p.grain)})::int AS back
         FROM requests r JOIN firsts f ON f.contact_id = r.contact_id
        WHERE r.created_at >= $1 AND r.created_at < $2${requestScope(scope, qn)}
        GROUP BY 1`,
      qn.list,
    ),
    // Customers who asked on more than one day within each period, and the new ones (first request ever).
    one<{ cur: number; cur_back: number; prev: number; prev_back: number; cur_new: number; prev_new: number }>(
      db,
      `WITH firsts AS (SELECT contact_id, min(created_at) AS first_at FROM requests GROUP BY contact_id),
       per AS (
         SELECT r.contact_id, (r.created_at >= $3) AS current,
                count(DISTINCT ${harareLocal("r.created_at")}::date) AS days
           FROM requests r WHERE r.created_at >= $1 AND r.created_at < $2${requestScope(scope, qr)}
          GROUP BY 1, 2)
       SELECT count(*) FILTER (WHERE per.current)::int AS cur,
              count(*) FILTER (WHERE per.current AND per.days > 1)::int AS cur_back,
              count(*) FILTER (WHERE NOT per.current)::int AS prev,
              count(*) FILTER (WHERE NOT per.current AND per.days > 1)::int AS prev_back,
              count(*) FILTER (WHERE per.current AND f.first_at >= $3)::int AS cur_new,
              count(*) FILTER (WHERE NOT per.current AND f.first_at >= $1 AND f.first_at < $3)::int AS prev_new
         FROM per JOIN firsts f ON f.contact_id = per.contact_id`,
      qr.list,
    ),
    connectionCounts(db, scope, p),
    db.query<{ stars: number; n: number }>(
      `SELECT i.rating AS stars, count(*)::int AS n
         FROM introductions i${scoped ? " JOIN requests r ON r.id = i.request_id" : ""}
        WHERE i.rating IS NOT NULL AND i.created_at >= $1 AND i.created_at < $2${scoped ? requestScope(scope, qt) : ""}
        GROUP BY 1`,
      qt.list,
    ),
    db.query<{ k: string; n: number }>(
      `SELECT ${bucketSql("rp.created_at", p.grain)} AS k, count(*)::int AS n
         FROM reports rp JOIN businesses b ON b.id = rp.business_id
        WHERE rp.created_at >= $1 AND rp.created_at < $2${businessScope(scope, qx)}
        GROUP BY 1`,
      qx.list,
    ),
    db.query<{ k: string; n: number }>(
      `SELECT ${bucketSql("pa.created_at", p.grain)} AS k, count(*)::int AS n
         FROM product_alerts pa JOIN requests r ON r.id = pa.request_id
        WHERE pa.created_at >= $1 AND pa.created_at < $2${requestScope(scope, qa)}
        GROUP BY 1`,
      qa.list,
    ),
    db.query<{ k: string; n: number }>(
      `SELECT ${bucketSql("c.stopped_at", p.grain)} AS k, count(*)::int AS n
         FROM contacts c WHERE c.channel = 'customer' AND c.stopped_at >= $1 AND c.stopped_at < $2
          ${scoped ? `AND EXISTS (SELECT 1 FROM requests r WHERE r.contact_id = c.id${requestScope(scope, qs)})` : ""}
        GROUP BY 1`,
      qs.list,
    ),
    db.query<{ week: string; n: number }>(
      `WITH firsts AS (SELECT r.contact_id, min(r.created_at) AS first_at FROM requests r WHERE true${placeOnly(qc)} GROUP BY 1)
       SELECT date_trunc('week', ${harareLocal("first_at")})::date::text AS week, count(*)::int AS n
         FROM firsts WHERE first_at >= $1 AND first_at < $2 GROUP BY 1`,
      qc.list,
    ),
    db.query<{ week: string; k: number; n: number }>(
      `WITH firsts AS (SELECT r.contact_id, min(r.created_at) AS first_at FROM requests r WHERE true${placeOnly(qd)} GROUP BY 1),
       cohort AS (SELECT contact_id, date_trunc('week', ${harareLocal("first_at")})::date AS w FROM firsts WHERE first_at >= $1),
       active AS (SELECT DISTINCT contact_id, date_trunc('week', ${harareLocal("created_at")})::date AS w FROM requests WHERE created_at >= $1)
       SELECT c.w::text AS week, ((a.w - c.w) / 7)::int AS k, count(DISTINCT a.contact_id)::int AS n
         FROM cohort c JOIN active a ON a.contact_id = c.contact_id AND a.w > c.w
        GROUP BY 1, 2`,
      qd.list,
    ),
    describeScope(db, scope),
  ]);

  const fresh = align(p, mix, (r) => r.fresh);
  const back = align(p, mix, (r) => r.back);
  const both: Pair = { cur: fresh.cur.map((n, i) => n + (back.cur[i] ?? 0)), prev: fresh.prev.map((n, i) => n + (back.prev[i] ?? 0)) };
  const rp = repeat ?? { cur: 0, cur_back: 0, prev: 0, prev_back: 0, cur_new: 0, prev_new: 0 };
  const weeks = Array.from({ length: 8 }, (_, i) => new Date(cohortFrom.getTime() + i * 7 * 24 * 3600_000));
  const weekKey = (d: Date) => new Date(d.getTime() + 2 * 3600_000).toISOString().slice(0, 10);
  const cohorts = weeks.map((start) => {
    const week = weekKey(start);
    const size = cohortSizes.find((s) => s.week === week)?.n ?? 0;
    // Only whole weeks since: a cohort that started three weeks ago has three weeks to show.
    const elapsed = Math.floor((thisWeek.getTime() - start.getTime()) / (7 * 24 * 3600_000)) - 1;
    const back = Array.from({ length: 8 }, (_, k) => (k < elapsed ? (cohortActivity.find((a) => a.week === week && a.k === k + 1)?.n ?? 0) : null));
    return { week, customers: size, back };
  });

  return {
    period: periodInfo(p),
    scope: described,
    kpis: {
      customers,
      newCustomers: { value: rp.cur_new, prev: rp.prev_new, series: fresh.cur, prevSeries: fresh.prev },
      returning: {
        value: ratio(rp.cur_back, rp.cur),
        prev: ratio(rp.prev_back, rp.prev),
        series: back.cur.map((n, i) => ratio(n, both.cur[i] ?? 0)),
        prevSeries: back.prev.map((n, i) => ratio(n, both.prev[i] ?? 0)),
        parts: { num: back.cur, den: both.cur, prevNum: back.prev, prevDen: both.prev },
      },
      sorted: rateOf(c.sorted, c.answered),
      rating: rateOf(c.stars, c.rated),
      reports: countOf(align(p, reports, (r) => r.n)),
      alerts: countOf(align(p, alerts, (r) => r.n)),
      stopped: countOf(align(p, stopped, (r) => r.n)),
    },
    mix: { fresh: fresh.cur, back: back.cur },
    outcomes: { sorted: c.sorted.cur, notYet: c.notYet.cur, couldntHelp: c.couldntHelp.cur, noReply: c.noReply.cur, connections: c.connections.cur },
    ratings: [1, 2, 3, 4, 5].map((stars) => ({ stars, n: ratings.find((r) => r.stars === stars)?.n ?? 0 })),
    cohorts,
  };
}
