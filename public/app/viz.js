// The dashboards' charts: stat tiles with sparklines, trend lines against the period before, columns
// (single, grouped or stacked), ranked bars, part-to-whole bars, a funnel, heatmaps, a bubble map and
// meters, and a card that shows any chart as a table and downloads it as CSV. Plain SVG and HTML, no
// dependencies. Names and labels always go in as text, never as HTML.
//
// Colour follows docs/DASHBOARDS.md: one teal accent for a single series, grey for the period before,
// a fixed categorical order for several series (validated for colour-blind readers on the dark card),
// a one-hue teal ramp for magnitude and funnel stages, and status colours only for good and bad.

import { h, longDate, num, saveFile, shortDate } from "/assets/ui.js";

const NS = "http://www.w3.org/2000/svg";

function svg(name, attrs = {}, ...kids) {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) node.setAttribute(k, String(v));
  for (const kid of kids.flat()) if (kid != null && kid !== false) node.append(kid);
  return node;
}

function label(x, y, content, attrs = {}) {
  const t = svg("text", { x, y, ...attrs });
  t.textContent = content;
  return t;
}

/** Categorical slots, in their fixed order. A ninth series never gets a new colour: fold it into "Other". */
export const SERIES = ["var(--viz-1)", "var(--viz-2)", "var(--viz-3)", "var(--viz-4)", "var(--viz-5)", "var(--viz-6)", "var(--viz-7)", "var(--viz-8)"];
export const ACCENT = "var(--viz-accent)";
export const MUTED = "var(--viz-prev)";
export const STATUS = { good: "var(--viz-good)", warn: "var(--viz-warn)", bad: "var(--viz-bad)", neutral: "var(--viz-prev)" };
const SEQ = ["var(--viz-seq-1)", "var(--viz-seq-2)", "var(--viz-seq-3)", "var(--viz-seq-4)", "var(--viz-seq-5)", "var(--viz-seq-6)", "var(--viz-seq-7)"];
const ORD = ["var(--viz-ord-1)", "var(--viz-ord-2)", "var(--viz-ord-3)", "var(--viz-ord-4)", "var(--viz-ord-5)", "var(--viz-ord-6)"];

// ---------- Numbers ----------

const round1 = (x) => (Math.abs(x) >= 100 ? Math.round(x) : Math.round(x * 10) / 10);

/** 1,284 · 12.9K · 4.2M */
export function compact(n) {
  if (n == null || !Number.isFinite(Number(n))) return "–";
  const v = Number(n);
  const a = Math.abs(v);
  if (a >= 1e6) return `${round1(v / 1e6).toLocaleString("en-US")}M`;
  if (a >= 1e4) return `${round1(v / 1e3).toLocaleString("en-US")}K`;
  return Number.isInteger(v) ? num(v) : v.toLocaleString("en-US", { maximumFractionDigits: 1 });
}

const FORMATS = {
  count: (v) => compact(v),
  share: (v) => (v == null ? "–" : `${Math.round(v * 100)}%`),
  stars: (v) => (v == null ? "–" : `${Number(v).toFixed(1)}`),
  position: (v) => (v == null ? "–" : Number(v).toFixed(1)),
  money: (v) => (v == null ? "–" : `$${Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`),
};

/** A value as the dashboards write it: count, share, stars, position or money. */
export const formatValue = (kind, v) => (FORMATS[kind] ?? FORMATS.count)(v);

/** Gridline labels: whole numbers, percentages, or one decimal. */
function tickText(kind, v) {
  if (kind === "share") return `${Math.round(v * 100)}%`;
  if (kind === "money") return `$${compact(v)}`;
  return compact(v);
}

/** A round step for about four gridlines, and the top of the scale. Counts get whole-number steps. */
function niceScale(max, integer) {
  if (!(max > 0)) return integer ? { top: 4, step: 1 } : { top: 1, step: 0.25 };
  const rough = max / 4;
  const mag = 10 ** Math.floor(Math.log10(rough));
  const steps = (integer ? [1, 2, 5, 10] : [1, 2, 2.5, 5, 10]).map((m) => m * mag).filter((s) => !integer || (s >= 1 && Number.isInteger(s)));
  const step = steps.find((s) => s >= rough) ?? (integer ? Math.max(1, Math.ceil(rough)) : 10 * mag);
  return { top: Math.ceil(max / step - 1e-9) * step, step };
}

// ---------- Periods ----------

export const PERIODS = [
  [7, "7 days"],
  [30, "30 days"],
  [90, "90 days"],
  [365, "12 months"],
];
export const periodName = (days) => PERIODS.find(([d]) => d === days)?.[1] ?? `${days} days`;
/** "the 30 days before", "the 12 months before" */
export const beforeName = (days) => `the ${periodName(days)} before`;

/** The dates a period covers, for reports: "3 Sep – 2 Oct 2026". A year's last week runs to today. */
export function periodRange(buckets, grain) {
  const first = buckets[0];
  const today = new Date(Date.now() + 2 * 3600_000).toISOString().slice(0, 10); // Harare
  const last = grain === "week" ? today : buckets.at(-1);
  if (!first || !last) return "";
  const year = last.slice(0, 4);
  return `${shortDate(first)}${first.slice(0, 4) === year ? "" : ` ${first.slice(0, 4)}`} – ${shortDate(last)} ${year}`;
}

/**
 * Axis and tooltip labels for a period's buckets (days, or weeks for a year). The current period's last
 * bucket is still going (today, or this week): it's marked, and charts draw it lighter, so a day that's
 * half over doesn't read as a fall.
 */
export function bucketLabels(keys, grain, { current = true } = {}) {
  return keys.map((key, i) => {
    const partial = current && i === keys.length - 1;
    const long = grain === "week" ? `Week of ${shortDate(key)}` : longDate(key);
    return { key, label: shortDate(key), long: partial ? `${long} (so far)` : long, partial };
  });
}

// ---------- Deltas and stat tiles ----------

const ARROWS = { up: '<path d="M6 2 10.5 8h-9z"/>', down: '<path d="M6 10 1.5 4h9z"/>' };
function arrow(dir) {
  const tpl = document.createElement("template");
  tpl.innerHTML = `<svg width="10" height="10" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">${ARROWS[dir]}</svg>`;
  return tpl.content.firstChild;
}

/**
 * The change on the period before: a percentage for counts, points for shares, a plain difference for
 * ratings and positions. Coloured by whether the change is good, with an arrow, so never by colour alone.
 */
export function delta(now, prev, { kind = "count", better = "up" } = {}) {
  if (now == null || prev == null) return h("span", { class: "viz-delta flat", text: "No comparison" });
  let diff;
  let text;
  if (kind === "share") {
    diff = (now - prev) * 100;
    text = `${Math.abs(Math.round(diff))} pts`;
    if (Math.abs(diff) < 0.5) diff = 0;
  } else if (kind === "stars" || kind === "position") {
    diff = now - prev;
    text = Math.abs(diff).toFixed(1);
    if (Math.abs(diff) < 0.05) diff = 0;
  } else {
    if (!prev) return h("span", { class: "viz-delta flat", text: now ? "New this period" : "No change" });
    diff = (now - prev) / prev;
    text = `${Math.abs(Math.round(diff * 100))}%`;
    if (Math.abs(diff) < 0.005) diff = 0;
  }
  if (!diff) return h("span", { class: "viz-delta flat", text: "No change" });
  const dir = diff > 0 ? "up" : "down";
  const good = better === "none" ? null : dir === better;
  return h(
    "span",
    { class: `viz-delta ${dir}${good == null ? "" : good ? " good" : " bad"}`, "aria-label": `${dir === "up" ? "Up" : "Down"} ${text}` },
    arrow(dir),
    text,
  );
}

/** A small trend line for a tile: this period in the accent, the period before in grey. The last point,
 *  still in progress, joins on with a lighter dashed segment. */
export function sparkline(values, prev, { partial = true } = {}) {
  const box = h("div", { class: "viz-spark", "aria-hidden": "true" });
  const all = [...values, ...(prev ?? [])].filter((v) => v != null);
  if (values.filter((v) => v != null).length < 2) return box;
  const max = Math.max(...all, 0);
  const min = Math.min(...all, 0);
  const span = max - min || 1;
  const W = 120;
  const H = 32;
  const x = (i) => (values.length === 1 ? W / 2 : (i / (values.length - 1)) * W);
  const y = (v) => H - 3 - ((v - min) / span) * (H - 6);
  const path = (vals) => {
    let d = "";
    let pen = false;
    vals.forEach((v, i) => {
      if (v == null) return void (pen = false);
      d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  const root = svg("svg", { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "none", width: "100%", height: H });
  if (prev?.length === values.length) root.append(svg("path", { d: path(prev), class: "viz-spark-prev", "vector-effect": "non-scaling-stroke" }));
  const done = partial ? values.slice(0, -1) : values;
  if (done.every((v) => v != null) && done.length > 1) {
    root.append(svg("path", { d: `${path(done)}L${x(done.length - 1)},${H}L0,${H}Z`, class: "viz-spark-area" }));
  }
  root.append(svg("path", { d: path(done), class: "viz-spark-line", "vector-effect": "non-scaling-stroke" }));
  const n = values.length;
  if (partial && n > 1 && values[n - 1] != null && values[n - 2] != null) {
    root.append(svg("path", { d: `M${x(n - 2)},${y(values[n - 2])}L${x(n - 1)},${y(values[n - 1])}`, class: "viz-spark-line partial", "vector-effect": "non-scaling-stroke" }));
  }
  box.append(root);
  // The latest value as a dot, in HTML so it stays round however wide the tile is.
  const lastIndex = values.findLastIndex((v) => v != null);
  const dot = h("span", { class: `viz-spark-dot${partial && lastIndex === values.length - 1 ? " partial" : ""}` });
  dot.style.left = `${(x(lastIndex) / W) * 100}%`;
  dot.style.top = `${(y(values[lastIndex]) / H) * 100}%`;
  box.append(dot);
  return box;
}

let tipIds = 0;

/** A short explanation behind an (i), on hover, focus or tap. */
export function info(text) {
  const id = `viz-info-${++tipIds}`;
  return h(
    "span",
    { class: "viz-info" },
    h("button", { type: "button", class: "viz-info-btn", "aria-label": "What this measures", "aria-describedby": id }, "i"),
    h("span", { class: "viz-info-pop", role: "tooltip", id, text }),
  );
}

/**
 * A stat tile: label, value, the change on the period before, and a sparkline.
 * measure: { value, prev, series, prevSeries }. format: count, share, stars, position or money.
 */
export function statTile({ label: name, measure, format = "count", better = "up", definition, foot, href, compareTo, deltaKind, partial = true }) {
  const m = measure ?? { value: null, prev: null, series: [], prevSeries: [] };
  const value = formatValue(format, m.value);
  // A share swings from day to day on small numbers: its sparkline is the share over the last 7 days
  // (or 4 weeks), worked out from the counts behind it.
  const window = m.parts && m.series?.length > 7 ? (m.series.length === 52 ? 4 : 7) : 0;
  const spark = window ? rolling(m.parts.num, m.parts.den, window) : m.series;
  const sparkBefore = window ? rolling(m.parts.prevNum, m.parts.prevDen, window) : m.prevSeries;
  // A tile that opens a report gets a link over it, so the (i) button stays a button of its own.
  return h(
    "div",
    { class: `card viz-tile${href ? " is-link" : ""}` },
    href ? h("a", { class: "viz-tile-link", href, "aria-label": `${name}: open the report` }) : null,
    h("div", { class: "viz-tile-head" }, h("span", { class: "viz-tile-label", text: name }), definition ? info(definition) : null),
    h("div", { class: "viz-tile-value" }, value, format === "stars" && m.value != null ? h("span", { class: "viz-tile-unit", text: "★" }) : null),
    h(
      "div",
      { class: "viz-tile-foot" },
      delta(m.value, m.prev, { kind: deltaKind ?? (format === "count" || format === "money" ? "count" : format), better }),
      compareTo ? h("span", { class: "viz-tile-vs", text: `vs ${compareTo}` }) : null,
    ),
    spark?.length > 1 ? sparkline(spark, sparkBefore, { partial }) : null,
    foot ? h("div", { class: "viz-tile-note", text: foot }) : null,
  );
}

/** A share over a trailing window of buckets, from its counts. Null until there's something to divide by. */
function rolling(num, den, window) {
  return num.map((_, i) => {
    let n = 0;
    let d = 0;
    for (let k = Math.max(0, i - window + 1); k <= i; k++) {
      n += num[k] ?? 0;
      d += den[k] ?? 0;
    }
    return d ? n / d : null;
  });
}

// ---------- Shared chart parts ----------

/** Draw once the box has a width, and again whenever the width (or, if asked, the height) changes. */
function onWidth(box, draw, { height = false } = {}) {
  let lastW = 0;
  let lastH = 0;
  const run = () => {
    const w = box.clientWidth;
    const hh = box.clientHeight;
    if (w > 0 && (Math.abs(w - lastW) >= 4 || (height && Math.abs(hh - lastH) >= 4))) {
      lastW = w;
      lastH = hh;
      draw(w, hh);
    }
  };
  const ro = new ResizeObserver(run);
  ro.observe(box);
  run();
  return () => ro.disconnect();
}

/** One tooltip per chart: values lead, names follow, a line key shows which series. */
function tooltip(host) {
  const tip = h("div", { class: "viz-tip", hidden: true });
  return {
    el: tip,
    show(x, y, title, rows) {
      tip.replaceChildren(
        title ? h("div", { class: "viz-tip-title", text: title }) : null,
        ...rows.map((r) =>
          h(
            "div",
            { class: "viz-tip-row" },
            r.color ? h("span", { class: `viz-key ${r.shape ?? "line"}`, style: `--key:${r.color}` }) : null,
            h("strong", { text: r.value }),
            r.name ? h("span", { text: r.name }) : null,
          ),
        ),
      );
      tip.hidden = false;
      const half = tip.offsetWidth / 2;
      tip.style.left = `${Math.max(half, Math.min(host.clientWidth - half, x))}px`;
      tip.style.top = `${y}px`;
    },
    hide() {
      tip.hidden = true;
    },
  };
}

/** A legend for two or more series: the key mirrors the mark (a line for lines, a block for bars). */
export function legend(items, shape = "line") {
  return h(
    "div",
    { class: "viz-legend" },
    items.map((it) => h("span", { class: "viz-legend-item" }, h("span", { class: `viz-key ${it.shape ?? shape}`, style: `--key:${it.color}` }), it.name)),
  );
}

/** Label every nth bucket, so labels never touch: n depends on the longest label and the room there is. */
function axisLabels(buckets, plotWidth) {
  const longest = Math.max(1, ...buckets.map((b) => String(b.label).length));
  const room = Math.max(1, Math.floor(plotWidth / (longest * 6.4 + 14)));
  return Math.max(1, Math.ceil(buckets.length / room));
}

// ---------- Lines over time ----------

/**
 * Lines over time on one axis (never two scales): this period in the accent, and context series (the
 * period before) in grey under it. A crosshair finds the nearest day and the tooltip lists every series.
 * series: [{ name, values, color?, muted?, area? }]
 */
export function lineChart(box, { buckets, series, format = "count", title = "", height = 240, yMax, integer, partial: showPartial = true }) {
  box.classList.add("viz");
  const visible = series.filter((s) => s.values?.length);
  if (visible.length > 1) box.append(legend(visible.map((s) => ({ name: s.name, color: s.color ?? (s.muted ? MUTED : ACCENT) }))));
  const plot = h("div", { class: "viz-plot" });
  box.append(plot);
  const tip = tooltip(plot);
  const main = visible.find((s) => !s.muted) ?? visible[0];
  const total = (main?.values ?? []).reduce((s, v) => s + (v ?? 0), 0);

  return onWidth(plot, (width) => {
    const all = visible.flatMap((s) => s.values).filter((v) => v != null);
    const { top, step } = niceScale(yMax ?? Math.max(0, ...all), integer ?? (format === "count"));
    const ticks = [];
    for (let v = 0; v <= top + 1e-9; v += step) ticks.push(v);
    const m = { top: 12, right: 14, bottom: 26, left: Math.max(...ticks.map((v) => tickText(format, v).length)) * 7 + 14 };
    const w = Math.max(10, width - m.left - m.right);
    const hh = height - m.top - m.bottom;
    const n = buckets.length;
    const x = (i) => m.left + (n === 1 ? w / 2 : (i / (n - 1)) * w);
    const y = (v) => m.top + hh - (v / top) * hh;
    const summary = `${title}: ${format === "count" ? `${compact(total)} in total` : ""}`.trim();
    const root = svg("svg", { width, height, viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": summary, tabindex: 0, class: "viz-svg" });

    for (const v of ticks) {
      root.append(svg("line", { x1: m.left, x2: width - m.right, y1: y(v), y2: y(v), class: v === 0 ? "viz-base" : "viz-grid" }));
      root.append(label(m.left - 8, y(v) + 4, tickText(format, v), { class: "viz-tick", "text-anchor": "end" }));
    }
    const every = axisLabels(buckets, w);
    buckets.forEach((b, i) => {
      if ((n - 1 - i) % every) return;
      const anchor = n > 1 && i === 0 ? "start" : i === n - 1 && n > 1 ? "end" : "middle";
      root.append(label(x(i), height - 7, b.label, { class: "viz-tick", "text-anchor": anchor }));
    });

    const path = (vals) => {
      let d = "";
      let pen = false;
      vals.forEach((v, i) => {
        if (v == null) return void (pen = false);
        d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(Math.min(v, top)).toFixed(1)}`;
        pen = true;
      });
      return d;
    };
    const ordered = [...visible].sort((a, b) => Number(Boolean(b.muted)) - Number(Boolean(a.muted)));
    // The current period's last bucket is still going: its segment is drawn lighter and dashed.
    const partial = showPartial && buckets[n - 1]?.partial && n > 2;
    for (const s of ordered) {
      const color = s.color ?? (s.muted ? MUTED : ACCENT);
      const open = partial && !s.muted;
      const done = open ? s.values.slice(0, -1) : s.values;
      if (s.area && done.every((v) => v != null) && done.length > 1) {
        root.append(svg("path", { d: `${path(done)}L${x(done.length - 1)},${y(0)}L${x(0)},${y(0)}Z`, class: "viz-area", style: `fill:${color}` }));
      }
      root.append(svg("path", { d: path(done), class: `viz-line${s.muted ? " muted" : ""}`, style: `stroke:${color}` }));
      if (open && s.values[n - 1] != null && s.values[n - 2] != null) {
        root.append(svg("path", { d: `M${x(n - 2)},${y(Math.min(s.values[n - 2], top))}L${x(n - 1)},${y(Math.min(s.values[n - 1], top))}`, class: "viz-line partial", style: `stroke:${color}` }));
      }
    }
    // The latest value of each main series, as an end dot.
    for (const s of visible.filter((x_) => !x_.muted)) {
      const last = s.values.findLastIndex((v) => v != null);
      if (last >= 0) root.append(svg("circle", { cx: x(last), cy: y(Math.min(s.values[last], top)), r: 4, class: `viz-dot${partial && last === n - 1 ? " partial" : ""}`, style: `fill:${s.color ?? ACCENT}` }));
    }

    // Crosshair and tooltip.
    const cross = svg("g", { class: "viz-cross", visibility: "hidden" });
    const hair = svg("line", { y1: m.top, y2: m.top + hh, class: "viz-hair" });
    cross.append(hair);
    const dots = visible.map((s) => {
      const c = svg("circle", { r: 4, class: "viz-dot", style: `fill:${s.color ?? (s.muted ? MUTED : ACCENT)}` });
      cross.append(c);
      return c;
    });
    root.append(cross);
    let active = -1;
    const show = (i) => {
      active = i;
      cross.setAttribute("visibility", "visible");
      hair.setAttribute("x1", x(i));
      hair.setAttribute("x2", x(i));
      visible.forEach((s, k) => {
        const v = s.values[i];
        dots[k].setAttribute("visibility", v == null ? "hidden" : "visible");
        if (v != null) {
          dots[k].setAttribute("cx", x(i));
          dots[k].setAttribute("cy", y(Math.min(v, top)));
        }
      });
      const rows = [...visible]
        .sort((a, b) => Number(Boolean(a.muted)) - Number(Boolean(b.muted)))
        .map((s) => ({ value: formatValue(format, s.values[i]), name: s.labelAt ? s.labelAt(i) : s.name, color: s.color ?? (s.muted ? MUTED : ACCENT) }));
      const ys = visible.map((s) => s.values[i]).filter((v) => v != null);
      tip.show(x(i), ys.length ? y(Math.min(Math.max(...ys), top)) : m.top, buckets[i]?.long ?? "", rows);
    };
    const hide = () => {
      active = -1;
      cross.setAttribute("visibility", "hidden");
      tip.hide();
    };
    const hit = svg("rect", { x: m.left - 8, y: m.top, width: w + 16, height: hh, fill: "transparent" });
    const nearest = (evt) => {
      const r = root.getBoundingClientRect();
      const px = ((evt.clientX - r.left) / r.width) * width;
      return Math.max(0, Math.min(n - 1, Math.round(((px - m.left) / w) * (n - 1))));
    };
    hit.addEventListener("pointermove", (e) => show(nearest(e)));
    hit.addEventListener("pointerdown", (e) => show(nearest(e)));
    root.addEventListener("pointerleave", hide);
    root.addEventListener("focus", () => show(active >= 0 ? active : n - 1));
    root.addEventListener("blur", hide);
    root.addEventListener("keydown", (e) => {
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        show(Math.max(0, Math.min(n - 1, (active < 0 ? n - 1 : active) + (e.key === "ArrowLeft" ? -1 : 1))));
      } else if (e.key === "Escape") hide();
    });
    root.append(hit);
    plot.replaceChildren(root, tip.el);
  });
}

// ---------- Columns ----------

/** A bar with a rounded data end and a square base. */
function bar(x0, yTop, width, yBase, radius = 4) {
  const r = Math.max(0, Math.min(radius, width / 2, yBase - yTop));
  return `M${x0},${yBase}V${yTop + r}Q${x0},${yTop} ${x0 + r},${yTop}H${x0 + width - r}Q${x0 + width},${yTop} ${x0 + width},${yTop + r}V${yBase}Z`;
}

/**
 * Columns per bucket: one series, several side by side, or stacked (optionally to 100%). Thin bars,
 * a 2px gap between stacked segments, and one tooltip per bucket listing every series.
 * series: [{ name, values, color }]
 */
export function columnChart(box, { buckets, series, stacked = false, percent = false, format = "count", title = "", height = 240, integer, onSelect }) {
  box.classList.add("viz");
  if (series.length > 1) box.append(legend(series.map((s, i) => ({ name: s.name, color: s.color ?? SERIES[i] })), "box"));
  const plot = h("div", { class: "viz-plot" });
  box.append(plot);
  const tip = tooltip(plot);
  const colorOf = (s, i) => s.color ?? (series.length === 1 ? ACCENT : SERIES[i]);
  const totals = buckets.map((_, i) => series.reduce((sum, s) => sum + (s.values[i] ?? 0), 0));
  const valueAt = (s, i) => {
    const v = s.values[i] ?? 0;
    return percent ? (totals[i] ? v / totals[i] : 0) : v;
  };
  const kind = percent ? "share" : format;

  return onWidth(plot, (width) => {
    const n = buckets.length;
    const max = percent ? 1 : stacked ? Math.max(0, ...totals) : Math.max(0, ...series.flatMap((s) => s.values.map((v) => v ?? 0)));
    const { top, step } = percent ? { top: 1, step: 0.25 } : niceScale(max, integer ?? (format === "count"));
    const ticks = [];
    for (let v = 0; v <= top + 1e-9; v += step) ticks.push(v);
    const m = { top: 12, right: 6, bottom: 26, left: Math.max(...ticks.map((v) => tickText(kind, v).length)) * 7 + 14 };
    const w = Math.max(10, width - m.left - m.right);
    const hh = height - m.top - m.bottom;
    const y = (v) => m.top + hh - (Math.min(v, top) / top) * hh;
    const base = m.top + hh;
    const slot = w / Math.max(n, 1);
    const groups = stacked || percent ? 1 : series.length;
    const barW = Math.max(2, Math.min(24, (slot * 0.72) / groups - (groups > 1 ? 2 : 0)));
    const root = svg("svg", { width, height, viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": title, class: "viz-svg" });
    for (const v of ticks) {
      root.append(svg("line", { x1: m.left, x2: width - m.right, y1: y(v), y2: y(v), class: v === 0 ? "viz-base" : "viz-grid" }));
      root.append(label(m.left - 8, y(v) + 4, tickText(kind, v), { class: "viz-tick", "text-anchor": "end" }));
    }
    const every = axisLabels(buckets, w);
    const columns = [];
    buckets.forEach((b, i) => {
      const cx = m.left + slot * i + slot / 2;
      const g = svg("g", { class: `viz-col${b.partial ? " partial" : ""}` });
      if (stacked || percent) {
        let cum = 0;
        const parts = series.map((s, k) => ({ v: valueAt(s, i), k })).filter((p) => p.v > 0);
        parts.forEach((p, j) => {
          const y0 = y(cum);
          const y1 = y(cum + p.v);
          cum += p.v;
          const gapBelow = j > 0 ? 2 : 0;
          const segBase = y0 - gapBelow;
          if (segBase - y1 < 1) return;
          const d = j === parts.length - 1 ? bar(cx - barW / 2, y1, barW, segBase) : `M${cx - barW / 2},${segBase}V${y1}H${cx + barW / 2}V${segBase}Z`;
          g.append(svg("path", { d, style: `fill:${colorOf(series[p.k], p.k)}` }));
        });
      } else {
        series.forEach((s, k) => {
          const v = valueAt(s, i);
          if (!(v > 0)) return;
          const x0 = cx - (groups * (barW + 2) - 2) / 2 + k * (barW + 2);
          g.append(svg("path", { d: bar(x0, y(v), barW, base), style: `fill:${colorOf(s, k)}` }));
        });
      }
      root.append(g);
      columns.push(g);
      if (!((n - 1 - i) % every)) root.append(label(cx, height - 7, b.label, { class: "viz-tick", "text-anchor": "middle" }));
    });
    const show = (i) => {
      columns.forEach((c, k) => c.setAttribute("opacity", k === i ? "1" : "0.45"));
      const rows = series.map((s, k) => ({
        value: percent ? `${formatValue("share", valueAt(s, i))} · ${formatValue(format, s.values[i] ?? 0)}` : formatValue(format, s.values[i] ?? 0),
        name: series.length > 1 ? s.name : s.name ?? "",
        color: series.length > 1 ? colorOf(s, k) : null,
        shape: "box",
      }));
      if (stacked && series.length > 1 && !percent) rows.push({ value: formatValue(format, totals[i]), name: "in all" });
      const topY = stacked || percent ? y(percent ? 1 : totals[i]) : y(Math.max(0, ...series.map((s) => s.values[i] ?? 0)));
      tip.show(m.left + slot * i + slot / 2, topY, buckets[i].long ?? buckets[i].label, rows);
    };
    const hide = () => {
      columns.forEach((c) => c.removeAttribute("opacity"));
      tip.hide();
    };
    buckets.forEach((_, i) => {
      const hit = svg("rect", { x: m.left + slot * i, y: m.top, width: slot, height: hh, fill: "transparent", class: onSelect ? "viz-hit pick" : "viz-hit" });
      hit.addEventListener("pointerenter", () => show(i));
      hit.addEventListener("pointerdown", () => show(i));
      if (onSelect) hit.addEventListener("click", () => onSelect(buckets[i], i));
      root.append(hit);
    });
    root.addEventListener("pointerleave", hide);
    plot.replaceChildren(root, tip.el);
  });
}

// ---------- Ranked bars ----------

/**
 * A ranked list with a bar under each name, longest first. A bar can be split into parts (say found and
 * not found) with a 2px gap; rows can be picked to filter the page, which dims the others.
 * rows: [{ key, label, sub, value, parts?: [{ name, value, color }], note }]
 */
export function rankedBars({ rows, format = "count", legend: items, onSelect, selected, max }) {
  const top = max ?? Math.max(1, ...rows.map((r) => r.value ?? 0));
  const picked = selected != null && rows.some((r) => r.key === selected);
  return h(
    "div",
    { class: "viz-ranked-wrap" },
    items?.length ? legend(items, "box") : null,
    h(
      "ol",
      { class: `viz-ranked${picked ? " has-pick" : ""}` },
      rows.map((r) => {
        const parts = r.parts?.filter((p) => p.value > 0) ?? [{ value: r.value, color: r.color ?? ACCENT }];
        const body = [
          h(
            "span",
            { class: "viz-rank-head" },
            h("span", { class: "viz-rank-label" }, h("span", { text: r.label }), r.sub ? h("small", { text: r.sub }) : null),
            h("span", { class: "viz-rank-value" }, formatValue(format, r.value), r.note ? h("small", { text: r.note }) : null),
          ),
          h(
            "span",
            { class: "viz-rank-track" },
            h(
              "span",
              { class: "viz-rank-fill", style: `width:${Math.max(r.value > 0 ? 1.5 : 0, ((r.value ?? 0) / top) * 100)}%` },
              parts.map((p) => h("span", { class: "viz-rank-part", style: `flex-grow:${p.value};background:${p.color ?? ACCENT}`, title: p.name ? `${p.name}: ${formatValue(format, p.value)}` : null })),
            ),
          ),
        ];
        const isPicked = picked && r.key === selected;
        return h(
          "li",
          { class: isPicked ? "picked" : "" },
          onSelect
            ? h("button", { type: "button", class: "viz-rank-row", "aria-pressed": String(isPicked), onclick: () => onSelect(isPicked ? null : r.key, r) }, body)
            : h("div", { class: "viz-rank-row" }, body),
        );
      }),
    ),
  );
}

// ---------- Part to whole ----------

/** One bar split into its parts (2px gaps), then each part with its value and share. */
export function shareBar({ parts, format = "count" }) {
  const total = parts.reduce((s, p) => s + (p.value ?? 0), 0);
  return h(
    "div",
    { class: "viz-share" },
    h(
      "div",
      { class: "viz-share-bar", role: "img", "aria-label": parts.map((p) => `${p.name} ${formatValue(format, p.value)}`).join(", ") },
      total ? parts.filter((p) => p.value > 0).map((p) => h("span", { style: `flex-grow:${p.value};background:${p.color}` })) : h("span", { class: "empty" }),
    ),
    h(
      "ul",
      { class: "viz-share-list" },
      parts.map((p) =>
        h(
          "li",
          {},
          h("span", { class: "viz-key box", style: `--key:${p.color}` }),
          h("span", { class: "viz-share-name" }, p.name, p.hint ? h("small", { text: p.hint }) : null),
          h("strong", { text: formatValue(format, p.value) }),
          h("span", { class: "viz-share-pct", text: total ? `${Math.round((100 * (p.value ?? 0)) / total)}%` : "–" }),
        ),
      ),
    ),
  );
}

// ---------- Funnel ----------

/** Stages from first to last: each bar's length is its share of the first stage; one hue, darker as it narrows. */
export function funnel({ stages, format = "count" }) {
  const first = stages[0]?.value ?? 0;
  return h(
    "ol",
    { class: "viz-funnel" },
    stages.map((s, i) => {
      const prev = i ? stages[i - 1].value : null;
      return h(
        "li",
        {},
        h("span", { class: "viz-funnel-head" }, h("span", { text: s.label }), h("strong", { text: formatValue(format, s.value) })),
        h("span", { class: "viz-funnel-track" }, h("span", { class: "viz-funnel-fill", style: `width:${first ? Math.max(s.value ? 1 : 0, (100 * s.value) / first) : 0}%;background:${ORD[Math.min(i, ORD.length - 1)]}` })),
        i
          ? h("span", { class: "viz-funnel-note", text: `${prev ? Math.round((100 * s.value) / prev) : 0}% of the stage before · ${first ? Math.round((100 * s.value) / first) : 0}% of all` })
          : null,
      );
    }),
  );
}

// ---------- Heatmap ----------

/**
 * A grid coloured by magnitude on one teal ramp (darker = fewer, brighter = more), with a scale. Empty
 * cells stay the card's colour. values: rows × cols.
 */
export function heatmap(box, { rows, cols, values, format = "count", title = "", colEvery = 1, cellName, rowWidth, onRow, cellHeight = 24, labels = false }) {
  box.classList.add("viz");
  const plot = h("div", { class: "viz-plot" });
  const max = Math.max(0, ...values.flat().filter((v) => v != null));
  box.append(plot, scaleLegend(max, format));
  const tip = tooltip(plot);
  const binOf = (v) => (v > 0 ? Math.min(SEQ.length - 1, Math.max(0, Math.ceil((v / max) * SEQ.length) - 1)) : -1);
  return onWidth(plot, (width) => {
    const left = rowWidth ?? Math.min(170, Math.max(...rows.map((r) => String(r).length)) * 7 + 14);
    const cw = Math.max(8, (width - left) / cols.length);
    // A head can use the width of the columns it stands for (every third hour, say), not just its own.
    const heads = cols.map((c) => headLines(String(c), Math.max(3, Math.floor((cw * colEvery - 4) / 5.9))));
    const bottom = heads.some((l) => l.length > 1) ? 38 : 24;
    const height = rows.length * cellHeight + bottom;
    const root = svg("svg", { width, height, viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": title, class: "viz-svg" });
    rows.forEach((r, ri) => {
      const rowLabel = label(left - 8, ri * cellHeight + cellHeight / 2 + 4, r, { class: `viz-tick${onRow ? " pick" : ""}`, "text-anchor": "end" });
      if (onRow) rowLabel.addEventListener("click", () => onRow(ri));
      root.append(rowLabel);
      cols.forEach((c, ci) => {
        // No value (say, a week that hasn't happened yet) leaves the cell blank.
        if (values[ri][ci] == null) return;
        const v = values[ri][ci];
        const bin = binOf(v);
        const cell = svg("rect", { x: left + ci * cw + 1, y: ri * cellHeight + 1, width: Math.max(1, cw - 2), height: cellHeight - 2, rx: 3, style: `fill:${bin < 0 ? "var(--viz-zero)" : SEQ[bin]}`, class: "viz-cell" });
        cell.addEventListener("pointerenter", () => {
          cell.classList.add("on");
          tip.show(left + ci * cw + cw / 2, ri * cellHeight, cellName ? cellName(ri, ci) : `${r} · ${c}`, [{ value: formatValue(format, v), name: "" }]);
        });
        cell.addEventListener("pointerleave", () => {
          cell.classList.remove("on");
          tip.hide();
        });
        root.append(cell);
        // The value inside the cell when it fits: dark ink on the bright steps, light ink on the rest.
        const text = formatValue(format, v);
        if (labels && cw >= text.length * 6.6 + 8 && cellHeight >= 20) {
          const t = label(left + ci * cw + cw / 2, ri * cellHeight + cellHeight / 2 + 4, text, { class: `viz-cell-label${bin >= 4 ? " on-bright" : ""}`, "text-anchor": "middle" });
          root.append(t);
        }
      });
    });
    cols.forEach((c, ci) => {
      if (ci % colEvery) return;
      const t = svg("text", { x: left + ci * cw + cw / 2, y: rows.length * cellHeight + 15, class: "viz-tick", "text-anchor": "middle" });
      heads[ci].forEach((line, k) => {
        const span = svg("tspan", { x: left + ci * cw + cw / 2, dy: k ? 12 : 0 });
        span.textContent = line;
        t.append(span);
      });
      root.append(t);
    });
    plot.replaceChildren(root, tip.el);
  });
}

/** A column head on one line if it fits, else two, cut short with an ellipsis if still too long. */
function headLines(text, maxChars) {
  if (text.length <= maxChars) return [text];
  const cut = (s) => (s.length > maxChars ? `${s.slice(0, Math.max(1, maxChars - 1))}…` : s);
  const words = text.split(/\s+/);
  let first = words.shift() ?? "";
  while (words.length && `${first} ${words[0]}`.length <= maxChars) first = `${first} ${words.shift()}`;
  return words.length ? [cut(first), cut(words.join(" "))] : [cut(first)];
}

function scaleLegend(max, format) {
  return h(
    "div",
    { class: "viz-scale", "aria-hidden": "true" },
    h("span", { text: "Fewer" }),
    h("span", { class: "viz-scale-steps" }, h("span", { style: "background:var(--viz-zero)" }), SEQ.map((c) => h("span", { style: `background:${c}` }))),
    h("span", { text: `More (up to ${formatValue(format, max)})` }),
  );
}

// ---------- Bubble map ----------

const KM_PER_DEGREE = 111.32;

/**
 * Places as bubbles, by latitude and longitude (north up), sized by value. Rings mark the distance
 * from the city centre. Bubbles can be picked to filter the page.
 * points: [{ id, name, lat, lng, value, lines?: [text] }]
 */
export function bubbleMap(box, { points, centre, rings = [], format = "count", title = "", height: fixedHeight = 340, fill = false, onSelect, selected, labels = 7 }) {
  box.classList.add("viz");
  // Filling: the map takes whatever height its card has (beside a taller card, say), at least 320px.
  if (fill) box.classList.add("viz-fill");
  const plot = h("div", { class: `viz-plot${fill ? " viz-fill-plot" : ""}` });
  box.append(plot);
  const tip = tooltip(plot);
  const shown = points.filter((p) => p.value > 0 && p.lat != null && p.lng != null);
  return onWidth(plot, (width, boxHeight) => {
    const height = fill ? Math.max(320, boxHeight) : fixedHeight;
    const lat0 = centre?.lat ?? (shown.length ? shown.reduce((s, p) => s + p.lat, 0) / shown.length : 0);
    const cos = Math.cos((lat0 * Math.PI) / 180);
    const X = (lng) => lng * cos;
    const Y = (lat) => -lat;
    const reach = centre && rings.length ? Math.max(...rings) / KM_PER_DEGREE : 0;
    const xs = [...shown.map((p) => X(p.lng)), ...(centre ? [X(centre.lng) - reach, X(centre.lng) + reach] : [])];
    const ys = [...shown.map((p) => Y(p.lat)), ...(centre ? [Y(centre.lat) - reach, Y(centre.lat) + reach] : [])];
    const pad = 34;
    const spanX = Math.max(1e-3, Math.max(...xs) - Math.min(...xs));
    const spanY = Math.max(1e-3, Math.max(...ys) - Math.min(...ys));
    const scale = Math.min((width - 2 * pad) / spanX, (height - 2 * pad) / spanY);
    const ox = (width - spanX * scale) / 2 - Math.min(...xs) * scale;
    const oy = (height - spanY * scale) / 2 - Math.min(...ys) * scale;
    const px = (p) => [X(p.lng) * scale + ox, Y(p.lat) * scale + oy];
    const root = svg("svg", { width, height, viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": title, class: "viz-svg viz-map" });
    if (centre) {
      const [cx, cy] = px(centre);
      for (const km of rings) {
        const r = (km / KM_PER_DEGREE) * scale;
        root.append(svg("circle", { cx, cy, r, class: "viz-ring" }));
        root.append(label(cx, cy - r - 4, `${km} km`, { class: "viz-tick", "text-anchor": "middle" }));
      }
      root.append(svg("circle", { cx, cy, r: 2.5, class: "viz-centre" }));
    }
    root.append(label(width - 10, 16, "N ↑", { class: "viz-tick", "text-anchor": "end" }));
    const max = Math.max(1, ...shown.map((p) => p.value));
    // Fewer, bigger bubbles for a handful of towns; smaller ones when a city has dozens of suburbs.
    const crowd = Math.sqrt(12 / Math.max(12, shown.length));
    const maxR = Math.max(9, Math.min(30, Math.min(width, height) / 11) * crowd);
    const radius = (v) => 3 + Math.sqrt(v / max) * (maxR - 3);
    const placed = [];
    const byValue = [...shown].sort((a, b) => b.value - a.value);
    const labelled = new Set(byValue.slice(0, labels).map((p) => p.id));
    const nodes = byValue.map((p, rank) => {
      const [x, y] = px(p);
      const r = radius(p.value);
      const g = svg("g", { class: `viz-bubble${selected != null && p.id === selected ? " picked" : ""}${selected != null && p.id !== selected ? " dim" : ""}` });
      g.append(svg("circle", { cx: x, cy: y, r, class: "viz-bubble-dot" }));
      const hit = svg("circle", { cx: x, cy: y, r: Math.max(12, r + 3), fill: "transparent", class: onSelect ? "pick" : "" });
      if (onSelect && rank < 15) {
        hit.setAttribute("tabindex", "0");
        hit.setAttribute("role", "button");
        hit.setAttribute("aria-label", `${p.name}: ${formatValue(format, p.value)}`);
      }
      const show = () => tip.show(x, y - r, p.name, [{ value: formatValue(format, p.value), name: p.unit ?? "" }, ...(p.lines ?? []).map((t) => ({ value: t, name: "" }))]);
      hit.addEventListener("pointerenter", show);
      hit.addEventListener("focus", show);
      hit.addEventListener("pointerleave", () => tip.hide());
      hit.addEventListener("blur", () => tip.hide());
      if (onSelect) {
        hit.addEventListener("click", () => onSelect(p.id === selected ? null : p.id, p));
        hit.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSelect(p.id === selected ? null : p.id, p);
          }
        });
      }
      g.append(hit);
      return { g, x, y, r, p };
    });
    // Largest drawn first, so the small ones stay on top and reachable.
    for (const n of nodes) root.append(n.g);
    // Names beside the biggest bubbles, skipping any that would overlap.
    for (const n of nodes) {
      if (!labelled.has(n.p.id)) continue;
      const w = n.p.name.length * 6.6 + 4;
      const box_ = { x: n.x + n.r + 4, y: n.y - 8, w, h: 14 };
      if (box_.x + w > width) box_.x = n.x - n.r - 4 - w;
      if (placed.some((b) => box_.x < b.x + b.w && b.x < box_.x + box_.w && box_.y < b.y + b.h && b.y < box_.y + box_.h)) continue;
      placed.push(box_);
      root.append(label(box_.x, n.y + 4, n.p.name, { class: "viz-map-label" }));
    }
    plot.replaceChildren(root, tip.el);
  }, { height: fill });
}

// ---------- Meters ----------

/**
 * A value against its scale, with a target mark. The status (on target or not) shows as an icon and
 * words as well as colour.
 */
export function meter({ label: name, value, target, max = 1, format = "share", foot, better = "up", targetLabel }) {
  const share = value == null ? 0 : Math.max(0, Math.min(1, value / max));
  const met = value == null || target == null ? null : better === "up" ? value >= target : value <= target;
  const tone = met == null ? "" : met ? "good" : "warn";
  return h(
    "div",
    { class: `viz-meter ${tone}` },
    h(
      "div",
      { class: "viz-meter-head" },
      h("span", { text: name }),
      h("strong", { text: value == null ? "No data yet" : formatValue(format, value) }),
    ),
    h(
      "div",
      { class: "viz-meter-track" },
      h("span", { class: "viz-meter-fill", style: `width:${share * 100}%` }),
      target != null ? h("span", { class: "viz-meter-target", style: `left:${Math.min(100, (target / max) * 100)}%`, title: `Target ${formatValue(format, target)}` }) : null,
    ),
    h(
      "div",
      { class: "viz-meter-foot" },
      met == null ? null : h("span", { class: `badge ${met ? "good" : "warn"}`, text: met ? "On target" : "Below target" }),
      target != null ? h("span", { class: "muted", text: targetLabel ?? `Target ${formatValue(format, target)}` }) : null,
      foot ? h("span", { class: "muted", text: foot }) : null,
    ),
  );
}

// ---------- Tables, CSV and the chart card ----------

/** columns: [{ label, num? }]; rows: arrays of cells (text, numbers or nodes). */
export function dataTable({ columns, rows }) {
  return h(
    "div",
    { class: "viz-table-wrap" },
    h(
      "table",
      { class: "viz-table" },
      h("thead", {}, h("tr", {}, columns.map((c) => h("th", { class: c.num ? "num" : "", scope: "col", text: c.label })))),
      h(
        "tbody",
        {},
        rows.map((r) => h("tr", {}, r.map((cell, i) => h("td", { class: columns[i]?.num ? "num" : "" }, cell instanceof Node ? cell : cell == null ? "–" : String(cell))))),
      ),
    ),
  );
}

/** CSV for a table. Text that a spreadsheet would read as a formula gets a leading apostrophe. */
export function toCsv({ columns, rows }) {
  const cell = (v) => {
    if (v == null) return "";
    let s = v instanceof Node ? v.textContent ?? "" : String(v);
    if (typeof v !== "number" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.map((c) => cell(c.label)), ...rows.map((r) => r.map(cell))].map((r) => r.join(",")).join("\r\n");
}

export function downloadCsv(name, table) {
  saveFile(new Blob(["﻿", toCsv(table)], { type: "text/csv;charset=utf-8" }), `${name}.csv`);
}

const DOWNLOAD = '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5M12 15V3"/>';
function downloadIcon() {
  const tpl = document.createElement("template");
  tpl.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${DOWNLOAD}</svg>`;
  return tpl.content.firstChild;
}

/**
 * A card holding one chart, with its title, a Chart/Table switch (the table is the chart's accessible
 * twin) and a CSV download. draw(box) draws the chart and may return a clean-up function or a node.
 * Returns { el, cleanup, redraw(draw) }: redraw swaps in another chart (say, another measure).
 */
export function vizCard({ title, subtitle, span = 6, draw, table, csv, empty, actions = [], foot, definition, className = "" }) {
  const body = h("div", { class: "viz-body" });
  const tableBox = h("div", { class: "viz-body", hidden: true });
  let cleanup = () => {};
  let mode = "chart";
  const toggle = table && !empty
    ? h(
        "div",
        { class: "segmented viz-mode", role: "group", "aria-label": `Show ${title} as` },
        ["Chart", "Table"].map((name) =>
          h(
            "button",
            {
              type: "button",
              "aria-pressed": String(name === "Chart"),
              onclick: (e) => {
                mode = name === "Table" ? "table" : "chart";
                e.currentTarget.parentElement.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b === e.currentTarget)));
                if (mode === "table" && !tableBox.childElementCount) tableBox.append(dataTable(table()));
                body.hidden = mode === "table";
                tableBox.hidden = mode !== "table";
              },
            },
            name,
          ),
        ),
      )
    : null;
  const download = table && csv && !empty
    ? h("button", { type: "button", class: "btn btn-ghost btn-icon btn-sm viz-csv", "aria-label": `Download ${title} as CSV`, title: "Download as CSV", onclick: () => downloadCsv(csv, table()) }, downloadIcon())
    : null;
  const el = h(
    "section",
    { class: `card viz-card span-${span} ${className}`.trim() },
    h(
      "header",
      { class: "viz-card-head" },
      h("div", {}, h("h2", {}, title, definition ? info(definition) : null), subtitle ? h("p", { text: subtitle }) : null),
      h("div", { class: "viz-actions" }, actions, toggle, download),
    ),
    body,
    tableBox,
    foot ? h("footer", { class: "viz-card-foot" }, foot) : null,
  );
  const paint = (fn) => {
    const result = fn?.(body);
    if (typeof result === "function") cleanup = result;
    else if (result instanceof Node) body.append(result);
  };
  if (empty) body.append(h("div", { class: "viz-empty" }, h("strong", { text: empty.title }), h("span", { text: empty.text })));
  else paint(draw);
  return {
    el,
    cleanup: () => cleanup(),
    redraw(fn) {
      cleanup();
      cleanup = () => {};
      body.replaceChildren();
      tableBox.replaceChildren();
      if (mode === "table") tableBox.append(dataTable(table()));
      paint(fn);
    },
  };
}

/** The row of filters above a dashboard: the period first, then the rest, and when it was last updated. */
export function filterBar({ days, onPeriod, controls = [], chips = [], updatedAt, onRefresh, actions = [], note }) {
  return h(
    "div",
    { class: "viz-filters" },
    h(
      "div",
      { class: "viz-filters-main" },
      h(
        "div",
        { class: "segmented", role: "group", "aria-label": "Period" },
        PERIODS.map(([d, name]) => h("button", { type: "button", "aria-pressed": String(d === days), onclick: () => d !== days && onPeriod(d) }, name)),
      ),
      controls,
      chips.map((c) => h("span", { class: "chip viz-chip" }, h("span", { text: c.label }), h("button", { type: "button", "aria-label": `Remove ${c.label}`, onclick: c.onRemove }, "×"))),
      note ? h("span", { class: "viz-updated", text: note }) : null,
    ),
    h(
      "div",
      { class: "viz-filters-side" },
      updatedAt ? h("span", { class: "viz-updated", text: `Updated ${updatedAt.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}` }) : null,
      onRefresh ? h("button", { type: "button", class: "btn btn-ghost btn-sm", onclick: onRefresh }, "Refresh") : null,
      actions,
    ),
  );
}
