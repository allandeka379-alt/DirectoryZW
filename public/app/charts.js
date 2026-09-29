// Bar charts for the dashboard: one series, one hue, recessive grid, a tooltip on hover or tap.

const NS = "http://www.w3.org/2000/svg";

function el(name, attrs = {}) {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

/** A round step for three or four gridlines, and the top of the scale. Counts get whole-number steps. */
function niceScale(max, integer = true) {
  if (max <= 0) return { top: 4, step: 2 };
  const rough = max / 3;
  const mag = 10 ** Math.floor(Math.log10(rough));
  const step = Math.max(integer ? 1 : 0, [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= rough && (!integer || Number.isInteger(s))) ?? 10 * mag);
  return { top: Math.ceil(max / step) * step, step };
}

/**
 * Draw bars into `container`.
 * points: [{ label: "1 Oct", value: 3, tip?: "3 searches" }]
 * opts: { height, title (for screen readers), labelEvery, anchor, integer (default true: whole-number gridlines) }. Labels count back from the
 * last point ("end", for days up to today) or forward from the first ("start", for hours).
 */
export function barChart(container, points, opts = {}) {
  container.classList.add("chart");
  const draw = () => {
    container.replaceChildren();
    const width = Math.max(container.clientWidth, 240);
    const height = opts.height ?? 200;
    const m = { top: 10, right: 4, bottom: 24, left: 34 };
    const w = width - m.left - m.right;
    const h = height - m.top - m.bottom;
    const max = Math.max(0, ...points.map((p) => p.value));
    const { top, step } = niceScale(max, opts.integer !== false);
    const y = (v) => m.top + h - (v / top) * h;
    const slot = w / Math.max(points.length, 1);
    const barW = Math.max(2, Math.min(28, slot * 0.64));

    const svg = el("svg", { width, height, viewBox: `0 0 ${width} ${height}`, role: "img" });
    const total = points.reduce((s, p) => s + p.value, 0);
    const best = points.reduce((a, p) => (p.value > (a?.value ?? -1) ? p : a), null);
    svg.setAttribute("aria-label", `${opts.title ?? "Chart"}: ${total} in total${best && best.value ? `, most on ${best.label} (${best.value})` : ""}.`);

    for (let v = 0; v <= top + 1e-9; v += step) {
      const gy = y(v);
      svg.append(el("line", { x1: m.left, x2: width - m.right, y1: gy, y2: gy, stroke: "var(--border)", "stroke-width": 1, "stroke-dasharray": v === 0 ? "" : "2 3" }));
      const t = el("text", { x: m.left - 8, y: gy + 4, "text-anchor": "end", "font-size": 11, fill: "var(--text-3)" });
      t.textContent = Number.isInteger(v) ? String(v) : v.toFixed(1);
      svg.append(t);
    }

    const every = opts.labelEvery ?? Math.max(1, Math.ceil(points.length / Math.floor(w / 56)));
    points.forEach((p, i) => {
      const cx = m.left + slot * i + slot / 2;
      if (p.value > 0) {
        const top_ = y(p.value);
        const bh = m.top + h - top_;
        const r = Math.min(4, barW / 2, bh);
        const x0 = cx - barW / 2;
        // Rounded at the data end, square on the baseline.
        const d = `M${x0},${m.top + h} V${top_ + r} Q${x0},${top_} ${x0 + r},${top_} H${x0 + barW - r} Q${x0 + barW},${top_} ${x0 + barW},${top_ + r} V${m.top + h} Z`;
        svg.append(el("path", { d, fill: "var(--chart)", "data-i": i, class: "bar" }));
      }
      const step = opts.anchor === "start" ? i : points.length - 1 - i;
      if (step % every === 0) {
        const t = el("text", { x: cx, y: height - 6, "text-anchor": "middle", "font-size": 11, fill: "var(--text-3)" });
        t.textContent = p.label;
        svg.append(t);
      }
    });

    // Hit targets wider than the bars, and a tooltip.
    const tip = document.createElement("div");
    tip.className = "chart-tip";
    tip.hidden = true;
    const show = (i) => {
      const p = points[i];
      svg.querySelectorAll(".bar").forEach((b) => b.setAttribute("opacity", Number(b.dataset.i) === i ? "1" : "0.45"));
      tip.replaceChildren(Object.assign(document.createElement("strong"), { textContent: p.tip ?? String(p.value) }), document.createTextNode(p.long ?? p.label));
      tip.style.left = `${m.left + slot * i + slot / 2}px`;
      tip.style.top = `${p.value > 0 ? y(p.value) : m.top + h}px`;
      tip.hidden = false;
    };
    const hide = () => {
      tip.hidden = true;
      svg.querySelectorAll(".bar").forEach((b) => b.setAttribute("opacity", "1"));
    };
    points.forEach((_, i) => {
      const hit = el("rect", { x: m.left + slot * i, y: m.top, width: slot, height: h, fill: "transparent" });
      hit.addEventListener("mouseenter", () => show(i));
      hit.addEventListener("click", () => show(i));
      svg.append(hit);
    });
    svg.addEventListener("mouseleave", hide);
    container.append(svg, tip);
  };
  draw();
  let last = container.clientWidth;
  const ro = new ResizeObserver(() => {
    if (Math.abs(container.clientWidth - last) < 8) return;
    last = container.clientWidth;
    draw();
  });
  ro.observe(container);
  return () => ro.disconnect();
}
