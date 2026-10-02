// The admin portal's analytics: an executive overview, then demand, supply and customer experience.
// Every page shares one row of filters (period, city, category) kept in the address, so a view can be
// bookmarked or sent to a colleague; clicking a bar, a bubble or a row narrows the page to it.
// The numbers come from /ops/api/insights/* (src/ops/insights.ts); definitions in docs/DASHBOARDS.md.

import { h, icon, num } from "/assets/ui.js";
import {
  ACCENT,
  beforeName,
  bubbleMap,
  bucketLabels,
  columnChart,
  delta,
  filterBar,
  formatValue,
  funnel,
  heatmap,
  lineChart,
  meter,
  MUTED,
  periodRange,
  rankedBars,
  SERIES,
  shareBar,
  statTile,
  STATUS,
  vizCard,
} from "/app/viz.js";

const PAGES = [
  ["overview", "Overview"],
  ["demand", "Demand"],
  ["supply", "Supply"],
  ["experience", "Customer experience"],
];

/** The filters in the address: #/demand?days=90&city=Harare&category=solar */
function scopeOf(params) {
  const days = Number(params.get("days"));
  return {
    days: [7, 30, 90, 365].includes(days) ? days : 30,
    city: params.get("city") ?? "",
    area: params.get("area") ?? "",
    category: params.get("category") ?? "",
    group: params.get("group") ?? "",
  };
}
const queryOf = (scope, { forApi = false } = {}) =>
  new URLSearchParams(Object.entries(scope).filter(([k, v]) => v !== "" && v != null && (forApi || !(k === "days" && v === 30)))).toString();
const hrefOf = (page, scope) => {
  const q = queryOf(scope);
  return `#/${page}${q ? `?${q}` : ""}`;
};
const goTo = (page, scope) => {
  location.hash = hrefOf(page, scope);
};

const DEFINITIONS = {
  requests: "Everything people asked us for in the period, including what we couldn't help with.",
  customers: "People who asked us for something. Each counts once, however often they asked.",
  found: "Of the requests we understood as searches, the share where we sent at least one business.",
  connections: "Customers who chose a business and got its WhatsApp link, each with a reference code.",
  connectionRate: "Of all requests, the share that led to at least one connection.",
  sorted: "Of the final answers to our follow-up, the share that said “Yes, sorted”. “Not yet” doesn't count.",
  businesses: "Listings customers can find now (live). The change counts what was added since the period began.",
  products: "Products on live listings now. The change counts what was added since the period began.",
};

const UNDERSTOOD = {
  local: "Understood on our own",
  phrasebook: "From the phrasebook",
  customer: "The customer picked",
  claude: "By Claude",
  fallback: "Not understood",
  photo: "From a photo",
  unknown: "Not recorded",
};
const JOINED = { website: "Website", whatsapp: "WhatsApp", field: "Signed up by our team", import: "Imported", seed: "Sample" };
// Colour follows the thing, never its rank: these keep their colour whatever the filters show.
const UNDERSTOOD_COLORS = { local: SERIES[0], phrasebook: SERIES[1], customer: SERIES[2], claude: SERIES[3], fallback: SERIES[4], photo: SERIES[5], unknown: MUTED };
const JOINED_COLORS = { website: SERIES[0], whatsapp: SERIES[1], field: SERIES[2], import: SERIES[3], seed: MUTED };
/** Parts of a bar sit in their colours' fixed order, so only the neighbours checked for colour-blind readers touch. */
const inOrder = (rows, colors, key) => {
  const rank = (row) => {
    const i = Object.keys(colors).indexOf(row[key]);
    return i < 0 ? Infinity : i;
  };
  return [...rows].sort((a, b) => rank(a) - rank(b));
};

/** Category groups get a colour the first time they're drawn and keep it, so a filter never repaints one. */
const groupSlots = new Map();
function groupColors(names) {
  const out = new Map();
  const used = new Set();
  for (const name of names) {
    const slot = groupSlots.get(name);
    if (name !== "Other" && slot != null && !used.has(slot)) {
      out.set(name, SERIES[slot]);
      used.add(slot);
    }
  }
  for (const name of names) {
    if (out.has(name)) continue;
    if (name === "Other") {
      out.set(name, MUTED);
      continue;
    }
    let slot = 0;
    while (used.has(slot)) slot++;
    used.add(slot);
    groupSlots.set(name, slot);
    out.set(name, SERIES[slot]);
  }
  return out;
}
const hourName = (hr) => (hr === 0 ? "12am" : hr < 12 ? `${hr}am` : hr === 12 ? "12pm" : `${hr - 12}pm`);
const shareText = (n, of) => (of ? `${Math.round((100 * n) / of)}%` : "–");

/** A number with a bar behind it, for tables (like conditional formatting). */
function cellBar(value, max, { warn = false, text } = {}) {
  const el = h("span", { class: `viz-cellbar${warn ? " warn" : ""}` }, h("span", { text: text ?? formatValue("count", value) }));
  el.style.setProperty("--w", `${max ? Math.max(value ? 3 : 0, (100 * value) / max) : 0}%`);
  return el;
}

/**
 * A table you can sort by clicking a heading, with an optional action on each row.
 * columns: [{ label, num?, value(row) for sorting, render(row) for display }]
 */
function sortableTable(columns, rows, { sortBy = 1, onRow, picked } = {}) {
  let by = sortBy;
  let dir = -1;
  const body = h("tbody");
  const head = h("tr");
  const draw = () => {
    const sorted = [...rows].sort((a, b) => {
      const va = columns[by].value(a);
      const vb = columns[by].value(b);
      if (typeof va === "string" || typeof vb === "string") return dir * String(va ?? "").localeCompare(String(vb ?? ""));
      return dir * ((va ?? -Infinity) - (vb ?? -Infinity));
    });
    body.replaceChildren(
      ...sorted.map((r) =>
        h(
          "tr",
          { class: [onRow ? "pick" : "", picked?.(r) ? "picked" : ""].join(" ").trim() || null, tabindex: onRow ? 0 : null, onclick: onRow ? () => onRow(r) : null, onkeydown: onRow ? (e) => e.key === "Enter" && onRow(r) : null },
          columns.map((c) => h("td", { class: c.num ? "num" : "" }, c.render(r))),
        ),
      ),
    );
    head.replaceChildren(
      ...columns.map((c, i) =>
        h(
          "th",
          {
            scope: "col",
            class: `${c.num ? "num " : ""}sortable`,
            "aria-sort": i === by ? (dir < 0 ? "descending" : "ascending") : null,
            onclick: () => {
              dir = i === by ? -dir : c.num ? -1 : 1;
              by = i;
              draw();
            },
          },
          c.label,
        ),
      ),
    );
  };
  draw();
  return h("div", { class: "viz-table-wrap" }, h("table", { class: "viz-table" }, h("thead", {}, head), body));
}

/**
 * The analytics screens, given what they need from the portal around them.
 * ctx: { get, track(cleanup), stale(ticket), onSummary(summary), openBusiness(id) }
 */
export function insightScreens(ctx) {
  let options = null;
  const filterOptions = async () => (options ??= await ctx.get("/insights/options"));
  const cards = (...list) => {
    for (const c of list) ctx.track(c.cleanup);
    return list.map((c) => c.el);
  };

  /** Everything above a report's charts: title, report tabs, filters. */
  function top(page, title, scope, data, opts, lead) {
    const s = data.scope;
    const where = [s.area ? `${s.area.name}, ${s.area.city}` : s.city, s.category?.name ?? s.group].filter(Boolean);
    const when = `${periodRange(data.period.buckets, data.period.grain)}, compared with ${beforeName(scope.days)}`;
    const subtitle = [...where, when].join(" · ");
    const city = h(
      "select",
      { class: "select", "aria-label": "City", onchange: (e) => goTo(page, { ...scope, city: e.target.value, area: "" }) },
      h("option", { value: "" }, "All cities"),
      opts.cities.map((c) => h("option", { value: c, selected: c === (s.city ?? "") }, c)),
    );
    const kind = h(
      "select",
      {
        class: "select",
        "aria-label": "Category",
        onchange: (e) => {
          const v = e.target.value;
          goTo(page, { ...scope, category: v.startsWith("c:") ? v.slice(2) : "", group: v.startsWith("g:") ? v.slice(2) : "" });
        },
      },
      h("option", { value: "" }, "All categories"),
      opts.groups.map((g) =>
        h(
          "optgroup",
          { label: g },
          h("option", { value: `g:${g}`, selected: !scope.category && scope.group === g }, `All of ${g}`),
          opts.categories.filter((c) => c.group === g).map((c) => h("option", { value: `c:${c.slug}`, selected: scope.category === c.slug }, c.name)),
        ),
      ),
    );
    const chips = [];
    if (s.area) chips.push({ label: `Area: ${s.area.name}`, onRemove: () => goTo(page, { ...scope, area: "" }) });
    const reset = scope.city || scope.area || scope.category || scope.group ? h("a", { class: "btn btn-ghost btn-sm", href: hrefOf(page, { days: scope.days }) }, "Clear filters") : null;
    return [
      h(
        "div",
        { class: "page-head" },
        h("div", {}, h("h1", { text: title }), h("p", { text: lead ?? subtitle })),
        h("div", { class: "actions" }, h("button", { class: "btn btn-secondary btn-sm no-print", type: "button", onclick: () => window.print() }, icon("download"), "Save as PDF")),
      ),
      h("nav", { class: "viz-tabs no-print", "aria-label": "Reports" }, PAGES.map(([key, name]) => h("a", { href: hrefOf(key, scope), "aria-current": key === page ? "page" : null }, name))),
      filterBar({
        days: scope.days,
        onPeriod: (d) => goTo(page, { ...scope, days: d }),
        controls: [city, kind, reset],
        chips,
        updatedAt: new Date(),
        onRefresh: () => window.dispatchEvent(new HashChangeEvent("hashchange")),
      }),
    ];
  }

  // ---------- Overview ----------

  async function overview(params, ticket) {
    const scope = scopeOf(params);
    const [summary, o, opts] = await Promise.all([ctx.get("/summary"), ctx.get(`/insights/overview?${queryOf(scope, { forApi: true })}`), filterOptions()]);
    if (ctx.stale(ticket)) return [];
    ctx.onSummary(summary);
    const s = summary;
    const k = o.kpis;
    const buckets = bucketLabels(o.period.buckets, o.period.grain);
    const before = bucketLabels(o.period.prevBuckets, o.period.grain, { current: false });
    const each = o.period.grain === "week" ? "week" : "day";

    const waiting = [
      [s.open_handoffs, "waiting for a person", "chats"],
      [s.open_reports, s.reports_over_a_day ? `open reports, ${num(s.reports_over_a_day)} over a day old` : "open reports", "reports"],
      [s.to_verify, "businesses to verify", "verify"],
      [s.web_registrations_pending, "website sign-ups waiting for their code", "signups"],
      [s.new_recommendations, "new customer tips", "tips"],
    ].filter(([n]) => n > 0);

    const tiles = h(
      "div",
      { class: "viz-tiles" },
      statTile({ label: "Requests", measure: k.requests, definition: DEFINITIONS.requests, href: hrefOf("demand", scope) }),
      statTile({ label: "Customers", measure: k.customers, definition: DEFINITIONS.customers, href: hrefOf("experience", scope) }),
      statTile({ label: "Found a supplier", measure: k.found, format: "share", definition: DEFINITIONS.found }),
      statTile({ label: "Connections", measure: k.connections, definition: DEFINITIONS.connections }),
      statTile({ label: "Connection rate", measure: k.connectionRate, format: "share", definition: DEFINITIONS.connectionRate }),
      statTile({ label: "Said “Yes, sorted”", measure: k.sorted, format: "share", definition: DEFINITIONS.sorted, href: hrefOf("experience", scope) }),
      statTile({ label: "Live businesses", measure: k.businesses, definition: DEFINITIONS.businesses, foot: `${num(o.newBusinesses)} added this period`, href: hrefOf("supply", scope), partial: false }),
      statTile({ label: "Products listed", measure: k.products, definition: DEFINITIONS.products, foot: `${num(o.newProducts)} added this period`, href: hrefOf("supply", scope), partial: false }),
    );

    const MEASURES = [
      ["requests", "Requests", "count"],
      ["customers", "Customers", "count"],
      ["connections", "Connections", "count"],
      ["found", "Found a supplier", "share"],
    ];
    let metric = "requests";
    const drawTrend = (box) => {
      const [, name, format] = MEASURES.find(([key]) => key === metric);
      return lineChart(box, {
        buckets,
        format,
        yMax: format === "share" ? 1 : undefined,
        title: `${name}, each ${each}`,
        height: 300,
        series: [
          { name: "The period before", values: k[metric].prevSeries, muted: true, labelAt: (i) => before[i]?.long ?? "" },
          { name, values: k[metric].series, area: format === "count" },
        ],
      });
    };
    const toggle = h("div", { class: "segmented", role: "group", "aria-label": "Measure" });
    const trend = vizCard({
      title: "Over time",
      subtitle: `Each ${each}, with ${beforeName(scope.days)} in grey`,
      span: 8,
      actions: [toggle],
      draw: drawTrend,
      table: () => ({
        columns: [{ label: each === "week" ? "Week of" : "Day" }, ...MEASURES.map(([, name]) => ({ label: name, num: true }))],
        rows: buckets.map((b, i) => [b.long, ...MEASURES.map(([key, , format]) => formatValue(format, k[key].series[i]))]),
      }),
      csv: `overview-by-${each}`,
    });
    for (const [key, name] of MEASURES) {
      toggle.append(
        h(
          "button",
          {
            type: "button",
            "aria-pressed": String(key === metric),
            onclick: (e) => {
              metric = key;
              toggle.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === e.currentTarget)));
              trend.redraw(drawTrend);
            },
          },
          name,
        ),
      );
    }

    const funnelCard = vizCard({
      title: "From asking to sorted",
      subtitle: "Requests made this period, and how far each got",
      span: 4,
      empty: o.funnel[0].value ? null : { title: "No requests yet", text: "Once people ask, you'll see how many we understood, answered and connected." },
      draw: () => funnel({ stages: o.funnel }),
      table: () => ({ columns: [{ label: "Stage" }, { label: "Requests", num: true }, { label: "Of all", num: true }], rows: o.funnel.map((f) => [f.label, f.value, shareText(f.value, o.funnel[0].value)]) }),
      csv: "funnel",
    });

    const categories = vizCard({
      title: "Demand by category",
      subtitle: "The ten most asked-for. Pick one to filter the page.",
      span: 6,
      empty: o.categories.length ? null : { title: "No requests yet", text: "Categories appear as people ask for things." },
      draw: () =>
        rankedBars({
          rows: o.categories.map((c) => ({
            key: c.slug,
            label: c.name,
            sub: c.group,
            value: c.requests,
            note: c.unmet ? `${num(c.unmet)} found nobody` : null,
            parts: [
              { name: "Found a supplier", value: c.requests - c.unmet, color: ACCENT },
              { name: "Found nobody", value: c.unmet, color: STATUS.warn },
            ],
          })),
          legend: [
            { name: "Found a supplier", color: ACCENT },
            { name: "Found nobody", color: STATUS.warn },
          ],
          selected: scope.category || null,
          onSelect: (slug) => goTo("overview", { ...scope, category: slug ?? "", group: "" }),
        }),
      table: () => ({
        columns: [{ label: "Category" }, { label: "Requests", num: true }, { label: "The period before", num: true }, { label: "Found nobody", num: true }],
        rows: o.categories.map((c) => [c.name, c.requests, c.prev, c.unmet]),
      }),
      csv: "demand-by-category",
    });

    const map = o.map;
    const atArea = map.level === "area";
    const mapCard = vizCard({
      title: atArea ? `Where in ${map.city} people asked from` : "Where people asked from",
      subtitle: atArea ? "Suburbs, sized by requests; rings every 5 km from the centre. Pick one to filter." : "Towns, sized by requests. Pick one to see its suburbs.",
      span: 6,
      empty: map.points.length ? null : { title: "No places yet", text: "When customers say where they are, their areas show on the map." },
      draw: (box) =>
        bubbleMap(box, {
          points: map.points.map((p) => ({ ...p, value: p.requests, unit: "requests", lines: p.unmet ? [`${num(p.unmet)} found nobody`] : [] })),
          centre: atArea ? map.centre : null,
          rings: atArea ? [5, 10, 15] : [],
          fill: true,
          labels: atArea ? 8 : 12,
          title: "Requests by place",
          selected: atArea ? Number(scope.area) || null : null,
          onSelect: (id) => (atArea ? goTo("overview", { ...scope, area: id ?? "" }) : goTo("overview", { ...scope, city: id ?? "", area: "" })),
        }),
      table: () => ({ columns: [{ label: atArea ? "Area" : "Town" }, { label: "Requests", num: true }, { label: "Found nobody", num: true }], rows: map.points.map((p) => [p.name, p.requests, p.unmet]) }),
      csv: atArea ? "requests-by-area" : "requests-by-town",
      foot: atArea ? (map.cityWide ? `${num(map.cityWide)} more asked for all of ${map.city}, without a suburb.` : null) : map.unplaced ? `${num(map.unplaced)} more didn't say where they were.` : null,
    });

    const heat = vizCard({
      title: "When people ask",
      subtitle: "Requests by day and hour, Harare time",
      span: 6,
      empty: k.requests.value ? null : { title: "No requests yet", text: "The busiest days and hours show here once people ask." },
      draw: (box) =>
        heatmap(box, {
          rows: o.heat.rows,
          cols: Array.from({ length: 24 }, (_, hr) => hourName(hr)),
          values: o.heat.values,
          colEvery: 3,
          title: "Requests by day and hour",
          cellName: (r, c) => `${o.heat.rows[r]}, ${hourName(c)} to ${hourName((c + 1) % 24)}`,
          rowWidth: 44,
          cellHeight: 34,
        }),
      table: () => ({ columns: [{ label: "Day" }, ...Array.from({ length: 24 }, (_, hr) => ({ label: hourName(hr), num: true }))], rows: o.heat.rows.map((r, i) => [r, ...o.heat.values[i]]) }),
      csv: "requests-by-day-and-hour",
    });

    const ratio = s.verified_businesses ? s.connections_verified_30d / s.verified_businesses : null;
    const launch = vizCard({
      title: "Launch measures",
      subtitle: "The last 30 days, across the whole service (the filters don't apply)",
      span: 6,
      draw: () =>
        h(
          "div",
          { class: "viz-meters" },
          meter({ label: "Follow-up answers that say “Yes, sorted”", value: s.answered_30d ? s.sorted_30d / s.answered_30d : null, target: 0.6, foot: `${num(s.sorted_30d)} of ${num(s.answered_30d)} final answers` }),
          meter({ label: "Customers who came back on another day", value: s.customers_30d ? s.returning_30d / s.customers_30d : null, target: 0.25, foot: `${num(s.returning_30d)} of ${num(s.customers_30d)} customers` }),
          meter({ label: "Owners who wrote to us", value: s.owners ? s.owners_active_30d / s.owners : null, target: 0.5, foot: `${num(s.owners_active_30d)} of ${num(s.owners)} owners` }),
          h(
            "ul",
            { class: "viz-facts" },
            h(
              "li",
              {},
              h("span", {}, "Connections per verified business", h("small", { text: `${num(s.verified_connected_30d)} of ${num(s.verified_businesses)} verified businesses got at least one` })),
              h("strong", { text: ratio == null ? "–" : ratio >= 10 ? String(Math.round(ratio)) : ratio.toFixed(1) }),
            ),
          ),
        ),
      table: () => ({
        columns: [{ label: "Measure" }, { label: "Now", num: true }, { label: "Target", num: true }],
        rows: [
          ["Yes, sorted", shareText(s.sorted_30d, s.answered_30d), "60%"],
          ["Came back on another day", shareText(s.returning_30d, s.customers_30d), "25%"],
          ["Owners who wrote to us", shareText(s.owners_active_30d, s.owners), "50%"],
          ["Connections per verified business", ratio == null ? "–" : ratio.toFixed(1), ""],
        ],
      }),
      csv: "launch-measures",
    });

    return [
      ...top("overview", "Overview", scope, o, opts),
      waiting.length
        ? h(
            "div",
            { class: "viz-alerts", role: "list", "aria-label": "Waiting for the team" },
            waiting.map(([n, text, key]) => h("a", { href: `#/${key}`, role: "listitem" }, h("strong", { text: num(n) }), text)),
          )
        : null,
      tiles,
      h("div", { class: "dash" }, cards(trend, funnelCard, categories, mapCard, heat, launch)),
    ];
  }

  // ---------- Demand ----------

  async function demand(params, ticket) {
    const scope = scopeOf(params);
    const [d, opts] = await Promise.all([ctx.get(`/insights/demand?${queryOf(scope, { forApi: true })}`), filterOptions()]);
    if (ctx.stale(ticket)) return [];
    const k = d.kpis;
    const buckets = bucketLabels(d.period.buckets, d.period.grain);
    const each = d.period.grain === "week" ? "week" : "day";

    const tiles = h(
      "div",
      { class: "viz-tiles cols-3" },
      statTile({ label: "Requests", measure: k.requests, definition: DEFINITIONS.requests }),
      statTile({ label: "Found a supplier", measure: k.found, format: "share", definition: DEFINITIONS.found }),
      statTile({ label: "Searches that found nobody", measure: k.unmet, better: "down", definition: "Searches we understood but couldn't answer with any business: where to sign businesses up." }),
      statTile({ label: "From businesses", measure: k.b2b, definition: "Requests from business owners looking for their own supplies (wholesale)." }),
      statTile({ label: "Handed to a person", measure: k.handoffs, format: "share", better: "down", definition: "Of all requests, the share our team had to take over: no supplier, not understood, or the customer asked for a person." }),
      statTile({ label: "Understood without Claude", measure: k.local, format: "share", definition: "Of the requests we read, the share understood by our own engine, the phrasebook or the customer's own pick. Each one saves a paid Claude call." }),
    );

    const colorOf = groupColors(d.byGroup.map((g) => g.name));
    const byGroup = vizCard({
      title: "Requests by category group",
      subtitle: `Each ${each}: the five busiest groups, and the rest as “Other”`,
      span: 12,
      empty: k.requests.value ? null : { title: "No requests yet", text: "Groups of categories show here as people ask." },
      draw: (box) => columnChart(box, { buckets, stacked: true, title: "Requests by category group", series: d.byGroup.map((g) => ({ name: g.name, values: g.values, color: colorOf.get(g.name) })), height: 260 }),
      table: () => ({ columns: [{ label: each === "week" ? "Week of" : "Day" }, ...d.byGroup.map((g) => ({ label: g.name, num: true }))], rows: buckets.map((b, i) => [b.long, ...d.byGroup.map((g) => g.values[i])]) }),
      csv: `requests-by-group-by-${each}`,
    });

    const rows = d.categories;
    const maxRequests = Math.max(1, ...rows.map((r) => r.requests));
    const maxUnmet = Math.max(1, ...rows.map((r) => r.unmet));
    const table = vizCard({
      title: "Every category",
      subtitle: "Demand next to supply. Sort by any column; pick a row to filter the page.",
      span: 12,
      empty: rows.length ? null : { title: "Nothing yet", text: "Categories appear as people ask and businesses join." },
      draw: () =>
        sortableTable(
          [
            { label: "Category", value: (r) => r.name, render: (r) => h("span", { class: "viz-name-cell" }, h("span", { text: r.name }), h("small", { text: r.group })) },
            { label: "Requests", num: true, value: (r) => r.requests, render: (r) => cellBar(r.requests, maxRequests) },
            { label: "Change", num: true, value: (r) => (r.prev ? (r.requests - r.prev) / r.prev : null), render: (r) => delta(r.requests, r.prev) },
            { label: "Found nobody", num: true, value: (r) => r.unmet, render: (r) => cellBar(r.unmet, maxUnmet, { warn: true }) },
            { label: "Connected", num: true, value: (r) => (r.requests ? r.connected / r.requests : null), render: (r) => shareText(r.connected, r.requests) },
            { label: "Businesses", num: true, value: (r) => r.businesses, render: (r) => h("span", {}, num(r.businesses), r.businesses ? h("small", { class: "muted", text: ` · ${num(r.verified)} verified` }) : null) },
            { label: "Requests per business", num: true, value: (r) => (r.businesses ? r.perBusiness : r.requests ? Infinity : null), render: (r) => (r.businesses ? (r.perBusiness >= 10 || r.perBusiness === 0 ? num(Math.round(r.perBusiness)) : r.perBusiness.toFixed(1)) : r.requests ? "no businesses" : "–") },
          ],
          rows,
          { sortBy: 1, onRow: (r) => goTo("demand", { ...scope, category: r.slug === scope.category ? "" : r.slug, group: "" }), picked: (r) => r.slug === scope.category },
        ),
      table: () => ({
        columns: [{ label: "Category" }, { label: "Group" }, { label: "Requests", num: true }, { label: "The period before", num: true }, { label: "Found nobody", num: true }, { label: "Connected", num: true }, { label: "Businesses", num: true }, { label: "Verified", num: true }],
        rows: rows.map((r) => [r.name, r.group, r.requests, r.prev, r.unmet, r.connected, r.businesses, r.verified]),
      }),
      csv: "categories",
    });

    const searches = vizCard({
      title: "What people search for",
      subtitle: "In their own words, the most common first",
      span: 6,
      empty: d.topSearches.length ? null : { title: "No searches yet", text: "The most common searches show here." },
      draw: () =>
        rankedBars({
          rows: d.topSearches.map((x) => ({
            key: x.what,
            label: x.what,
            value: x.n,
            note: x.unmet ? `${num(x.unmet)} found nobody` : null,
            parts: [
              { name: "Found a supplier", value: x.n - x.unmet, color: ACCENT },
              { name: "Found nobody", value: x.unmet, color: STATUS.warn },
            ],
          })),
          legend: [
            { name: "Found a supplier", color: ACCENT },
            { name: "Found nobody", color: STATUS.warn },
          ],
        }),
      table: () => ({ columns: [{ label: "Search" }, { label: "Times", num: true }, { label: "Found nobody", num: true }], rows: d.topSearches.map((x) => [x.what, x.n, x.unmet]) }),
      csv: "top-searches",
    });

    const unmet = vizCard({
      title: "Searched for, but nobody had it",
      subtitle: "Who to sign up next, and where",
      span: 6,
      empty: d.unmetSearches.length ? null : { title: "Nothing missing", text: "Every search found at least one business. Searches that don't show here." },
      draw: () =>
        h(
          "ul",
          { class: "viz-facts" },
          d.unmetSearches.map((x) => h("li", {}, h("span", {}, x.what, h("small", { text: [x.category, x.areas.length ? `asked in ${x.areas.join(", ")}` : null].filter(Boolean).join(" · ") })), h("strong", { text: num(x.n) }))),
        ),
      table: () => ({ columns: [{ label: "Search" }, { label: "Category" }, { label: "Areas" }, { label: "Times", num: true }], rows: d.unmetSearches.map((x) => [x.what, x.category ?? "", x.areas.join(", "), x.n]) }),
      csv: "searches-that-found-nobody",
      foot: h("a", { href: `#/gaps?days=${Math.min(90, scope.days)}` }, "All supply gaps, by area"),
    });

    const ac = d.areaCategory;
    const areaCats = vizCard({
      title: "Areas against categories",
      subtitle: "The ten busiest areas and eight busiest categories. Pick an area to filter.",
      span: 8,
      empty: ac.rows.length ? null : { title: "No places yet", text: "When customers say where they are, the busiest areas and categories meet here." },
      draw: (box) =>
        heatmap(box, {
          rows: ac.rows,
          cols: ac.cols,
          values: ac.values,
          title: "Requests by area and category",
          cellName: (r, c) => `${ac.rows[r]} · ${ac.colNames[c]}`,
          cellHeight: 28,
          onRow: (r) => goTo("demand", { ...scope, area: String(ac.rowIds[r]) }),
        }),
      table: () => ({ columns: [{ label: "Area" }, ...ac.colNames.map((c) => ({ label: c, num: true }))], rows: ac.rows.map((r, i) => [r, ...ac.values[i]]) }),
      csv: "areas-by-category",
    });

    const understoodTotal = d.understood.reduce((sum, u) => sum + u.n, 0);
    const understood = vizCard({
      title: "How we understood requests",
      subtitle: "Our own engine first; Claude only when it's stuck",
      span: 4,
      empty: understoodTotal ? null : { title: "No requests yet", text: "How each request was read shows here." },
      draw: () => shareBar({ parts: inOrder(d.understood, UNDERSTOOD_COLORS, "by").map((u) => ({ name: UNDERSTOOD[u.by] ?? u.by, value: u.n, color: UNDERSTOOD_COLORS[u.by] ?? MUTED })) }),
      table: () => ({ columns: [{ label: "Read" }, { label: "Requests", num: true }], rows: d.understood.map((u) => [UNDERSTOOD[u.by] ?? u.by, u.n]) }),
      csv: "how-requests-were-understood",
    });

    return [...top("demand", "Demand", scope, d, opts), tiles, h("div", { class: "dash" }, cards(byGroup, table, searches, unmet, areaCats, understood))];
  }

  // ---------- Supply ----------

  async function supply(params, ticket) {
    const scope = scopeOf(params);
    const [d, opts] = await Promise.all([ctx.get(`/insights/supply?${queryOf(scope, { forApi: true })}`), filterOptions()]);
    if (ctx.stale(ticket)) return [];
    const k = d.kpis;
    const buckets = bucketLabels(d.period.buckets, d.period.grain);
    const each = d.period.grain === "week" ? "week" : "day";
    const cat = d.catalogue;

    const tiles = h(
      "div",
      { class: "viz-tiles cols-3" },
      statTile({ label: "Live businesses", measure: k.businesses, definition: DEFINITIONS.businesses, partial: false }),
      statTile({ label: "Verified", measure: k.verified, definition: "Live businesses our team has checked in person.", foot: `${shareText(k.verified.value, k.businesses.value)} of live businesses`, partial: false }),
      statTile({ label: "New businesses", measure: k.newBusinesses, definition: "Listings added in the period that are live now." }),
      statTile({ label: "Website sign-ups", measure: k.signups, definition: "Registrations started on the website (all cities). They finish when the owner sends the code from WhatsApp.", foot: `${num(d.signups.completed)} sent their code` }),
      statTile({ label: "Owners on the dashboard", measure: k.owners, definition: "Owners who signed in to their dashboard in the period.", foot: `of ${num(d.owners)} owners` }),
      statTile({ label: "Products listed", measure: k.products, definition: DEFINITIONS.products, partial: false }),
    );

    const growth = vizCard({
      title: "Businesses over time",
      subtitle: `Live businesses at the end of each ${each}, and how many of them are verified`,
      span: 8,
      draw: (box) =>
        lineChart(box, {
          buckets,
          title: "Live and verified businesses",
          partial: false,
          height: 300,
          series: [
            { name: "Live businesses", values: d.growth.businesses, color: ACCENT, area: true },
            { name: "Verified", values: d.growth.verified, color: SERIES[2] },
          ],
        }),
      table: () => ({ columns: [{ label: each === "week" ? "Week of" : "Day" }, { label: "Live", num: true }, { label: "Verified", num: true }], rows: buckets.map((b, i) => [b.long, d.growth.businesses[i], d.growth.verified[i]]) }),
      csv: `businesses-by-${each}`,
    });

    const joinedTotal = d.sources.reduce((sum, x) => sum + x.n, 0);
    const joined = vizCard({
      title: "How businesses joined",
      subtitle: "Live businesses, by how they were listed",
      span: 4,
      empty: joinedTotal ? null : { title: "No businesses yet", text: "How each business joined shows here." },
      draw: () =>
        h(
          "div",
          {},
          shareBar({ parts: inOrder(d.sources, JOINED_COLORS, "how").map((x) => ({ name: JOINED[x.how] ?? x.how, hint: x.recent ? `${num(x.recent)} this period` : null, value: x.n, color: JOINED_COLORS[x.how] ?? MUTED })) }),
          h(
            "ul",
            { class: "viz-facts", style: "margin-top:14px" },
            h("li", {}, h("span", {}, "Website sign-ups started", h("small", { text: "this period, all cities" })), h("strong", { text: num(d.signups.started) })),
            h("li", {}, h("span", { text: "Sent their WhatsApp code" }), h("strong", { text: `${num(d.signups.completed)} (${shareText(d.signups.completed, d.signups.started)})` })),
          ),
        ),
      table: () => ({ columns: [{ label: "Joined" }, { label: "Live businesses", num: true }, { label: "This period", num: true }], rows: d.sources.map((x) => [JOINED[x.how] ?? x.how, x.n, x.recent]) }),
      csv: "how-businesses-joined",
    });

    const gaps = [...d.coverage]
      .filter((c) => c.requests > 0)
      .sort((a, b) => b.unmet - a.unmet || (b.perBusiness ?? 1e9) - (a.perBusiness ?? 1e9))
      .slice(0, 10);
    const next = vizCard({
      title: "Where to sign up next",
      subtitle: "Categories with the most searches that found nobody, and the busiest per business",
      span: 6,
      empty: gaps.length ? null : { title: "No requests yet", text: "Once people ask, the categories that need more businesses show here." },
      draw: () =>
        rankedBars({
          rows: gaps.map((c) => ({
            key: c.slug,
            label: c.name,
            sub: c.businesses ? `${num(c.businesses)} business${c.businesses === 1 ? "" : "es"} · ${num(Math.round(c.perBusiness))} requests each` : "No businesses yet",
            value: c.requests,
            note: c.unmet ? `${num(c.unmet)} found nobody` : null,
            parts: [
              { name: "Found a supplier", value: c.requests - c.unmet, color: ACCENT },
              { name: "Found nobody", value: c.unmet, color: STATUS.warn },
            ],
          })),
          legend: [
            { name: "Found a supplier", color: ACCENT },
            { name: "Found nobody", color: STATUS.warn },
          ],
          onSelect: (slug) => goTo("supply", { ...scope, category: slug ?? "", group: "" }),
          selected: scope.category || null,
        }),
      table: () => ({
        columns: [{ label: "Category" }, { label: "Requests", num: true }, { label: "Found nobody", num: true }, { label: "Businesses", num: true }, { label: "Requests per business", num: true }],
        rows: gaps.map((c) => [c.name, c.requests, c.unmet, c.businesses, c.perBusiness == null ? "" : c.perBusiness.toFixed(1)]),
      }),
      csv: "where-to-sign-up-next",
    });

    const share = (n) => (cat.total ? n / cat.total : null);
    const catalogue = vizCard({
      title: "Catalogue health",
      subtitle: "Products on live listings now",
      span: 6,
      empty: cat.total ? null : { title: "No products yet", text: "When owners add products, their prices, photos and freshness show here." },
      draw: () =>
        h(
          "div",
          { class: "viz-meters" },
          meter({ label: "With a price", value: share(cat.priced), target: 0.9, foot: `${num(cat.priced)} of ${num(cat.total)}` }),
          meter({ label: `Price confirmed in the last ${cat.staleDays} days`, value: share(cat.fresh), target: 0.7, foot: `${num(cat.fresh)} of ${num(cat.total)}` }),
          meter({ label: "With a photo", value: share(cat.photo), target: 0.6, foot: `${num(cat.photo)} of ${num(cat.total)}` }),
          h("ul", { class: "viz-facts" }, h("li", {}, h("span", { text: "Businesses with products" }), h("strong", { text: `${num(cat.withProducts)} of ${num(cat.businesses)}` }))),
        ),
      table: () => ({
        columns: [{ label: "Products" }, { label: "Count", num: true }],
        rows: [
          ["Listed", cat.total],
          ["With a price", cat.priced],
          ["Price confirmed recently", cat.fresh],
          ["With a photo", cat.photo],
          ["In stock", cat.inStock],
        ],
      }),
      csv: "catalogue-health",
    });

    const activity = vizCard({
      title: "Catalogue activity",
      subtitle: `Products added and prices changed, each ${each}`,
      span: 12,
      draw: (box) =>
        columnChart(box, {
          buckets,
          title: "Products added and prices changed",
          series: [
            { name: "Products added", values: d.activity.added, color: SERIES[0] },
            { name: "Prices changed", values: d.activity.priceChanges, color: SERIES[1] },
          ],
          height: 220,
        }),
      table: () => ({ columns: [{ label: each === "week" ? "Week of" : "Day" }, { label: "Products added", num: true }, { label: "Prices changed", num: true }], rows: buckets.map((b, i) => [b.long, d.activity.added[i], d.activity.priceChanges[i]]) }),
      csv: `catalogue-activity-by-${each}`,
    });

    const maxConn = Math.max(1, ...d.leaders.map((l) => l.connections));
    const leaders = vizCard({
      title: "Top businesses",
      subtitle: "By customers connected this period. Pick one for its details.",
      span: 12,
      empty: d.leaders.length ? null : { title: "No connections yet", text: "Businesses customers choose most show here." },
      draw: () =>
        sortableTable(
          [
            { label: "Business", value: (l) => l.name, render: (l) => h("span", { class: "viz-name-cell" }, h("span", { text: l.name }), h("small", { text: [l.category, l.area, l.verification === "verified" ? "verified" : "not verified yet"].filter(Boolean).join(" · ") })) },
            { label: "Shown", num: true, value: (l) => l.shown, render: (l) => num(l.shown) },
            { label: "Connections", num: true, value: (l) => l.connections, render: (l) => cellBar(l.connections, maxConn) },
            { label: "Chosen when shown", num: true, value: (l) => (l.shown ? l.connections / l.shown : null), render: (l) => shareText(l.connections, l.shown) },
            { label: "Yes, sorted", num: true, value: (l) => (l.answered ? l.sorted / l.answered : null), render: (l) => (l.answered ? shareText(l.sorted, l.answered) : "–") },
            { label: "Rating", num: true, value: (l) => l.rating, render: (l) => (l.rating == null ? "–" : `${l.rating.toFixed(1)} ★`) },
            { label: "Products", num: true, value: (l) => l.products, render: (l) => num(l.products) },
          ],
          d.leaders,
          { sortBy: 2, onRow: (l) => ctx.openBusiness(l.id) },
        ),
      table: () => ({
        columns: [{ label: "Business" }, { label: "Category" }, { label: "Area" }, { label: "Shown", num: true }, { label: "Connections", num: true }, { label: "Yes, sorted", num: true }, { label: "Answered", num: true }, { label: "Rating", num: true }, { label: "Products", num: true }],
        rows: d.leaders.map((l) => [l.name, l.category ?? "", l.area ?? "", l.shown, l.connections, l.sorted, l.answered, l.rating == null ? "" : l.rating.toFixed(1), l.products]),
      }),
      csv: "top-businesses",
    });

    const watch = vizCard({
      title: "Needs attention",
      subtitle: "Open reports, businesses customers keep passing over, and ones that rarely reply",
      span: 12,
      empty: d.watch.length ? null : { title: "Nothing to look at", text: "Businesses with open reports, or that are shown often but never chosen, show here." },
      draw: () =>
        sortableTable(
          [
            { label: "Business", value: (w) => w.name, render: (w) => h("span", { class: "viz-name-cell" }, h("span", { text: w.name }), h("small", { text: [w.area, w.verification === "verified" ? "verified" : "not verified yet"].filter(Boolean).join(" · ") })) },
            { label: "Why", value: (w) => w.reasons.join(", "), render: (w) => h("span", { class: "badges" }, w.reasons.map((r) => h("span", { class: "badge warn", text: r }))) },
            { label: "Shown", num: true, value: (w) => w.shown, render: (w) => num(w.shown) },
            { label: "Connections", num: true, value: (w) => w.connections, render: (w) => num(w.connections) },
            { label: "Open reports", num: true, value: (w) => w.reports, render: (w) => num(w.reports) },
          ],
          d.watch,
          { sortBy: 4, onRow: (w) => ctx.openBusiness(w.id) },
        ),
      table: () => ({ columns: [{ label: "Business" }, { label: "Why" }, { label: "Shown", num: true }, { label: "Connections", num: true }, { label: "Open reports", num: true }], rows: d.watch.map((w) => [w.name, w.reasons.join("; "), w.shown, w.connections, w.reports]) }),
      csv: "needs-attention",
    });

    return [...top("supply", "Supply", scope, d, opts), tiles, h("div", { class: "dash" }, cards(growth, joined, next, catalogue, activity, leaders, watch))];
  }

  // ---------- Customer experience ----------

  async function experience(params, ticket) {
    const scope = scopeOf(params);
    const [d, opts] = await Promise.all([ctx.get(`/insights/customers?${queryOf(scope, { forApi: true })}`), filterOptions()]);
    if (ctx.stale(ticket)) return [];
    const k = d.kpis;
    const buckets = bucketLabels(d.period.buckets, d.period.grain);
    const each = d.period.grain === "week" ? "week" : "day";

    const tiles = h(
      "div",
      { class: "viz-tiles" },
      statTile({ label: "Customers", measure: k.customers, definition: DEFINITIONS.customers }),
      statTile({ label: "New customers", measure: k.newCustomers, definition: "People whose first request ever was in the period." }),
      statTile({ label: "Came back", measure: k.returning, format: "share", definition: "Of the period's customers, the share who asked on more than one day." }),
      statTile({ label: "Said “Yes, sorted”", measure: k.sorted, format: "share", definition: DEFINITIONS.sorted }),
      statTile({ label: "Average rating", measure: k.rating, format: "stars", definition: "The stars customers gave after a connection, from 1 to 5." }),
      statTile({ label: "Reports", measure: k.reports, better: "down", definition: "Reports customers made about a business." }),
      statTile({ label: "Product alerts sent", measure: k.alerts, definition: "Messages telling someone that a store near them now lists what they asked for." }),
      statTile({ label: "Stopped our messages", measure: k.stopped, better: "down", definition: "Customers who typed stop: no more follow-ups or alerts." }),
    );

    const mix = vizCard({
      title: "New and returning customers",
      subtitle: `People who asked each ${each}: new is their first time ever`,
      span: 8,
      empty: k.customers.value ? null : { title: "No customers yet", text: "New and returning customers show here once people ask." },
      draw: (box) =>
        columnChart(box, {
          buckets,
          stacked: true,
          title: "New and returning customers",
          series: [
            { name: "New", values: d.mix.fresh, color: SERIES[0] },
            { name: "Returning", values: d.mix.back, color: SERIES[1] },
          ],
          height: 240,
        }),
      table: () => ({ columns: [{ label: each === "week" ? "Week of" : "Day" }, { label: "New", num: true }, { label: "Returning", num: true }], rows: buckets.map((b, i) => [b.long, d.mix.fresh[i], d.mix.back[i]]) }),
      csv: `new-and-returning-by-${each}`,
    });

    const rated = d.ratings.reduce((sum, r) => sum + r.n, 0);
    const ratings = vizCard({
      title: "Ratings",
      subtitle: "Stars given this period",
      span: 4,
      empty: rated ? null : { title: "No ratings yet", text: "Customers rate a business after a connection; the spread shows here." },
      draw: (box) => columnChart(box, { buckets: d.ratings.map((r) => ({ label: `${r.stars} ★`, long: `${r.stars} star${r.stars === 1 ? "" : "s"}` })), title: "Ratings", series: [{ name: "Ratings", values: d.ratings.map((r) => r.n) }], height: 240 }),
      table: () => ({ columns: [{ label: "Stars" }, { label: "Ratings", num: true }], rows: d.ratings.map((r) => [r.stars, r.n]) }),
      csv: "ratings",
    });

    const out = d.outcomes;
    const OUTCOMES = [
      ["sorted", "Yes, sorted", STATUS.good],
      ["notYet", "Not yet", STATUS.neutral],
      ["couldntHelp", "Couldn't help", STATUS.warn],
      ["noReply", "No reply", STATUS.bad],
    ];
    const answered = OUTCOMES.reduce((sum, [key]) => sum + out[key].reduce((a, b) => a + b, 0), 0);
    const outcomes = vizCard({
      title: "How follow-ups went",
      subtitle: `Answers to our follow-up, by the ${each} of the connection`,
      span: 8,
      empty: answered ? null : { title: "No answers yet", text: "We ask each customer how it went the day after a connection." },
      draw: (box) =>
        columnChart(box, {
          buckets,
          percent: true,
          title: "Follow-up answers",
          series: OUTCOMES.map(([key, name, color]) => ({ name, values: out[key], color })),
          height: 240,
        }),
      table: () => ({ columns: [{ label: each === "week" ? "Week of" : "Day" }, ...OUTCOMES.map(([, name]) => ({ label: name, num: true }))], rows: buckets.map((b, i) => [b.long, ...OUTCOMES.map(([key]) => out[key][i])]) }),
      csv: `follow-up-answers-by-${each}`,
    });
    const totals = vizCard({
      title: "All answers",
      subtitle: "This period",
      span: 4,
      empty: answered ? null : { title: "No answers yet", text: "Answers add up here." },
      draw: () => shareBar({ parts: OUTCOMES.map(([key, name, color]) => ({ name, value: out[key].reduce((a, b) => a + b, 0), color })) }),
      table: () => ({ columns: [{ label: "Answer" }, { label: "Connections", num: true }], rows: OUTCOMES.map(([key, name]) => [name, out[key].reduce((a, b) => a + b, 0)]) }),
      csv: "follow-up-answers",
      foot: `${num(out.connections.reduce((a, b) => a + b, 0) - answered)} connections have no answer yet.`,
    });

    const weeks = d.cohorts;
    const cohorts = vizCard({
      title: "Who comes back",
      subtitle: "First-time customers each week, and the share who asked again in each week after",
      span: 12,
      empty: weeks.some((w) => w.customers) ? null : { title: "Not enough weeks yet", text: "After a few weeks of customers, you'll see how many come back." },
      draw: (box) =>
        heatmap(box, {
          rows: weeks.map((w) => `${bucketLabels([w.week], "week")[0].label} · ${num(w.customers)}`),
          cols: Array.from({ length: 8 }, (_, i) => `Week ${i + 1}`),
          values: weeks.map((w) => w.back.map((n) => (n == null || !w.customers ? null : n / w.customers))),
          format: "share",
          labels: true,
          title: "Returning customers by first week",
          cellName: (r, c) => `Started the week of ${bucketLabels([weeks[r].week], "week")[0].label}, ${c + 1} week${c ? "s" : ""} later`,
          rowWidth: 110,
          cellHeight: 28,
        }),
      table: () => ({
        columns: [{ label: "First week" }, { label: "Customers", num: true }, ...Array.from({ length: 8 }, (_, i) => ({ label: `Week ${i + 1}`, num: true }))],
        rows: weeks.map((w) => [w.week, w.customers, ...w.back.map((n) => (n == null ? "" : shareText(n, w.customers)))]),
      }),
      csv: "returning-customers-by-first-week",
    });

    return [...top("experience", "Customer experience", scope, d, opts), tiles, h("div", { class: "dash" }, cards(mix, ratings, outcomes, totals, cohorts))];
  }

  return { overview, demand, supply, experience };
}
