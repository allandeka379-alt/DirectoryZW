import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clearDemoActivity, DEMO_PREFIX, seedDemoActivity } from "../src/db/demo.js";
import { createServer, registerRoutes } from "../src/http/server.js";
import { businessAnalytics } from "../src/web/analytics.js";
import { bucketSql, periodFor } from "../src/web/periods.js";
import { testApp, type TestApp } from "./helpers.js";

const HOUR = 3600_000;
const DAY = 24 * HOUR;

describe("reporting periods", () => {
  // 09:30 UTC on Friday 2 October 2026 is 11:30 in Harare.
  const now = new Date("2026-10-02T09:30:00Z");

  it("runs whole Harare days up to today, with the same run of days before it", () => {
    const p = periodFor(7, now);
    expect(p.grain).toBe("day");
    expect(p.buckets).toEqual(["2026-09-26", "2026-09-27", "2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02"]);
    expect(p.prevBuckets).toEqual(["2026-09-19", "2026-09-20", "2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25"]);
    expect(p.start.toISOString()).toBe("2026-09-25T22:00:00.000Z"); // midnight on 26 September in Harare
    expect(p.prevStart.toISOString()).toBe("2026-09-18T22:00:00.000Z");
    expect(periodFor(90, now).buckets).toHaveLength(90);
  });

  it("runs a year as the last 52 Monday-to-Sunday weeks, this one included", () => {
    const p = periodFor(365, now);
    expect(p.grain).toBe("week");
    expect(p.buckets).toHaveLength(52);
    expect(p.buckets.at(-1)).toBe("2026-09-28");
    expect(p.buckets.every((d) => new Date(`${d}T00:00:00Z`).getUTCDay() === 1)).toBe(true);
    expect(p.prevBuckets.at(-1)).toBe("2025-09-29");
    expect(p.start.toISOString()).toBe("2025-10-05T22:00:00.000Z");
  });

  it("puts a moment in the same bucket in the database as in the period", async () => {
    const app = await testApp();
    try {
      // 23:30 UTC on 1 October is 01:30 on 2 October in Harare.
      const [row] = await app.db.query<{ day: string; week: string }>(
        `SELECT ${bucketSql("$1::timestamptz", "day")} AS day, ${bucketSql("$1::timestamptz", "week")} AS week`,
        ["2026-10-01T23:30:00Z"],
      );
      expect(row).toEqual({ day: "2026-10-02", week: "2026-09-28" });
    } finally {
      await app.close();
    }
  });
});

describe("the admin portal's reports", () => {
  let app: TestApp;
  let server: FastifyInstance;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    app = await testApp();
    server = createServer({ logger: false });
    registerRoutes(server, app);
    await server.ready();
    const now = app.clock.now.getTime();
    const one = async <T>(sql: string, params: unknown[]) => (await app.db.query<T>(sql, params))[0]!;
    const [quickFix, hatfield] = await Promise.all(
      ["QuickFix Plumbing (sample)", "Hatfield Plumbing Works (sample)"].map(async (name) => (await one<{ id: string }>("SELECT id FROM businesses WHERE name = $1", [name])).id),
    );
    ids.quickFix = quickFix!;
    const avondale = (await one<{ id: number }>("SELECT id FROM areas WHERE name = 'Avondale'", [])).id;
    const contact = async (wa: string) => (await one<{ id: string }>("INSERT INTO contacts (channel, wa_id) VALUES ('customer', $1) RETURNING id", [wa])).id;
    const a = await contact("263770009001");
    const b = await contact("263770009002");
    const request = async (who: string, hoursAgo: number, r: { intent?: string; category?: string | null; query?: string; found?: number; area?: number | null }) =>
      (
        await one<{ id: string }>(
          `INSERT INTO requests (contact_id, raw_text, interpretation, category_slug, query, area_id, status, result_count, understood_by, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'local', $9) RETURNING id`,
          [
            who,
            r.query ?? "something",
            JSON.stringify({ intent: r.intent ?? "search" }),
            r.category ?? null,
            r.query ?? "",
            r.area ?? null,
            r.found ? "answered" : "no_results",
            r.found ?? 0,
            new Date(now - hoursAgo * HOUR),
          ],
        )
      ).id;

    // This week: A finds plumbers in Avondale and chooses QuickFix (sorted, five stars); on another
    // day A's search finds nobody; B writes something we don't understand.
    const found = await request(a, 30, { category: "plumbing", query: "plumber", found: 2, area: avondale });
    await app.db.query("INSERT INTO request_results (request_id, business_id, rank) VALUES ($1, $2, 0), ($1, $3, 1)", [found, quickFix, hatfield]);
    await app.db.query(
      `INSERT INTO introductions (ref_code, request_id, contact_id, business_id, outcome, rating, created_at)
       VALUES ('TST01', $1, $2, $3, 'sorted', 5, $4)`,
      [found, a, quickFix, new Date(now - 29 * HOUR)],
    );
    await request(a, 80, { category: "plumbing", query: "geyser repair", found: 0, area: avondale });
    await request(b, 50, { intent: "unclear", category: null, query: "" });
    // The week before: B found a plumber, and chose nobody.
    const before = await request(b, 9 * 24, { category: "plumbing", query: "plumber", found: 1 });
    await app.db.query("INSERT INTO request_results (request_id, business_id, rank) VALUES ($1, $2, 0)", [before, hatfield]);
  });

  afterAll(async () => {
    await server.close();
    await app.close();
  });

  const get = async (path: string) => {
    const res = await server.inject({ url: `/ops/api${path}` });
    expect(res.statusCode).toBe(200);
    return res.json();
  };

  it("leads with the headline measures, against the week before", async () => {
    const o = await get("/insights/overview?days=7");
    expect(o.period).toMatchObject({ days: 7, grain: "day" });
    expect(o.period.buckets).toHaveLength(7);
    const k = o.kpis;
    expect([k.requests.value, k.requests.prev]).toEqual([3, 1]);
    expect([k.customers.value, k.customers.prev]).toEqual([2, 1]);
    expect([k.found.value, k.found.prev]).toEqual([0.5, 1]); // of the searches: one of two this week
    expect([k.connections.value, k.connections.prev]).toEqual([1, 0]);
    expect(k.connectionRate.value).toBeCloseTo(1 / 3);
    expect(k.sorted.value).toBe(1);
    expect(k.requests.series.reduce((s: number, v: number) => s + v, 0)).toBe(3); // the bars add up to the total
    expect(k.found.parts.den.reduce((s: number, v: number) => s + v, 0)).toBe(2);
    expect(k.businesses.value).toBeGreaterThan(0);
    expect(o.funnel.map((f: { value: number }) => f.value)).toEqual([3, 2, 1, 1, 1, 1]);
    expect(o.categories[0]).toMatchObject({ slug: "plumbing", requests: 2, prev: 1, unmet: 1 });
    expect(o.heat.values.flat().reduce((s: number, v: number) => s + v, 0)).toBe(3);
    // No city chosen: the map shows towns.
    expect(o.map.level).toBe("city");
    expect(o.map.points.find((p: { name: string }) => p.name === "Harare")).toMatchObject({ requests: 2 });
    expect(o.map.unplaced).toBe(1);
  });

  it("narrows everything to a city and a category", async () => {
    const o = await get("/insights/overview?days=7&city=Harare&category=plumbing");
    expect(o.scope).toMatchObject({ city: "Harare", category: { slug: "plumbing" } });
    expect(o.kpis.requests.value).toBe(2);
    expect(o.kpis.connections.value).toBe(1);
    // A city chosen: the map shows its suburbs, with rings from the centre.
    expect(o.map.level).toBe("area");
    expect(o.map.centre).toMatchObject({ lat: expect.any(Number), lng: expect.any(Number) });
    expect(o.map.points).toEqual([expect.objectContaining({ name: "Avondale", requests: 2, unmet: 1 })]);
    // The category list still shows the others, so the chosen one stands out among them.
    const g = await get("/insights/overview?days=7&group=Home%20services");
    expect(g.kpis.requests.value).toBe(2);
  });

  it("shows demand by category, next to supply, and what nobody had", async () => {
    const d = await get("/insights/demand?days=7");
    expect(d.kpis.unmet.value).toBe(1);
    expect(d.kpis.handoffs.value).toBeCloseTo(0); // nothing went to a person in this data
    const plumbing = d.categories.find((c: { slug: string }) => c.slug === "plumbing");
    expect(plumbing).toMatchObject({ requests: 2, unmet: 1, connected: 1, businesses: expect.any(Number) });
    expect(plumbing.businesses).toBeGreaterThanOrEqual(3);
    expect(d.unmetSearches).toEqual([expect.objectContaining({ what: "geyser repair", n: 1, areas: ["Avondale"] })]);
    expect(d.topSearches.map((s: { what: string }) => s.what).sort()).toEqual(["geyser repair", "plumber"]);
    expect(d.byGroup.at(-1).name).toBe("Other");
    expect(d.areaCategory).toMatchObject({ rows: ["Avondale, Harare"], cols: ["Plumbers"], values: [[2]] });
  });

  it("ranks businesses by customers connected, and lists those that need a look", async () => {
    const s = await get("/insights/supply?days=7");
    expect(s.leaders[0]).toMatchObject({ id: ids.quickFix, connections: 1, sorted: 1, answered: 1, shown: 1 });
    expect(s.kpis.businesses.value).toBe(s.kpis.businesses.series.at(-1));
    expect(s.sources.reduce((n: number, x: { n: number }) => n + x.n, 0)).toBe(s.kpis.businesses.value);
    expect(s.coverage.find((c: { slug: string }) => c.slug === "plumbing")).toMatchObject({ requests: 2, unmet: 1 });
    expect(Array.isArray(s.watch)).toBe(true);
  });

  it("follows customers: new, coming back, and how follow-ups went", async () => {
    const c = await get("/insights/customers?days=7");
    expect(c.kpis.customers.value).toBe(2);
    expect(c.kpis.newCustomers.value).toBe(1); // B first asked the week before
    expect(c.kpis.returning.value).toBe(0.5); // A asked on two days, B on one
    expect(c.kpis.sorted.value).toBe(1);
    expect(c.kpis.rating.value).toBe(5);
    expect(c.ratings.find((r: { stars: number }) => r.stars === 5).n).toBe(1);
    expect(c.outcomes.sorted.reduce((s: number, v: number) => s + v, 0)).toBe(1);
    expect(c.cohorts).toHaveLength(8);
  });

  it("offers a year by the week, and refuses other periods", async () => {
    const o = await get("/insights/overview?days=365");
    expect(o.period.grain).toBe("week");
    expect(o.kpis.requests.series).toHaveLength(52);
    expect(o.kpis.requests.value).toBe(4);
    for (const page of ["overview", "demand", "supply", "customers"]) {
      expect((await server.inject({ url: `/ops/api/insights/${page}?days=5` })).statusCode).toBe(400);
    }
    const options = await get("/insights/options");
    expect(options.cities).toContain("Harare");
    expect(options.groups).not.toContain("Blocked");
  });

  it("gives an owner their listing's numbers, and never who the customers are", async () => {
    const b = (await app.db.query<{ id: string; area_id: number; lat: number; lng: number }>("SELECT id, area_id, lat, lng FROM businesses WHERE id = $1", [ids.quickFix]))[0]!;
    const a = await businessAnalytics(app.db, b, 7, app.clock.now);
    expect(a.kpis).toMatchObject({ shown: 1, connections: 1, connectionRate: 1 });
    expect(a.measures.position.value).toBe(1);
    expect(a.measures.satisfaction.value).toBe(1);
    expect(a.daily).toHaveLength(7);
    expect(a.previous).toHaveLength(7);
    expect(a.funnel.map((f) => f.value)).toEqual([2, 1, 1, 1, 1]); // two plumbing requests in Harare this week
    expect(a.market.missed).toEqual([expect.objectContaining({ what: "geyser repair", n: 1, unmet: 1, listed: false })]);
    expect(a.distance?.reduce((n, d) => n + d.shown, 0)).toBe(1);
    expect(JSON.stringify(a)).not.toContain("26377000900");
    // Nothing about other stores: not the plumber shown beside it, nor how its prices compare.
    expect(a).not.toHaveProperty("price");
    expect(JSON.stringify(a)).not.toContain("Hatfield");
    const year = await businessAnalytics(app.db, b, 365, app.clock.now);
    expect(year.grain).toBe("week");
    expect(year.daily).toHaveLength(52);
  });
});

describe("sample activity for local dashboards", () => {
  it("adds months of marked activity, and takes it all away again", async () => {
    const app = await testApp();
    try {
      const count = async (sql: string) => (await app.db.query<{ n: number }>(sql))[0]!.n;
      const samples = await count("SELECT count(*)::int AS n FROM businesses WHERE is_sample");
      const s = await seedDemoActivity(app.db, app.clock.now, { days: 20 });
      expect(s.requests).toBeGreaterThan(200);
      expect(s.connections).toBeGreaterThan(20);
      expect(await count("SELECT count(*)::int AS n FROM requests")).toBe(s.requests);
      expect(await count(`SELECT count(*)::int AS n FROM contacts WHERE wa_id NOT LIKE '${DEMO_PREFIX}%'`)).toBe(0);
      expect(await count("SELECT count(*)::int AS n FROM introductions WHERE request_id IS NULL")).toBe(0);
      await clearDemoActivity(app.db);
      expect(await count("SELECT count(*)::int AS n FROM requests")).toBe(0);
      expect(await count("SELECT count(*)::int AS n FROM introductions")).toBe(0);
      expect(await count("SELECT count(*)::int AS n FROM businesses WHERE is_sample")).toBe(samples);
    } finally {
      await app.close();
    }
  });
});
