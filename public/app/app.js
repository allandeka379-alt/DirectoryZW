// The business web app: sign in with a WhatsApp link, then manage a listing, its products and prices,
// and see what customers ask for. Plain modules, no build step. User data is always set as text.

import {
  ago,
  ApiError,
  busy,
  closeAllSheets,
  confirmDialog,
  h,
  icon,
  longDate,
  money,
  num,
  openSheet,
  pct,
  pickFile,
  present,
  readPrice,
  shortDate,
  shrinkPhoto,
  store,
  themeSwitch,
  toast,
} from "/assets/ui.js";
import { barChart } from "./charts.js";
import { matchPhotos } from "./photos.js";
import { FIELDS, guessMapping, hasHeadings, parseSheet, toImportRows } from "./sheets.js";

const root = document.getElementById("root");

// ---------- The API ----------

async function api(method, path, body) {
  let res;
  try {
    res = await fetch(`/app/api${path}`, {
      method,
      credentials: "same-origin",
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError("We couldn't reach the server. Check your connection and try again.", 0);
  }
  const data = (res.headers.get("content-type") ?? "").includes("json") ? await res.json() : null;
  if (res.status === 401 && !path.startsWith("/auth/")) {
    showSignIn();
    throw new ApiError("Please sign in", 401);
  }
  if (!res.ok) throw new ApiError(data?.error ?? `Something went wrong (${res.status}).`, res.status);
  return data;
}

// ---------- State ----------

const S = {
  me: null,
  options: null,
  publicOptions: null,
  businessId: null,
  period: 30,
  ticket: 0,
  cleanup: [],
};

const business = () => S.me?.businesses.find((b) => b.id === S.businessId);
const bid = () => S.businessId;

const photoUrl = (id) => `/app/api/photos/${id}`;

// ---------- Signing in ----------

async function publicOptions() {
  if (!S.publicOptions) {
    S.publicOptions = await fetch("/app/api/public/options")
      .then((r) => r.json())
      .catch(() => ({ brand: "", whatsappNumber: "" }));
  }
  return S.publicOptions;
}

function brandmark(brand) {
  return h("a", { class: "brandmark", href: "/" }, h("img", { src: "/assets/logo.svg", alt: "" }), brand);
}

async function showSignIn(message, kind = "bad") {
  S.me = null;
  closeAllSheets();
  for (const fn of S.cleanup.splice(0)) fn();
  const opts = await publicOptions();
  document.title = `Sign in · ${opts.brand}`;
  const wa = `https://wa.me/${opts.whatsappNumber}?text=${encodeURIComponent("dashboard")}`;
  const status = h("p", { class: `notice${kind === "bad" ? " bad" : ""}`, hidden: !message, role: "status" }, message ?? "");
  if (opts.whatsapp === false) {
    // Before launch: links can't come on WhatsApp yet, so the team hands them out.
    root.replaceChildren(
      h(
        "div",
        { class: "auth" },
        h(
          "div",
          { class: "card auth-card" },
          brandmark(opts.brand),
          h("h1", { text: "Sign in to your dashboard" }),
          status,
          h("p", {
            class: "muted",
            text: "We open on WhatsApp soon. Until then, our team sends you a one-time sign-in link: ask the person who registered your business.",
          }),
        ),
        h("p", { class: "muted", style: "font-size:14px" }, "Not listed yet? ", h("a", { href: "/register" }, "Register your business")),
      ),
    );
    return;
  }
  const phone = h("input", { class: "input", id: "phone", inputmode: "tel", autocomplete: "tel-national", placeholder: "77 123 4567" });
  const send = h("button", { class: "btn btn-secondary", type: "submit" }, "Send me the link");
  const form = h(
    "form",
    {
      class: "grid",
      style: "gap:10px",
      onsubmit: async (e) => {
        e.preventDefault();
        const digits = phone.value.replace(/\D/g, "");
        if (digits.length < 9) {
          status.className = "notice bad";
          status.textContent = "Enter the WhatsApp number you registered with.";
          status.hidden = false;
          return;
        }
        const full = digits.startsWith("263") ? digits : digits.startsWith("0") ? `263${digits.slice(1)}` : `263${digits}`;
        await busy(send, async () => {
          await api("POST", "/auth/request", { phone: full });
          status.className = "notice";
          status.textContent =
            "If this number messaged us in the last day, your link is on its way to WhatsApp. If it doesn't arrive, tap the green button above: it sends us the word dashboard, and we reply with your link.";
          status.hidden = false;
        });
      },
    },
    h("label", { class: "label", for: "phone" }, "The WhatsApp number you registered with"),
    h("div", { class: "input-group" }, h("span", { class: "addon" }, "+263"), phone),
    send,
  );
  root.replaceChildren(
    h(
      "div",
      { class: "auth" },
      h(
        "div",
        { class: "card auth-card" },
        brandmark(opts.brand),
        h("h1", { text: "Sign in to your dashboard" }),
        h("p", { class: "muted", text: "We send you a one-time link on WhatsApp. There's no password to remember." }),
        status,
        h("a", { class: "btn btn-brand btn-lg", href: wa, rel: "noopener" }, icon("whatsapp"), "Get my link on WhatsApp"),
        h("p", { class: "hint", text: "Send it from the WhatsApp you registered with. The link works once, for 15 minutes." }),
        h("div", { class: "divider", text: "or" }),
        form,
      ),
      h("p", { class: "muted", style: "font-size:14px" }, "Not listed yet? ", h("a", { href: "/register" }, "Register your business")),
    ),
  );
}

function showSigningIn() {
  root.replaceChildren(
    h("div", { class: "auth" }, h("div", { class: "card auth-card", style: "justify-items:center;text-align:center" }, h("div", { class: "spinner" }), h("p", { class: "muted", text: "Signing you in…" }))),
  );
}

async function showNoBusiness() {
  const opts = await publicOptions();
  root.replaceChildren(
    h(
      "div",
      { class: "auth" },
      h(
        "div",
        { class: "card auth-card" },
        brandmark(opts.brand),
        h("h1", { text: "No listing on this number yet" }),
        h("p", { class: "muted", text: "Register your business and it will appear here, ready for your products and prices." }),
        h("a", { class: "btn btn-lg", href: "/register" }, "Register your business"),
        h("button", { class: "btn btn-ghost", type: "button", onclick: signOut }, "Sign out"),
      ),
    ),
  );
}

async function signOut() {
  await api("POST", "/auth/logout").catch(() => {});
  S.me = null;
  showSignIn("You're signed out.", "good");
}

// ---------- The shell ----------

const NAV = [
  ["overview", "Overview", "Overview"],
  ["products", "Products", "Products"],
  ["customers", "Customers", "Customers"],
  ["insights", "Insights", "Insights"],
  ["profile", "Business profile", "Profile"],
];

function route() {
  const [path, query] = location.hash.replace(/^#\/?/, "").split("?");
  return { name: NAV.some(([k]) => k === path) ? path : "overview", params: new URLSearchParams(query ?? "") };
}

function businessPicker(className) {
  if (S.me.businesses.length < 2) return h("strong", { class: className, text: business()?.name ?? "" });
  return h(
    "select",
    {
      class: className,
      "aria-label": "Business",
      value: S.businessId,
      onchange: (e) => {
        S.businessId = e.target.value;
        store.set("dz.business", S.businessId);
        Object.assign(P, { q: "", stock: "", needs: "", category: "", health: null });
        renderShell();
      },
    },
    S.me.businesses.map((b) => h("option", { value: b.id }, b.name)),
  );
}

function verificationBadge(b) {
  return b.verification === "verified" ? h("span", { class: "badge good" }, "Verified") : h("span", { class: "badge warn" }, "Not verified yet");
}

function renderShell() {
  const b = business();
  const r = route();
  const nav = (cls, short) =>
    h(
      "nav",
      { class: cls, "aria-label": "Dashboard" },
      NAV.map(([key, label, shortLabel]) => h("a", { href: `#/${key}`, "aria-current": r.name === key ? "page" : false }, icon(key), short ? shortLabel : label)),
    );
  const teamPause = b.status === "paused" && b.paused_by && b.paused_by !== "owner";
  const live = h("input", {
    type: "checkbox",
    checked: b.status === "active",
    disabled: Boolean(teamPause),
    "aria-label": "Listing live",
    onchange: async (e) => {
      const want = e.target.checked;
      const ok = await busy(null, () => api("POST", `/businesses/${b.id}/status`, { live: want }));
      if (!ok) e.target.checked = !want;
      else {
        b.status = ok.status;
        liveText.textContent = want ? "Live: customers can find you" : "Paused: hidden from customers";
        toast(want ? "Your listing is live." : "Your listing is paused.");
      }
    },
  });
  const liveText = h("span", {
    class: "muted",
    text: b.status === "active" ? "Live: customers can find you" : teamPause ? "Paused by our team: contact us to put it back" : "Paused: hidden from customers",
  });
  root.replaceChildren(
    h(
      "div",
      { class: "shell" },
      h(
        "aside",
        { class: "sidebar" },
        brandmark(S.options.brand),
        h("div", { class: "switcher" }, h("small", { text: "Business" }), businessPicker("")),
        nav("nav"),
        h(
          "div",
          { class: "sidebar-foot" },
          h(
            "div",
            { class: "status-card" },
            h("div", { class: "status-row" }, h("strong", { text: "Listing" }), h("label", { class: "switch" }, live, h("span"))),
            liveText,
            h("div", {}, verificationBadge(b)),
          ),
          themeSwitch(true),
          h("button", { class: "btn btn-ghost btn-sm", type: "button", style: "justify-content:flex-start", onclick: signOut }, icon("out"), "Sign out"),
        ),
      ),
      h(
        "div",
        { class: "main" },
        h(
          "header",
          { class: "topbar" },
          h("a", { class: "brandmark", href: "#/overview", "aria-label": "Overview" }, h("img", { src: "/assets/logo.svg", alt: "" })),
          businessPicker("topbar-business"),
          h("span", { class: "spacer" }),
          themeSwitch(false),
          h("button", { class: "btn btn-ghost btn-icon btn-sm", type: "button", "aria-label": "Sign out", onclick: signOut }, icon("out")),
        ),
        h("main", { class: "view", id: "view" }),
      ),
      nav("tabbar", true),
    ),
  );
  document.title = `${b.name} · Dashboard`;
  renderRoute();
}

function renderRoute() {
  for (const fn of S.cleanup.splice(0)) fn();
  const view = document.getElementById("view");
  if (!view) return;
  const r = route();
  document.querySelectorAll(".nav a, .tabbar a").forEach((a) => a.setAttribute("aria-current", a.getAttribute("href") === `#/${r.name}` ? "page" : "false"));
  const ticket = ++S.ticket;
  const pages = { overview: renderOverview, products: renderProducts, customers: renderCustomers, insights: renderInsights, profile: renderProfile };
  view.replaceChildren();
  window.scrollTo(0, 0);
  pages[r.name](view, r.params, ticket);
}

const stale = (ticket) => ticket !== S.ticket;

function pageHead(title, subtitle, ...actions) {
  return h("div", { class: "page-head" }, h("div", {}, h("h1", { text: title }), subtitle ? h("p", { text: subtitle }) : null), h("div", { class: "actions" }, actions));
}

function periodControl(onChange) {
  const box = h("div", { class: "segmented", role: "group", "aria-label": "Period" });
  for (const d of [7, 30, 90]) {
    box.append(
      h(
        "button",
        {
          type: "button",
          "aria-pressed": String(S.period === d),
          onclick: () => {
            S.period = d;
            onChange();
          },
        },
        `${d} days`,
      ),
    );
  }
  return box;
}

function skeletonCards(n = 4) {
  return h("div", { class: "grid grid-4" }, Array.from({ length: n }, () => h("div", { class: "skeleton", style: "height:104px" })));
}

function emptyState(iconName, title, text, ...actions) {
  return h(
    "div",
    { class: "empty" },
    h("div", { class: "empty-icon" }, icon(iconName)),
    h("h3", { text: title }),
    h("p", { text }),
    actions.length ? h("div", { class: "actions" }, actions) : null,
  );
}

function delta(now, before, days) {
  if (!before) return h("span", { text: `Last ${days} days` });
  const change = (now - before) / before;
  const cls = change > 0.005 ? "up" : change < -0.005 ? "down" : "";
  return h("span", {}, h("span", { class: `delta ${cls}`, text: `${change > 0 ? "+" : ""}${Math.round(change * 100)}%` }), ` vs the ${days} days before`);
}

function kpi(label, value, foot) {
  return h("div", { class: "card kpi" }, h("span", { class: "kpi-label", text: label }), h("span", { class: "kpi-value", text: value }), h("span", { class: "kpi-foot" }, foot));
}

function barList(items, { amountOf = (x) => x.n, labelOf = (x) => x.what, extra } = {}) {
  const max = Math.max(1, ...items.map(amountOf));
  return h(
    "ul",
    { class: "bars" },
    items.map((it) =>
      h(
        "li",
        {},
        h("div", { class: "bar-label" }, h("span", { text: labelOf(it) }), extra?.(it)),
        h("span", { class: "bar-value", text: num(amountOf(it)) }),
        h("div", { class: "bar-track" }, h("div", { class: "bar-fill", style: `width:${Math.max(2, (amountOf(it) / max) * 100)}%` })),
      ),
    ),
  );
}

// ---------- Overview ----------

const stopCharts = () => {
  for (const fn of S.cleanup.splice(0)) fn();
};

async function renderOverview(view, _params, ticket) {
  stopCharts();
  const b = business();
  const redo = () => renderOverview(view, _params, ++S.ticket);
  view.replaceChildren(pageHead("Overview", `${b.name}${b.area ? ` · ${b.area}` : ""}`, periodControl(redo)), skeletonCards());
  let a;
  try {
    a = await api("GET", `/businesses/${bid()}/analytics?days=${S.period}`);
  } catch (err) {
    if (!stale(ticket)) view.append(h("p", { class: "notice bad", text: err.message }));
    return;
  }
  if (stale(ticket)) return;
  const k = a.kpis;
  const answered = k.outcomes.sorted + k.outcomes.couldntHelp + k.outcomes.noReply;
  const nodes = [pageHead("Overview", `${b.name}${b.area ? ` · ${b.area}` : ""}`, periodControl(redo))];

  if (a.catalogue.total === 0) {
    nodes.push(
      h(
        "div",
        { class: "callout" },
        h("div", {}, h("h2", { text: "Add your products and prices" }), h("p", { text: "Customers who ask for something you sell see your price in our reply. Start with your best sellers, or upload your whole list." })),
        h(
          "div",
          { class: "actions" },
          h("button", { class: "btn btn-secondary", type: "button", onclick: () => openUpload() }, icon("upload"), "Upload a list"),
          h("button", { class: "btn", type: "button", onclick: () => openProduct() }, icon("plus"), "Add a product"),
        ),
      ),
    );
  } else if (a.catalogue.stale + a.catalogue.noPrice > 0) {
    nodes.push(
      h(
        "div",
        { class: "callout" },
        h(
          "div",
          {},
          h("h2", { text: `${num(a.catalogue.stale + a.catalogue.noPrice)} prices need a look` }),
          h("p", { text: `Customers trust prices updated in the last ${S.me.stalePriceDays} days. Confirm them, or change the ones that moved.` }),
        ),
        h("div", { class: "actions" }, h("a", { class: "btn btn-secondary", href: "#/products?needs=price" }, "Review prices")),
      ),
    );
  }

  nodes.push(
    h(
      "div",
      { class: "grid grid-4" },
      kpi("Shown in searches", num(k.shown), delta(k.shown, k.shownPrev, a.days)),
      kpi("Customers sent to you", num(k.connections), delta(k.connections, k.connectionsPrev, a.days)),
      kpi("Connection rate", pct(k.connectionRate), h("span", { text: "Of the searches you came up in" })),
      k.rating
        ? kpi("Rating", `${k.rating.average.toFixed(1)} ★`, h("span", { text: `From ${num(k.rating.count)} customer${k.rating.count === 1 ? "" : "s"}` }))
        : kpi("Said “Yes, sorted”", answered ? pct(k.outcomes.sorted / answered) : "–", h("span", { text: answered ? `${num(k.outcomes.sorted)} of ${num(answered)} follow-up answers` : "No follow-up answers yet" })),
    ),
  );

  // Day by day, one measure at a time (never two scales on one chart).
  let metric = "shown";
  const chartBox = h("div", { style: "min-height:200px" });
  let stopChart = () => {};
  S.cleanup.push(() => stopChart());
  const drawChart = () => {
    stopChart();
    const pts = a.daily.map((d) => ({
      label: shortDate(d.date),
      long: longDate(d.date),
      value: d[metric],
      tip: metric === "shown" ? `${num(d.shown)} search${d.shown === 1 ? "" : "es"}` : `${num(d.connections)} customer${d.connections === 1 ? "" : "s"}`,
    }));
    stopChart = barChart(chartBox, pts, { title: metric === "shown" ? "Searches you came up in, per day" : "Customers sent to you, per day" });
  };
  const toggle = h("div", { class: "segmented", role: "group", "aria-label": "Measure" });
  for (const [key, label] of [
    ["shown", "Searches"],
    ["connections", "Customers"],
  ]) {
    toggle.append(
      h(
        "button",
        {
          type: "button",
          "aria-pressed": String(metric === key),
          onclick: (e) => {
            metric = key;
            toggle.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === e.currentTarget)));
            drawChart();
          },
        },
        label,
      ),
    );
  }
  nodes.push(
    h(
      "div",
      { class: "card panel section-gap" },
      h("div", { class: "panel-head" }, h("div", {}, h("h2", { text: "Day by day" }), h("p", { text: "Tap or hover over a day for its number." })), toggle),
      chartBox,
    ),
  );

  const c = a.catalogue;
  nodes.push(
    h(
      "div",
      { class: "grid grid-2 section-gap" },
      h(
        "div",
        { class: "card panel" },
        h("div", { class: "panel-head" }, h("div", {}, h("h2", { text: "What customers asked for" }), h("p", { text: "When your business came up in their search" }))),
        a.topAsks.length ? barList(a.topAsks) : emptyState("search", "No searches yet", "When customers ask for what you sell, you'll see what they asked for here."),
      ),
      h(
        "div",
        { class: "card panel" },
        h("div", { class: "panel-head" }, h("div", {}, h("h2", { text: "Your catalogue" }), h("p", { text: "Products customers can see in our replies" })), h("a", { class: "btn btn-secondary btn-sm", href: "#/products" }, "Open")),
        h(
          "ul",
          { class: "rows" },
          h("li", {}, h("a", { href: "#/products" }, h("span", { text: "Products listed" }), h("strong", { text: num(c.total) }))),
          h("li", {}, h("a", { href: "#/products?needs=price" }, h("span", { text: "Without a price, or one to confirm" }), h("strong", { text: num(c.noPrice + c.stale) }))),
          h("li", {}, h("a", { href: "#/products?stock=out" }, h("span", { text: "Out of stock" }), h("strong", { text: num(c.outOfStock) }))),
          h("li", {}, h("a", { href: "#/products?needs=photo" }, h("span", { text: "Without a photo" }), h("strong", { text: num(c.noPhoto) }))),
        ),
      ),
    ),
  );
  view.replaceChildren(...nodes);
  drawChart();
}

// ---------- Products ----------

const P = { q: "", stock: "", needs: "", category: "", sort: "name", items: [], total: 0, health: null, selected: new Set(), limit: 50 };

function productQuery(offset = 0) {
  const q = new URLSearchParams({ sort: P.sort, limit: String(P.limit), offset: String(offset) });
  if (P.q) q.set("q", P.q);
  if (P.stock) q.set("stock", P.stock);
  if (P.needs) q.set("needs", P.needs);
  if (P.category) q.set("category", P.category);
  return q.toString();
}

async function renderProducts(view, params, ticket) {
  if (params.has("needs") || params.has("stock")) {
    P.needs = params.get("needs") ?? "";
    P.stock = params.get("stock") ?? "";
  }
  P.selected.clear();
  const head = pageHead(
    "Products",
    null,
    h("button", { class: "btn btn-secondary", type: "button", onclick: () => openAdjust() }, icon("tag"), "Change prices"),
    h("button", { class: "btn btn-secondary", type: "button", onclick: () => openPhotos() }, icon("image"), "Add photos"),
    h("button", { class: "btn btn-secondary", type: "button", onclick: () => openUpload() }, icon("upload"), "Upload a list"),
    h("button", { class: "btn", type: "button", onclick: () => openProduct() }, icon("plus"), "Add product"),
  );
  // The search box stays put while the rest of the toolbar redraws, so typing never loses focus.
  let searchTimer;
  const searchBox = h(
    "div",
    { class: "search" },
    icon("search"),
    h("input", {
      class: "input",
      type: "search",
      placeholder: "Search by name, code or category",
      "aria-label": "Search products",
      value: P.q,
      oninput: (e) => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => {
          P.q = e.target.value.trim();
          load();
        }, 250);
      },
    }),
  );
  const toolbar = h("div", { class: "toolbar" }, searchBox);
  const list = h("div", { class: "card table-card" }, h("div", { class: "skeleton", style: "height:280px;border-radius:0" }));
  const selectionBar = h("div", { class: "selection", hidden: true, role: "toolbar", "aria-label": "Selected products" });
  const photoNote = h("div");
  view.replaceChildren(head, photoNote, toolbar, list, selectionBar);

  let loads = 0;
  const load = async (append = false) => {
    const mine = ++loads;
    let data;
    try {
      data = await api("GET", `/businesses/${bid()}/products?${productQuery(append ? P.items.length : 0)}`);
    } catch (err) {
      if (!stale(ticket) && mine === loads) list.replaceChildren(h("p", { class: "notice bad", style: "margin:16px", text: err.message }));
      return;
    }
    if (stale(ticket) || mine !== loads) return; // a newer search has been sent
    P.items = append ? [...P.items, ...data.items] : data.items;
    P.total = data.total;
    P.health = data.health;
    head.querySelector("p")?.remove();
    head.firstChild.append(h("p", { text: `${num(data.health.total)} product${data.health.total === 1 ? "" : "s"} listed` }));
    drawToolbar();
    drawList();
  };

  const drawToolbar = () => {
    const hl = P.health;
    const chip = (label, count, active, set) =>
      h(
        "button",
        {
          class: "chip",
          type: "button",
          "aria-pressed": String(active),
          onclick: () => {
            set();
            load();
          },
        },
        label,
        count == null ? null : h("span", { class: "count", text: num(count) }),
      );
    while (searchBox.nextSibling) searchBox.nextSibling.remove();
    const controls = [
      h(
        "div",
        { class: "chips" },
        chip("All", hl.total, !P.stock && !P.needs, () => {
          P.stock = "";
          P.needs = "";
        }),
        chip("Out of stock", hl.outOfStock, P.stock === "out", () => {
          P.stock = "out";
          P.needs = "";
        }),
        chip("Prices to check", hl.noPrice + hl.stale, P.needs === "price", () => {
          P.needs = "price";
          P.stock = "";
        }),
        chip("No photo", hl.noPhoto, P.needs === "photo", () => {
          P.needs = "photo";
          P.stock = "";
        }),
      ),
      hl.categories.length
        ? h(
            "select",
            {
              class: "select",
              "aria-label": "Category",
              value: P.category,
              onchange: (e) => {
                P.category = e.target.value;
                load();
              },
            },
            h("option", { value: "" }, "All categories"),
            hl.categories.map((c) => h("option", { value: c.category }, `${c.category} (${num(c.n)})`)),
          )
        : null,
      h(
        "select",
        {
          class: "select",
          "aria-label": "Sort",
          value: P.sort,
          onchange: (e) => {
            P.sort = e.target.value;
            load();
          },
        },
        h("option", { value: "name" }, "Name A to Z"),
        h("option", { value: "price" }, "Price, low to high"),
        h("option", { value: "updated" }, "Recently changed"),
      ),
    ];
    toolbar.append(...controls.filter(Boolean));
  };

  const drawSelection = () => {
    const n = P.selected.size;
    selectionBar.hidden = n === 0;
    if (!n) return;
    const ids = [...P.selected];
    const act = (label, fn) => h("button", { class: "btn", type: "button", onclick: (e) => busy(e.currentTarget, fn) }, label);
    selectionBar.replaceChildren(
      h("strong", { text: `${num(n)} selected` }),
      act("Change prices", async () => openAdjust(ids)),
      act("In stock", async () => {
        await api("POST", `/businesses/${bid()}/products/stock`, { ids, inStock: true });
        toast(`${num(n)} marked in stock.`);
        await load();
      }),
      act("Out of stock", async () => {
        await api("POST", `/businesses/${bid()}/products/stock`, { ids, inStock: false });
        toast(`${num(n)} marked out of stock.`);
        await load();
      }),
      act("Prices still right", async () => {
        const r = await api("POST", `/businesses/${bid()}/products/confirm-prices`, { ids });
        toast(`${num(r.confirmed)} price${r.confirmed === 1 ? "" : "s"} confirmed for today.`);
        await load();
      }),
      act("Remove", async () => {
        if (!(await confirmDialog({ title: `Remove ${num(n)} product${n === 1 ? "" : "s"}?`, body: "Customers won't see them any more. Their photos are deleted.", ok: "Remove", danger: true }))) return;
        await api("POST", `/businesses/${bid()}/products/archive`, { ids });
        toast(`${num(n)} removed.`);
        P.selected.clear();
        await load();
      }),
      h(
        "button",
        {
          class: "btn btn-icon",
          type: "button",
          "aria-label": "Clear selection",
          onclick: () => {
            P.selected.clear();
            drawList();
          },
        },
        icon("close"),
      ),
    );
  };

  const drawList = () => {
    if (!P.items.length) {
      const filtered = P.q || P.stock || P.needs || P.category;
      list.replaceChildren(
        filtered
          ? emptyState("search", "Nothing matches", "Try another search, or clear the filters.")
          : emptyState(
              "products",
              "No products yet",
              "Add your products and prices, and customers who ask for them see your price in our reply.",
              h("button", { class: "btn btn-secondary", type: "button", onclick: () => openUpload() }, icon("upload"), "Upload a list"),
              h("button", { class: "btn", type: "button", onclick: () => openProduct() }, icon("plus"), "Add a product"),
            ),
      );
      drawSelection();
      return;
    }
    const all = h("input", {
      type: "checkbox",
      "aria-label": "Select all shown",
      checked: P.items.every((p) => P.selected.has(p.id)),
      onchange: (e) => {
        for (const p of P.items) e.target.checked ? P.selected.add(p.id) : P.selected.delete(p.id);
        drawList();
      },
    });
    const rows = P.items.map((p) => productRow(p, drawList, load));
    list.replaceChildren(
      h(
        "table",
        { class: "table products-table" },
        h(
          "thead",
          {},
          h(
            "tr",
            {},
            h("th", { class: "w-check" }, all),
            h("th", { text: "Product" }),
            h("th", { class: "num", text: "Price" }),
            h("th", { text: "In stock" }),
            h("th", { text: "Price updated" }),
            h("th", {}, h("span", { class: "sr-only", text: "Edit" })),
          ),
        ),
        h("tbody", {}, rows),
      ),
      h(
        "div",
        { class: "list-foot" },
        h("span", { text: `Showing ${num(P.items.length)} of ${num(P.total)}` }),
        P.items.length < P.total ? h("button", { class: "btn btn-secondary btn-sm", type: "button", onclick: (e) => busy(e.currentTarget, () => load(true)) }, "Show more") : null,
      ),
    );
    drawSelection();
  };

  // Photos coming from the links in an upload: how many are still on their way, and links that didn't work.
  let photoTimer;
  let lastWaiting = null;
  const drawPhotoNote = async () => {
    clearTimeout(photoTimer);
    let s;
    try {
      s = await api("GET", `/businesses/${bid()}/photo-links`);
    } catch {
      return;
    }
    if (stale(ticket)) return;
    // Some arrived since we last looked: show them on the products.
    if (lastWaiting != null && s.waiting < lastWaiting) load();
    lastWaiting = s.waiting;
    const notes = [];
    if (s.waiting) {
      notes.push(
        h(
          "div",
          { class: "callout" },
          h(
            "div",
            {},
            h("h2", { text: `Fetching ${num(s.waiting)} photo${s.waiting === 1 ? "" : "s"} from your links` }),
            h("p", { text: "They appear on your products as they arrive. You can leave this page." }),
          ),
        ),
      );
      photoTimer = setTimeout(() => !stale(ticket) && drawPhotoNote(), 8000);
    }
    if (s.failed) {
      notes.push(
        h(
          "div",
          { class: "callout" },
          h(
            "div",
            {},
            h("h2", { text: `${num(s.failed)} photo link${s.failed === 1 ? "" : "s"} didn't work` }),
            h("p", { text: "Those products are listed without a photo for now." }),
          ),
          h("div", { class: "actions" }, h("button", { class: "btn btn-secondary", type: "button", onclick: () => openPhotoFailures(drawPhotoNote) }, "See which")),
        ),
      );
    }
    photoNote.replaceChildren(...notes);
  };
  S.refreshPhotoNote = drawPhotoNote;

  S.reloadProducts = load;
  await load();
  drawPhotoNote();
}

/** The photo links that didn't work, and why: try them again, or clear the list. */
function openPhotoFailures(onChange) {
  const sheet = openSheet({ title: "Photo links that didn't work", subtitle: "Fix a link in your list and upload it again, or add the photo on the product." });
  const act = (label, kind, fn) => h("button", { class: `btn${kind}`, type: "button", onclick: (e) => busy(e.currentTarget, fn) }, label);
  const draw = async () => {
    const s = await api("GET", `/businesses/${bid()}/photo-links`);
    sheet.setBody(
      s.failures.length
        ? h(
            "table",
            { class: "map-table" },
            h("thead", {}, h("tr", {}, h("th", { text: "Product" }), h("th", { text: "What happened" }))),
            h(
              "tbody",
              {},
              s.failures.map((f) =>
                h(
                  "tr",
                  {},
                  h("td", {}, h("strong", { text: f.name }), h("br"), h("a", { class: "hint link-cell", href: f.url, target: "_blank", rel: "noopener noreferrer", text: f.url })),
                  h("td", { text: f.error }),
                ),
              ),
            ),
          )
        : h("p", { class: "muted", text: "None: every link worked." }),
      s.failed > s.failures.length ? h("p", { class: "hint", text: `and ${num(s.failed - s.failures.length)} more.` }) : null,
    );
    sheet.setFoot(
      act("Clear the list", " btn-ghost", async () => {
        const r = await api("POST", `/businesses/${bid()}/photo-links/clear`);
        toast(`${num(r.cleared)} cleared.`);
        sheet.close();
        onChange();
      }),
      h("span", { class: "spacer" }),
      act("Try them again", "", async () => {
        const r = await api("POST", `/businesses/${bid()}/photo-links/retry`);
        toast(`Trying ${num(r.retrying)} link${r.retrying === 1 ? "" : "s"} again.`);
        sheet.close();
        onChange();
      }),
    );
  };
  draw().catch((err) => err.status !== 401 && sheet.setBody(h("p", { class: "notice bad", text: err.message })));
}

function productRow(p, redraw, reload) {
  const staleDays = S.me.stalePriceDays;
  const isStale = p.price != null && (!p.priceUpdatedAt || Date.now() - new Date(p.priceUpdatedAt).getTime() > staleDays * 86400000);
  const check = h("input", {
    type: "checkbox",
    "aria-label": `Select ${p.name}`,
    checked: P.selected.has(p.id),
    onchange: (e) => {
      e.target.checked ? P.selected.add(p.id) : P.selected.delete(p.id);
      redraw();
    },
  });
  const priceCell = h("td", { class: "num c-price" });
  const showPrice = () => {
    const label = p.price != null ? money(p.price) : p.priceText ?? "Add a price";
    priceCell.replaceChildren(
      h(
        "button",
        {
          class: `price-btn${p.price == null ? " none" : ""}`,
          type: "button",
          title: "Change the price",
          "aria-label": `${p.name}: ${label}${p.price != null && p.unit ? ` ${p.unit}` : ""}. Change the price`,
          onclick: editPrice,
        },
        label,
        p.price != null && p.unit ? h("span", { class: "unit", text: p.unit }) : null,
      ),
    );
  };
  const editPrice = () => {
    const input = h("input", { class: "input price-edit", inputmode: "decimal", value: p.price != null ? p.price.toFixed(2) : "", "aria-label": `Price of ${p.name}` });
    let done = false;
    const save = async () => {
      if (done) return;
      done = true;
      const value = readPrice(input.value);
      if (Number.isNaN(value)) {
        toast("That isn't a price. Use a number like 12.50.", "bad");
        return showPrice();
      }
      if (value === p.price) return showPrice();
      const updated = await busy(null, () => api("PUT", `/businesses/${bid()}/products/${p.id}`, { price: value }));
      if (updated) {
        Object.assign(p, updated);
        toast(`${p.name}: ${value == null ? "price removed" : money(value)}.`);
        const tr = priceCell.closest("tr");
        tr.replaceWith(productRow(p, redraw, reload));
        return;
      }
      showPrice();
    };
    input.onkeydown = (e) => {
      if (e.key === "Enter") save();
      if (e.key === "Escape") {
        done = true;
        showPrice();
      }
    };
    input.onblur = save;
    priceCell.replaceChildren(input);
    input.focus();
    input.select();
  };
  showPrice();
  const stock = h("input", {
    type: "checkbox",
    checked: p.inStock,
    "aria-label": `${p.name} in stock`,
    onchange: async (e) => {
      const want = e.target.checked;
      const updated = await busy(null, () => api("PUT", `/businesses/${bid()}/products/${p.id}`, { inStock: want }));
      if (!updated) e.target.checked = !want;
      else Object.assign(p, updated);
    },
  });
  return h(
    "tr",
    {},
    h("td", { class: "c-check" }, check),
    h(
      "td",
      { class: "c-product" },
      h(
        "div",
        { class: "product-cell" },
        p.photoId ? h("img", { class: "thumb", src: photoUrl(p.photoId), alt: "", loading: "lazy" }) : h("div", { class: "thumb" }, icon("image")),
        h(
          "div",
          { class: "product-name" },
          h("button", { type: "button", text: p.name, onclick: () => openProduct(p) }),
          h("small", { text: [p.sku, p.category].filter(Boolean).join(" · ") || (p.inStock ? "In stock" : "Out of stock") }),
        ),
      ),
    ),
    priceCell,
    h("td", { class: "c-stock" }, h("label", { class: "switch" }, stock, h("span"))),
    h("td", { class: "c-when" }, h("span", { class: `when${isStale ? " stale" : ""}`, text: p.price == null ? "No price" : ago(p.priceUpdatedAt) })),
    h("td", { class: "c-more" }, h("button", { class: "btn btn-ghost btn-icon btn-sm", type: "button", "aria-label": `Edit ${p.name}`, onclick: () => openProduct(p) }, icon("edit"))),
  );
}

/** What happened to a price, in words: "added", "edited", "changed in bulk" or "uploaded". */
function historyLabel(c) {
  if (c.reason === "import") return "uploaded";
  if (c.oldPrice == null) return "added";
  return c.reason === "bulk" ? "changed in bulk" : "edited";
}

const UNITS = ["each", "per kg", "per litre", "per pack", "per box", "per bag", "per pair", "per dozen", "per metre", "per hour", "per day", "per visit", "per job"];

/** Add a product, or edit one: name, price, unit, category, code, description, stock and a photo. */
async function openProduct(existing) {
  let editing = Boolean(existing);
  let photo = editing && existing.photoId ? { url: photoUrl(existing.photoId), saved: true } : null;
  let pendingPhoto = null;
  let removePhoto = false;
  const categories = (P.health?.categories ?? []).map((c) => c.category);

  const name = h("input", { class: "input", id: "p-name", maxlength: 120, value: existing?.name ?? "", placeholder: "e.g. Samsung 55-inch smart TV" });
  const price = h("input", { class: "input", id: "p-price", inputmode: "decimal", value: existing?.price != null ? existing.price.toFixed(2) : "", placeholder: "0.00" });
  const unit = h("input", { class: "input", id: "p-unit", list: "units", maxlength: 30, value: existing?.unit ?? "", placeholder: "each" });
  const category = h("input", { class: "input", id: "p-cat", list: "cats", maxlength: 60, value: existing?.category ?? "", placeholder: "e.g. TVs" });
  const sku = h("input", { class: "input", id: "p-sku", maxlength: 60, value: existing?.sku ?? "", placeholder: "Your own code, if you use one" });
  const description = h("textarea", { class: "textarea", id: "p-desc", maxlength: 500, value: existing?.description ?? "", placeholder: "Size, model, warranty, what's included" });
  const inStock = h("input", { type: "checkbox", checked: existing ? existing.inStock : true, "aria-label": "In stock" });
  const photoBox = h("div");

  const drawPhoto = () => {
    if (photo && !removePhoto) {
      photoBox.replaceChildren(
        h(
          "div",
          { class: "photo-preview" },
          h("img", { src: photo.url, alt: "" }),
          h(
            "div",
            { class: "photo-actions" },
            h("button", { class: "btn btn-secondary btn-sm", type: "button", onclick: choosePhoto }, "Change"),
            h(
              "button",
              {
                class: "btn btn-secondary btn-sm",
                type: "button",
                onclick: () => {
                  if (photo.saved) removePhoto = true;
                  photo = null;
                  pendingPhoto = null;
                  drawPhoto();
                },
              },
              "Remove",
            ),
          ),
        ),
      );
    } else {
      const drop = h("button", { class: "photo-drop", type: "button", onclick: choosePhoto }, icon("image"), h("strong", { text: "Add a photo" }), h("span", { class: "hint", text: "JPEG, PNG or WebP. We shrink it for you." }));
      drop.addEventListener("dragover", (e) => {
        e.preventDefault();
        drop.classList.add("over");
      });
      drop.addEventListener("dragleave", () => drop.classList.remove("over"));
      drop.addEventListener("drop", (e) => {
        e.preventDefault();
        drop.classList.remove("over");
        const f = e.dataTransfer?.files?.[0];
        if (f) usePhoto(f);
      });
      photoBox.replaceChildren(drop);
    }
  };
  const usePhoto = async (file) => {
    try {
      pendingPhoto = await shrinkPhoto(file);
      photo = { url: pendingPhoto.url, saved: false };
      removePhoto = false;
      drawPhoto();
    } catch (err) {
      toast(err.message, "bad");
    }
  };
  async function choosePhoto() {
    const f = await pickFile("image/jpeg,image/png,image/webp");
    if (f) usePhoto(f);
  }
  drawPhoto();

  const history = h("div");
  const body = [
    h(
      "div",
      { class: "field" },
      h("span", { class: "label", text: "Photo" }),
      photoBox,
      h("span", { class: "hint", text: "With a photo and a price, customers can see it as a product card on WhatsApp." }),
    ),
    h("div", { class: "field" }, h("label", { for: "p-name", text: "Name" }), name),
    h(
      "div",
      { class: "form-row" },
      h("div", { class: "field" }, h("label", { for: "p-price", text: "Price (US$)" }), h("div", { class: "input-group" }, h("span", { class: "addon", text: "$" }), price), h("span", { class: "hint", text: "Leave it empty for “ask us”." })),
      h("div", { class: "field" }, h("label", { for: "p-unit", text: "Unit" }), unit, h("datalist", { id: "units" }, UNITS.map((u) => h("option", { value: u })))),
    ),
    h(
      "div",
      { class: "form-row" },
      h("div", { class: "field" }, h("label", { for: "p-cat", text: "Category" }), category, h("datalist", { id: "cats" }, categories.map((c) => h("option", { value: c })))),
      h("div", { class: "field" }, h("label", { for: "p-sku", text: "Code (SKU)" }), sku),
    ),
    h("div", { class: "field" }, h("label", { for: "p-desc", text: "Description" }), description),
    h("label", { class: "check", style: "align-items:center" }, h("span", { class: "switch" }, inStock, h("span")), h("span", { text: "In stock: customers can see it" })),
    history,
  ];
  const sheet = openSheet({ kind: "drawer", title: editing ? "Edit product" : "Add a product", subtitle: editing ? null : "Customers see it when they ask for it.", body });

  if (editing) {
    api("GET", `/businesses/${bid()}/products/${existing.id}`)
      .then((full) => {
        if (!full.history.length) return;
        history.replaceChildren(
          h("span", { class: "label", text: "Price history" }),
          h(
            "ul",
            { class: "history" },
            full.history.map((c) =>
              h(
                "li",
                {},
                h("span", { class: "muted", text: `${shortDate(c.at)} · ${historyLabel(c)}` }),
                h("span", { class: "tabular" }, c.oldPrice == null ? "" : money(c.oldPrice), c.oldPrice == null ? "" : h("span", { class: "arrow", text: "→" }), c.newPrice == null ? "no price" : money(c.newPrice)),
              ),
            ),
          ),
        );
      })
      .catch(() => {});
  }

  const save = h(
    "button",
    {
      class: "btn",
      type: "button",
      onclick: (e) =>
        busy(e.currentTarget, async () => {
          if (!name.value.trim()) throw new Error("Give the product a name.");
          const value = readPrice(price.value);
          if (Number.isNaN(value)) throw new Error("That isn't a price. Use a number like 12.50.");
          const payload = {
            name: name.value.trim(),
            price: value,
            unit: unit.value.trim() || null,
            category: category.value.trim() || null,
            sku: sku.value.trim() || null,
            description: description.value.trim(),
            inStock: inStock.checked,
          };
          const adding = !editing;
          const saved = editing ? await api("PUT", `/businesses/${bid()}/products/${existing.id}`, payload) : await api("POST", `/businesses/${bid()}/products`, payload);
          if (adding) {
            // It's saved: if the photo fails next, "Save" tries the photo again and never adds the product twice.
            existing = saved;
            editing = true;
            save.textContent = "Save";
          }
          if (pendingPhoto) await api("PUT", `/businesses/${bid()}/products/${saved.id}/photo`, { contentType: pendingPhoto.contentType, dataBase64: pendingPhoto.dataBase64 });
          else if (removePhoto) await api("DELETE", `/businesses/${bid()}/products/${saved.id}/photo`);
          sheet.close();
          toast(adding ? `${saved.name} added.` : "Product saved.");
          if (route().name === "products") await S.reloadProducts?.();
          else location.hash = "#/products";
        }),
    },
    editing ? "Save" : "Add product",
  );
  sheet.setFoot(
    editing
      ? h(
          "button",
          {
            class: "btn btn-danger",
            type: "button",
            onclick: async () => {
              if (!(await confirmDialog({ title: `Remove ${existing.name}?`, body: "Customers won't see it any more.", ok: "Remove", danger: true }))) return;
              await busy(null, async () => {
                await api("POST", `/businesses/${bid()}/products/archive`, { ids: [existing.id] });
                sheet.close();
                toast("Product removed.");
                await S.reloadProducts?.();
              });
            },
          },
          "Remove",
        )
      : null,
    h("span", { class: "spacer" }),
    h("button", { class: "btn btn-secondary", type: "button", onclick: () => sheet.close() }, "Cancel"),
    save,
  );
}

// ---------- Uploading a list ----------

const BATCH = 1000;

function openUpload() {
  const u = { rows: [], headers: [], headed: true, mapping: [], updateExisting: true, check: null };
  const sheet = openSheet({ title: "Upload a product list", subtitle: "From a CSV file, or cells copied from Excel or Google Sheets." });

  const stepChoose = () => {
    const paste = h("textarea", { class: "textarea", id: "paste", placeholder: "Copy the cells in Excel or Google Sheets, headings included, and paste them here", style: "min-height:120px" });
    const drop = h("div", { class: "dropzone", role: "button", tabindex: "0" }, icon("file"), h("strong", { text: "Choose a CSV file" }), h("span", { text: "or drop it here. In Excel: File, Save as, CSV." }));
    const useText = (text) => {
      const rows = parseSheet(text);
      if (!rows.length) return toast("That file is empty.", "bad");
      const headed = hasHeadings(rows);
      u.headed = headed;
      u.headers = headed ? rows[0].map((x) => x.trim()) : rows[0].map((_, i) => `Column ${i + 1}`);
      u.rows = headed ? rows.slice(1) : rows;
      if (!u.rows.length) return toast("There are headings but no products.", "bad");
      if (u.rows.length > 25000) return toast("That's more than 25,000 products. Split the list into smaller files.", "bad");
      u.mapping = headed ? guessMapping(u.headers) : u.headers.map((_, i) => (i === 0 ? "name" : i === 1 ? "price" : ""));
      stepMap();
    };
    const readFile = (file) => {
      if (!file) return;
      if (/\.xlsx?$/i.test(file.name)) return toast("Save the spreadsheet as CSV first (File, Save as, CSV), or copy the cells and paste them.", "bad");
      const reader = new FileReader();
      reader.onload = () => useText(String(reader.result));
      reader.readAsText(file);
    };
    const choose = async () => readFile(await pickFile(".csv,text/csv,.txt,text/plain,.tsv"));
    drop.onclick = choose;
    drop.onkeydown = (e) => (e.key === "Enter" || e.key === " ") && choose();
    drop.ondragover = (e) => {
      e.preventDefault();
      drop.classList.add("over");
    };
    drop.ondragleave = () => drop.classList.remove("over");
    drop.ondrop = (e) => {
      e.preventDefault();
      drop.classList.remove("over");
      readFile(e.dataTransfer?.files?.[0]);
    };
    sheet.setBody(
      drop,
      h("div", { class: "field" }, h("label", { for: "paste", text: "Or paste your list" }), paste),
      h("p", { class: "hint" }, "Not sure how to lay it out? ", h("a", { href: "/app/products-template.csv", download: "" }, "Download our template"), ": a name and a price are enough."),
    );
    sheet.setFoot(
      h("span", { class: "spacer" }),
      h("button", { class: "btn btn-secondary", type: "button", onclick: () => sheet.close() }, "Cancel"),
      h(
        "button",
        {
          class: "btn",
          type: "button",
          onclick: () => {
            if (!paste.value.trim()) return toast("Choose a file, or paste your list.", "bad");
            useText(paste.value);
          },
        },
        "Continue",
      ),
    );
  };

  const stepMap = () => {
    const options = [["", "Leave out"], ...FIELDS.map((f) => [f.key, f.label])];
    const table = h(
      "table",
      { class: "map-table" },
      h("thead", {}, h("tr", {}, h("th", { text: "Column" }), h("th", { text: "First row" }), h("th", { text: "Goes to" }))),
      h(
        "tbody",
        {},
        u.headers.map((header, i) =>
          h(
            "tr",
            {},
            h("td", { text: header || `Column ${i + 1}` }),
            h("td", { class: "sample", text: u.rows[0]?.[i] ?? "" }),
            h(
              "td",
              {},
              h(
                "select",
                {
                  class: "select",
                  "aria-label": `Where ${header} goes`,
                  value: u.mapping[i],
                  onchange: (e) => {
                    const key = e.target.value;
                    u.mapping = u.mapping.map((m, j) => (j === i ? key : m === key && key ? "" : m));
                    stepMap();
                  },
                },
                options.map(([v, label]) => h("option", { value: v }, label)),
              ),
            ),
          ),
        ),
      ),
    );
    const update = h("input", { type: "checkbox", checked: u.updateExisting, onchange: (e) => (u.updateExisting = e.target.checked) });
    sheet.setBody(
      h("p", { class: "muted", text: `${num(u.rows.length)} row${u.rows.length === 1 ? "" : "s"} found. Check where each column goes.` }),
      table,
      h("label", { class: "check" }, update, h("span", { text: "Update products I've already listed (matched by code, or else by name). Columns you leave out, and empty cells, stay as they are; to take a price off, write ask." })),
    );
    sheet.setFoot(
      h("button", { class: "btn btn-ghost", type: "button", onclick: stepChoose }, "Back"),
      h("span", { class: "spacer" }),
      h(
        "button",
        {
          class: "btn",
          type: "button",
          onclick: (e) =>
            busy(e.currentTarget, async () => {
              if (!u.mapping.includes("name")) throw new Error("Choose the column with the product names.");
              u.check = await runImport(true);
              stepReview();
            }),
        },
        "Check the list",
      ),
    );
  };

  /** Send the list in batches. Row numbers match the spreadsheet (headings are row 1). */
  const runImport = async (dryRun, onProgress) => {
    const all = toImportRows(u.rows, u.mapping);
    const total = { added: 0, updated: 0, unchanged: 0, errors: 0, problems: [], photos: { fetch: 0, keep: 0, problems: [] } };
    for (let start = 0; start < all.length; start += BATCH) {
      const r = await api("POST", `/businesses/${bid()}/products/import`, { rows: all.slice(start, start + BATCH), updateExisting: u.updateExisting, dryRun });
      total.added += r.added;
      total.updated += r.updated;
      total.unchanged += r.unchanged;
      total.errors += r.errors;
      total.photos.fetch += r.photos?.fetch ?? 0;
      total.photos.keep += r.photos?.keep ?? 0;
      for (const row of r.rows) {
        const at = row.row + start + (u.headed ? 1 : 0);
        if (row.action === "error" && total.problems.length < 200) total.problems.push({ ...row, row: at });
        if (row.photoError && total.photos.problems.length < 200) total.photos.problems.push({ ...row, row: at });
      }
      onProgress?.(Math.min(all.length, start + BATCH) / all.length);
    }
    return total;
  };

  const stepReview = () => {
    const c = u.check;
    const changes = c.added + c.updated;
    const photos = c.photos.fetch;
    sheet.setBody(
      h(
        "div",
        { class: "summary" },
        h("div", {}, h("strong", { text: num(c.added) }), "new"),
        h("div", {}, h("strong", { text: num(c.updated) }), "updated"),
        h("div", {}, h("strong", { text: num(c.unchanged) }), "unchanged"),
        h("div", {}, h("strong", { text: num(c.errors) }), "with problems"),
      ),
      c.errors
        ? h(
            "div",
            { class: "field" },
            h("span", { class: "label", text: "Rows with problems are skipped:" }),
            h("ul", { class: "errors" }, c.problems.map((p) => h("li", { text: `Row ${p.row}${p.name ? ` (${p.name})` : ""}: ${p.error}` }))),
          )
        : null,
      photos || c.photos.problems.length
        ? h(
            "div",
            { class: "field" },
            h("span", {
              class: "label",
              text: photos ? `${num(photos)} photo${photos === 1 ? "" : "s"} will be fetched from their links after the import.` : "No photos to fetch.",
            }),
            c.photos.keep ? h("span", { class: "hint", text: `${num(c.photos.keep)} product${c.photos.keep === 1 ? "" : "s"} keep the photo they have.` }) : null,
            c.photos.problems.length
              ? h("ul", { class: "errors" }, c.photos.problems.map((p) => h("li", { text: `Row ${p.row} (${p.name}): ${p.photoError}. It's imported without a photo.` })))
              : null,
          )
        : null,
      h("p", { class: "muted", text: changes || photos ? "Nothing has changed yet. Import when you're ready." : "There's nothing new to import." }),
    );
    sheet.setFoot(
      h("button", { class: "btn btn-ghost", type: "button", onclick: stepMap }, "Back"),
      h("span", { class: "spacer" }),
      h(
        "button",
        {
          class: "btn",
          type: "button",
          disabled: !changes && !photos,
          onclick: () => stepRun(),
        },
        changes ? `Import ${num(changes)} product${changes === 1 ? "" : "s"}` : `Fetch ${num(photos)} photo${photos === 1 ? "" : "s"}`,
      ),
    );
  };

  const stepRun = async () => {
    const bar = h("div", { style: "width:0%" });
    sheet.setBody(h("p", { class: "muted", text: "Importing… keep this window open." }), h("div", { class: "progress" }, bar));
    sheet.setFoot();
    try {
      const done = await runImport(false, (f) => (bar.style.width = `${Math.round(f * 100)}%`));
      sheet.setBody(
        h("div", { class: "summary" }, h("div", {}, h("strong", { text: num(done.added) }), "added"), h("div", {}, h("strong", { text: num(done.updated) }), "updated"), h("div", {}, h("strong", { text: num(done.unchanged) }), "unchanged"), h("div", {}, h("strong", { text: num(done.errors) }), "skipped")),
        h("p", { class: "muted", text: "Done. Customers see the new prices in our replies straight away." }),
        done.photos.fetch
          ? h("p", {
              class: "muted",
              text: `${num(done.photos.fetch)} photo${done.photos.fetch === 1 ? " is" : "s are"} on the way from their links. They appear on your products over the next few minutes, and you can close this.`,
            })
          : null,
      );
      sheet.setFoot(h("span", { class: "spacer" }), h("button", { class: "btn", type: "button", onclick: () => sheet.close() }, "Done"));
      if (route().name === "products") {
        await S.reloadProducts?.();
        S.refreshPhotoNote?.();
      } else location.hash = "#/products";
    } catch (err) {
      if (err.status !== 401) {
        sheet.setBody(h("p", { class: "notice bad", text: `${err.message} Part of the list may have been imported: check it, then upload again. Products already listed are updated, not doubled.` }));
        sheet.setFoot(h("span", { class: "spacer" }), h("button", { class: "btn", type: "button", onclick: () => sheet.close() }, "Close"));
      }
    }
  };

  stepChoose();
}

// ---------- Adding many photos ----------

const MAX_PHOTO_FILES = 500;

function pickFiles(accept) {
  return new Promise((resolve) => {
    const input = h("input", { type: "file", accept, multiple: true, style: "display:none" });
    const done = (files) => {
      resolve(files);
      input.remove();
    };
    input.onchange = () => done([...(input.files ?? [])]);
    input.addEventListener("cancel", () => done([]));
    document.body.append(input);
    input.click();
  });
}

/**
 * Many photos at once, matched to products by their file names (the product's code or its name).
 * The owner chooses the product for any that didn't match; each photo is made smaller here first.
 */
function openPhotos() {
  const st = { matches: [], products: null, replace: false, urls: [] };
  const sheet = openSheet({
    title: "Add photos",
    subtitle: "Choose many at once. Name each photo after the product's code or name, like CEM-50.jpg, and we match them for you.",
    onClose: () => st.urls.forEach((url) => URL.revokeObjectURL(url)),
  });

  const useFiles = async (files) => {
    const chosen = files.filter((f) => /^image\//.test(f.type) || /\.(jpe?g|png|webp|heic|heif)$/i.test(f.name));
    if (!chosen.length) return toast("Choose photos: JPEG, PNG or WebP.", "bad");
    if (chosen.length > MAX_PHOTO_FILES) return toast(`Choose up to ${num(MAX_PHOTO_FILES)} photos at a time.`, "bad");
    try {
      st.products ??= await api("GET", `/businesses/${bid()}/products/index`);
    } catch (err) {
      if (err.status !== 401) toast(err.message, "bad");
      return;
    }
    if (!st.products.length) return toast("Add your products first, then their photos.", "bad");
    st.matches = matchPhotos(
      chosen.map((f) => f.name),
      st.products,
    ).map((m, i) => ({ ...m, blob: chosen[i] }));
    stepMatch();
  };

  const stepChoose = () => {
    const drop = h("div", { class: "dropzone", role: "button", tabindex: "0" }, icon("image"), h("strong", { text: "Choose photos" }), h("span", { text: "or drop them here. You can pick many at once." }));
    const choose = async () => useFiles(await pickFiles("image/*"));
    drop.onclick = choose;
    drop.onkeydown = (e) => (e.key === "Enter" || e.key === " ") && choose();
    drop.ondragover = (e) => {
      e.preventDefault();
      drop.classList.add("over");
    };
    drop.ondragleave = () => drop.classList.remove("over");
    drop.ondrop = (e) => {
      e.preventDefault();
      drop.classList.remove("over");
      useFiles([...(e.dataTransfer?.files ?? [])]);
    };
    sheet.setBody(drop, h("p", { class: "hint", text: "Photos already on your website? Put their links in a Photo link column and upload your list instead." }));
    sheet.setFoot(h("span", { class: "spacer" }), h("button", { class: "btn btn-secondary", type: "button", onclick: () => sheet.close() }, "Cancel"));
  };

  /** One photo per product: the first file for a product wins; products with a photo keep it unless replaced. */
  const toAdd = () => {
    const seen = new Set();
    return st.matches.filter((m) => {
      if (!m.product || seen.has(m.product.id) || (!st.replace && m.product.hasPhoto)) return false;
      seen.add(m.product.id);
      return true;
    });
  };

  const drawFoot = () => {
    const n = toAdd().length;
    sheet.setFoot(
      h("button", { class: "btn btn-ghost", type: "button", onclick: stepChoose }, "Back"),
      h("span", { class: "spacer" }),
      h("button", { class: "btn", type: "button", disabled: !n, onclick: () => stepUpload() }, n ? `Add ${num(n)} photo${n === 1 ? "" : "s"}` : "Nothing to add"),
    );
  };

  const stepMatch = () => {
    const byName = new Map(st.products.map((p) => [p.name.toLowerCase(), p]));
    const matched = st.matches.filter((m) => m.by === "code" || m.by === "name").length;
    const unmatched = st.matches.length - matched;
    const rows = st.matches.map((m) => {
      const url = URL.createObjectURL(m.blob);
      st.urls.push(url);
      const target = h("td");
      const drawTarget = () =>
        target.replaceChildren(
          m.product
            ? h("span", {}, h("strong", { text: m.product.name }), m.product.hasPhoto ? h("span", { class: "hint", text: " · has a photo" }) : null)
            : h("input", {
                class: "input",
                list: "photo-products",
                placeholder: "Which product? Type its name",
                "aria-label": `Product for ${m.file}`,
                onchange: (e) => {
                  const typed = e.target.value.trim();
                  const product = byName.get(typed.toLowerCase());
                  if (product) {
                    m.product = product;
                    drawTarget();
                    drawFoot();
                  } else if (typed) toast("Pick a product from the list.", "bad");
                },
              }),
        );
      drawTarget();
      return h("tr", {}, h("td", {}, h("img", { class: "thumb", src: url, alt: "", loading: "lazy" })), h("td", { class: "file", text: m.file }), target);
    });
    const replace = h("input", {
      type: "checkbox",
      checked: st.replace,
      onchange: (e) => {
        st.replace = e.target.checked;
        drawFoot();
      },
    });
    sheet.setBody(
      h("p", {
        class: "muted",
        text: `${num(matched)} of ${num(st.matches.length)} photo${st.matches.length === 1 ? "" : "s"} matched a product by its code or name.${unmatched ? " Choose the product for the rest, or leave them out." : ""}`,
      }),
      unmatched ? h("datalist", { id: "photo-products" }, st.products.map((p) => h("option", { value: p.name }))) : null,
      h("table", { class: "photo-table" }, h("tbody", {}, rows)),
      h("label", { class: "check" }, replace, h("span", { text: "Replace photos products already have" })),
    );
    drawFoot();
  };

  const stepUpload = async () => {
    const queue = toAdd();
    const bar = h("div", { style: "width:0%" });
    sheet.setBody(h("p", { class: "muted", text: `Adding ${num(queue.length)} photo${queue.length === 1 ? "" : "s"}… keep this window open.` }), h("div", { class: "progress" }, bar));
    sheet.setFoot();
    let added = 0;
    const failed = [];
    let next = 0;
    let signedOut = false;
    // Three at a time: quick on a good connection, gentle on a slow one.
    const worker = async () => {
      while (next < queue.length && !signedOut) {
        const m = queue[next++];
        try {
          const small = await shrinkPhoto(m.blob);
          await api("PUT", `/businesses/${bid()}/products/${m.product.id}/photo`, { contentType: small.contentType, dataBase64: small.dataBase64 });
          URL.revokeObjectURL(small.url);
          m.product.hasPhoto = true;
          added++;
        } catch (err) {
          if (err.status === 401) signedOut = true;
          else failed.push({ file: m.file, error: err.message });
        }
        bar.style.width = `${Math.round(((added + failed.length) / queue.length) * 100)}%`;
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    if (signedOut) return;
    sheet.setBody(
      h("div", { class: "summary" }, h("div", {}, h("strong", { text: num(added) }), "added"), h("div", {}, h("strong", { text: num(failed.length) }), "didn't work")),
      failed.length ? h("ul", { class: "errors" }, failed.slice(0, 100).map((f) => h("li", { text: `${f.file}: ${f.error}` }))) : null,
      h("p", { class: "muted", text: "The photos are on your products now." }),
    );
    sheet.setFoot(h("span", { class: "spacer" }), h("button", { class: "btn", type: "button", onclick: () => sheet.close() }, "Done"));
    if (route().name === "products") await S.reloadProducts?.();
  };

  stepChoose();
}

// ---------- Changing many prices ----------

function openAdjust(ids) {
  const categories = (P.health?.categories ?? []).map((c) => c.category);
  const a = { scope: ids?.length ? "ids" : "all", category: categories[0] ?? "", mode: "raise-pct", value: "", round: "cents", preview: null };
  const sheet = openSheet({ title: "Change prices", subtitle: "Raise or cut many prices at once. You'll see every change before it's saved." });
  const previewBox = h("div");
  // Any change to the settings hides the old preview: what's saved is always what was last shown.
  const resetPreview = () => {
    a.preview = null;
    previewBox.replaceChildren();
    drawFoot();
  };
  const drawPreview = () => {
    const p = a.preview;
    previewBox.replaceChildren(
      ...present([
        h(
          "div",
          { class: "field" },
          h("span", { class: "label", text: p.count ? `${num(p.count)} price${p.count === 1 ? "" : "s"} will change` : "No prices would change" }),
          p.count
            ? h(
                "table",
                { class: "preview-table" },
                h(
                  "tbody",
                  {},
                  p.preview.slice(0, 10).map((c) =>
                    h("tr", {}, h("td", { text: c.name }), h("td", {}, c.oldPrice == null ? "no price" : money(c.oldPrice), h("span", { class: "arrow", text: "→" }), h("strong", { text: money(c.newPrice) }))),
                  ),
                ),
              )
            : null,
          p.count > 10 ? h("span", { class: "hint", text: `and ${num(p.count - 10)} more.` }) : null,
          p.skipped ? h("span", { class: "hint", text: `${num(p.skipped)} without a price, or already at that price, stay as they are.` }) : null,
        ),
      ]),
    );
    drawFoot();
  };

  const draw = () => {
    const scopeOption = (value, label, extra) =>
      h(
        "label",
        {},
        h("input", {
          type: "radio",
          name: "scope",
          value,
          checked: a.scope === value,
          onchange: () => {
            a.scope = value;
            a.preview = null;
            draw();
          },
        }),
        h("span", { text: label }),
        extra,
      );
    const modes = [
      ["raise-pct", "Raise by %"],
      ["cut-pct", "Cut by %"],
      ["raise-amt", "Raise by $"],
      ["cut-amt", "Cut by $"],
      ["set", "Set to $"],
    ];
    const value = h("input", {
      class: "input",
      id: "adj-value",
      inputmode: "decimal",
      value: a.value,
      placeholder: a.mode.endsWith("pct") ? "e.g. 5" : "e.g. 1.50",
      oninput: (e) => {
        a.value = e.target.value;
        resetPreview();
      },
    });
    sheet.setBody(
      h("div", { class: "field" }, h("span", { class: "label", text: "Which products" }), h(
        "div",
        { class: "radio-cards" },
        ids?.length ? scopeOption("ids", `The ${num(ids.length)} you selected`) : null,
        categories.length
          ? scopeOption(
              "category",
              "One category",
              h(
                "select",
                {
                  class: "select",
                  "aria-label": "Category",
                  value: a.category,
                  onchange: (e) => {
                    a.category = e.target.value;
                    a.scope = "category";
                    a.preview = null;
                    draw();
                  },
                },
                categories.map((c) => h("option", { value: c }, c)),
              ),
            )
          : null,
        scopeOption("all", "All products"),
      )),
      h(
        "div",
        { class: "field" },
        h("span", { class: "label", text: "Change" }),
        h(
          "div",
          { class: "segmented", role: "group", "aria-label": "How to change them", style: "flex-wrap:wrap;border-radius:16px" },
          modes.map(([m, label]) =>
            h(
              "button",
              {
                type: "button",
                "aria-pressed": String(a.mode === m),
                onclick: () => {
                  a.mode = m;
                  a.preview = null;
                  draw();
                },
              },
              label,
            ),
          ),
        ),
      ),
      h(
        "div",
        { class: "form-row" },
        h("div", { class: "field" }, h("label", { for: "adj-value", text: a.mode.endsWith("pct") ? "Percent" : "Amount (US$)" }), value),
        h(
          "div",
          { class: "field" },
          h("label", { for: "adj-round", text: "Round to" }),
          h(
            "select",
            {
              class: "select",
              id: "adj-round",
              value: a.round,
              onchange: (e) => {
                a.round = e.target.value;
                resetPreview();
              },
            },
            [
              ["cents", "The nearest cent"],
              ["0.05", "The nearest 5c"],
              ["0.10", "The nearest 10c"],
              ["0.50", "The nearest 50c"],
              ["1", "The nearest dollar"],
            ].map(([v, label]) => h("option", { value: v }, label)),
          ),
        ),
      ),
      previewBox,
    );
    previewBox.replaceChildren();
    drawFoot();
  };

  const payload = (dryRun) => {
    const n = readPrice(a.value);
    if (n == null || Number.isNaN(n)) throw new Error("Enter an amount.");
    const scope = a.scope === "ids" ? { ids } : a.scope === "category" ? { category: a.category } : { all: true };
    const mode = a.mode.endsWith("pct") ? "percent" : a.mode === "set" ? "set" : "amount";
    const value = a.mode.startsWith("cut") ? -n : n;
    if (mode === "percent" && value <= -100) throw new Error("A cut must be less than 100%.");
    return { scope, mode, value, round: a.round, dryRun };
  };

  const drawFoot = () => {
    sheet.setFoot(
      h("span", { class: "spacer" }),
      h("button", { class: "btn btn-secondary", type: "button", onclick: () => sheet.close() }, "Cancel"),
      a.preview && a.preview.count
        ? h(
            "button",
            {
              class: "btn",
              type: "button",
              onclick: (e) =>
                busy(e.currentTarget, async () => {
                  const r = await api("POST", `/businesses/${bid()}/products/adjust-prices`, payload(false));
                  sheet.close();
                  toast(`${num(r.count)} price${r.count === 1 ? "" : "s"} changed.`);
                  P.selected.clear();
                  await S.reloadProducts?.();
                }),
            },
            `Change ${num(a.preview.count)} price${a.preview.count === 1 ? "" : "s"}`,
          )
        : h(
            "button",
            {
              class: "btn",
              type: "button",
              onclick: (e) =>
                busy(e.currentTarget, async () => {
                  a.preview = await api("POST", `/businesses/${bid()}/products/adjust-prices`, payload(true));
                  drawPreview();
                }),
            },
            "Preview",
          ),
    );
  };
  draw();
}

// ---------- Customers ----------

async function renderCustomers(view, params, ticket) {
  const redo = () => renderCustomers(view, params, ++S.ticket);
  view.replaceChildren(pageHead("Customers", "Everyone we sent to you, with their reference code", periodControl(redo)), h("div", { class: "skeleton", style: "height:260px" }));
  let rows;
  try {
    rows = await api("GET", `/businesses/${bid()}/customers?days=${S.period}`);
  } catch (err) {
    if (!stale(ticket)) view.append(h("p", { class: "notice bad", text: err.message }));
    return;
  }
  if (stale(ticket)) return;
  const head = pageHead("Customers", "Everyone we sent to you, with their reference code", periodControl(redo));
  if (!rows.length) {
    return view.replaceChildren(
      head,
      h("div", { class: "card" }, emptyState("customers", "No customers in this period", "When we send you a customer, they appear here with the reference code in their first message and what they asked for.")),
    );
  }
  view.replaceChildren(
    head,
    h(
      "div",
      { class: "card table-card" },
      h(
        "table",
        { class: "table stack" },
        h("thead", {}, h("tr", {}, h("th", { text: "When" }), h("th", { text: "Reference" }), h("th", { text: "What they asked" }))),
        h(
          "tbody",
          {},
          // How each customer answered our follow-up stays private; the Overview shows the totals.
          rows.map((r) =>
            h(
              "tr",
              {},
              h("td", { class: "when", "data-label": "When", text: `${shortDate(r.at)} · ${ago(r.at)}` }),
              h("td", { "data-label": "Reference" }, h("span", { class: "mono", text: r.ref })),
              h("td", { "data-label": "Asked", text: r.what ?? "–" }),
            ),
          ),
        ),
      ),
    ),
  );
}

// ---------- Insights ----------

async function renderInsights(view, params, ticket) {
  stopCharts();
  const b = business();
  const redo = () => renderInsights(view, params, ++S.ticket);
  const sub = `What people ask for in your line of business${b.area ? ", in your city" : ""}`;
  view.replaceChildren(pageHead("Insights", sub, periodControl(redo)), skeletonCards(3));
  let a;
  try {
    a = await api("GET", `/businesses/${bid()}/analytics?days=${S.period}`);
  } catch (err) {
    if (!stale(ticket)) view.append(h("p", { class: "notice bad", text: err.message }));
    return;
  }
  if (stale(ticket)) return;
  const m = a.market;
  const share = m.requests ? a.kpis.shown / m.requests : null;
  const hoursBox = h("div", { style: "min-height:200px" });
  view.replaceChildren(
    pageHead("Insights", sub, periodControl(redo)),
    h(
      "div",
      { class: "grid grid-4", style: "grid-template-columns:repeat(auto-fit,minmax(200px,1fr))" },
      kpi("Requests in your categories", num(m.requests), h("span", { text: `Last ${a.days} days` })),
      kpi("Nobody could supply", num(m.unmet), h("span", { text: m.requests ? `${pct(m.unmet / m.requests)} of them` : "–" })),
      kpi("You came up in", share == null ? "–" : pct(Math.min(1, share)), h("span", { text: "Of those requests" })),
    ),
    h(
      "div",
      { class: "grid grid-2 section-gap" },
      h(
        "div",
        { class: "card panel" },
        h("div", { class: "panel-head" }, h("div", {}, h("h2", { text: "What people ask for" }), h("p", { text: "Marked where nobody near them had it" }))),
        m.demand.length
          ? barList(m.demand, { extra: (d) => (d.unmet ? h("span", { class: "badge warn plain", text: `${num(d.unmet)} not found` }) : null) })
          : emptyState("insights", "No requests yet", "As customers ask for things in your categories, the most wanted appear here."),
      ),
      h(
        "div",
        { class: "card panel" },
        h("div", { class: "panel-head" }, h("div", {}, h("h2", { text: "When people search" }), h("p", { text: "Requests by hour of the day, Harare time" }))),
        hoursBox,
      ),
    ),
    h(
      "div",
      { class: "card panel section-gap" },
      h("div", { class: "panel-head" }, h("div", {}, h("h2", { text: "What customers asked when they found you" }))),
      a.topAsks.length ? barList(a.topAsks) : emptyState("search", "Nothing yet", "When you come up in searches, what customers asked for appears here."),
    ),
  );
  const label = (hr) => (hr === 0 ? "12am" : hr < 12 ? `${hr}am` : hr === 12 ? "12pm" : `${hr - 12}pm`);
  S.cleanup.push(barChart(hoursBox, m.hours.map((n, hr) => ({ label: label(hr), long: `${label(hr)} to ${label((hr + 1) % 24)}`, value: n, tip: `${num(n)} request${n === 1 ? "" : "s"}` })), { title: "Requests by hour", labelEvery: 6, anchor: "start" }));
}

// ---------- Business profile ----------

function categoryPicker(selected, onChange) {
  const box = h("div", { class: "field" });
  const all = S.options.categories;
  const draw = () => {
    const input = h("input", { class: "input", placeholder: selected.length >= 3 ? "Three chosen" : "Add a category: type to search", disabled: selected.length >= 3, "aria-label": "Add a category", list: "all-cats" });
    input.onchange = () => {
      const c = all.find((x) => x.name.toLowerCase() === input.value.trim().toLowerCase());
      if (c && !selected.includes(c.slug) && selected.length < 3) {
        selected.push(c.slug);
        onChange();
        draw();
      } else if (input.value.trim()) toast("Pick a category from the list.", "bad");
    };
    box.replaceChildren(
      h("span", { class: "label", text: "Categories" }),
      h(
        "div",
        { class: "cat-chips" },
        selected.map((slug) =>
          h(
            "span",
            { class: "chip" },
            all.find((c) => c.slug === slug)?.name ?? slug,
            h(
              "button",
              {
                type: "button",
                "aria-label": "Remove",
                onclick: () => {
                  if (selected.length === 1) return toast("Keep at least one category.", "bad");
                  selected.splice(selected.indexOf(slug), 1);
                  onChange();
                  draw();
                },
              },
              "×",
            ),
          ),
        ),
      ),
      input,
      // The label carries synonyms, so typing "fridge" offers Home appliances.
      h("datalist", { id: "all-cats" }, all.filter((c) => !selected.includes(c.slug)).map((c) => h("option", { value: c.name }, [c.group, ...(c.synonyms ?? []).slice(0, 6)].join(" · ")))),
      h("span", { class: "hint", text: "Up to three. Customers find you when they ask for any of them." }),
    );
  };
  draw();
  return box;
}

async function renderProfile(view, params, ticket) {
  view.replaceChildren(pageHead("Business profile", "What customers see about your business"), h("div", { class: "skeleton", style: "height:420px" }));
  let p;
  try {
    p = await api("GET", `/businesses/${bid()}`);
  } catch (err) {
    if (!stale(ticket)) view.append(h("p", { class: "notice bad", text: err.message }));
    return;
  }
  if (stale(ticket)) return;
  const f = { ...p, categories: [...p.categories] };
  let dirty = false;
  const saveBar = h("div", { class: "save-bar", hidden: true });
  const changed = () => {
    dirty = true;
    saveBar.hidden = false;
  };
  const input = (key, attrs = {}) => h("input", { class: "input", value: f[key] ?? "", oninput: (e) => ((f[key] = e.target.value), changed()), ...attrs });
  let fieldIds = 0;
  const field = (label, control, hint) => {
    control.id ||= `pf-${++fieldIds}`;
    return h("div", { class: "field" }, h("label", { for: control.id, text: label }), control, hint ? h("span", { class: "hint", text: hint }) : null);
  };

  const byCity = new Map();
  for (const a of S.options.areas) {
    if (!byCity.has(a.city)) byCity.set(a.city, []);
    byCity.get(a.city).push(a);
  }
  const cities = [...byCity].sort(([x], [y]) => (x === "Harare" ? -1 : y === "Harare" ? 1 : x.localeCompare(y)));
  const area = h(
    "select",
    { class: "select", value: String(f.areaId ?? ""), onchange: (e) => ((f.areaId = Number(e.target.value)), (f.lat = null), (f.lng = null), changed()) },
    f.areaId == null ? h("option", { value: "", disabled: true }, "Pick your area") : null,
    cities.map(([city, areas]) => h("optgroup", { label: city }, areas.sort((x, y) => x.name.localeCompare(y.name)).map((a) => h("option", { value: String(a.id) }, a.name)))),
  );
  const pinNote = h("span", { class: "hint", text: f.lat != null ? "Customers are sorted by distance from your pin." : "" });
  const pinButton = h(
    "button",
    {
      class: "btn btn-secondary btn-sm",
      type: "button",
      onclick: (e) => {
        if (!navigator.geolocation) return toast("This browser can't share your location.", "bad");
        const btn = e.currentTarget;
        btn.classList.add("is-busy");
        navigator.geolocation.getCurrentPosition(
          (pos) => {
            btn.classList.remove("is-busy");
            f.lat = pos.coords.latitude;
            f.lng = pos.coords.longitude;
            pinNote.textContent = "Pin set to where you are now. Save to keep it.";
            changed();
          },
          () => {
            btn.classList.remove("is-busy");
            toast("We couldn't get your location. Check the browser's permission.", "bad");
          },
          { enableHighAccuracy: true, timeout: 15000 },
        );
      },
    },
    icon("pin"),
    "Use where I am now",
  );
  const trade = h("div", { class: "segmented", role: "group", "aria-label": "Who you sell to" });
  const drawTrade = () =>
    trade.replaceChildren(
      ...[
        ["retail", "The public"],
        ["wholesale", "Businesses (wholesale)"],
        ["both", "Both"],
      ].map(([v, label]) => h("button", { type: "button", "aria-pressed": String(f.trade === v), onclick: () => ((f.trade = v), drawTrade(), changed()) }, label)),
    );
  drawTrade();

  const gallery = h("div", { class: "gallery" });
  const drawGallery = () => {
    gallery.replaceChildren(
      ...f.photos.map((ph) =>
        h(
          "figure",
          {},
          h("img", { src: photoUrl(ph.id), alt: "", loading: "lazy" }),
          h("figcaption", {}, h("span", { class: "badge plain", text: ph.kind === "shopfront" ? "Shopfront" : "Inside" })),
          h(
            "button",
            {
              class: "btn btn-secondary btn-icon remove",
              type: "button",
              "aria-label": "Remove photo",
              onclick: async (e) => {
                const button = e.currentTarget; // gone once the event has been handled
                if (!(await confirmDialog({ title: "Remove this photo?", body: "It's deleted for good.", ok: "Remove", danger: true }))) return;
                await busy(button, async () => {
                  await api("DELETE", `/businesses/${bid()}/photos/${ph.id}`);
                  f.photos = f.photos.filter((x) => x.id !== ph.id);
                  drawGallery();
                });
              },
            },
            icon("close"),
          ),
        ),
      ),
      ...(f.photos.length < 8
        ? [
            ["shopfront", "Add a shopfront photo"],
            ["inside", "Add an inside photo"],
          ].map(([kind, label]) =>
            h(
              "button",
              {
                class: "add",
                type: "button",
                onclick: async (e) => {
                  const button = e.currentTarget;
                  const file = await pickFile("image/jpeg,image/png,image/webp");
                  if (!file) return;
                  await busy(button, async () => {
                    const small = await shrinkPhoto(file);
                    const r = await api("POST", `/businesses/${bid()}/photos`, { kind, contentType: small.contentType, dataBase64: small.dataBase64 });
                    f.photos.push({ id: r.id, kind });
                    drawGallery();
                    toast("Photo added.");
                  });
                },
              },
              icon("image"),
              label,
            ),
          )
        : []),
    );
  };
  drawGallery();

  const save = h(
    "button",
    {
      class: "btn",
      type: "button",
      onclick: (e) =>
        busy(e.currentTarget, async () => {
          if (String(f.name ?? "").trim().length < 2) throw new Error("Give the business a name.");
          if (f.areaId == null) throw new Error("Pick your area.");
          const digits = String(f.phone).replace(/\D/g, "");
          await api("PUT", `/businesses/${bid()}`, {
            name: f.name,
            description: f.description ?? "",
            keywords: f.keywords ?? "",
            categories: f.categories,
            areaId: Number(f.areaId),
            address: f.address ?? "",
            lat: f.lat,
            lng: f.lng,
            phone: digits.startsWith("0") ? `263${digits.slice(1)}` : digits,
            hours: f.hours ?? "",
            email: f.email ?? "",
            website: f.website ?? "",
            trade: f.trade,
          });
          dirty = false;
          saveBar.hidden = true;
          const mine = business();
          mine.name = f.name.trim();
          mine.area = S.options.areas.find((x) => x.id === Number(f.areaId))?.name ?? mine.area;
          for (const n of document.querySelectorAll(`.switcher strong, strong.topbar-business, option[value="${mine.id}"]`)) n.textContent = mine.name;
          document.title = `${mine.name} · Dashboard`;
          toast("Profile saved.");
        }),
    },
    "Save changes",
  );
  saveBar.replaceChildren(h("span", { class: "muted", text: "You have unsaved changes." }), h("button", { class: "btn btn-ghost", type: "button", onclick: () => renderProfile(view, params, ++S.ticket) }, "Discard"), save);

  view.replaceChildren(
    pageHead("Business profile", "What customers see about your business", p.verification === "verified" ? h("span", { class: "badge good" }, "Verified by our team") : h("span", { class: "badge warn" }, "Not verified yet")),
    h(
      "div",
      { class: "grid" },
      h(
        "section",
        { class: "card form-card" },
        h("h2", { text: "About the business" }),
        h("p", { text: "Your name and a short description appear on your card in our replies." }),
        h(
          "div",
          { class: "form-grid" },
          field("Business name", input("name", { maxlength: 80 })),
          field("Description", h("textarea", { class: "textarea", maxlength: 300, value: f.description ?? "", oninput: (e) => ((f.description = e.target.value), changed()) }), "What you sell, brands you carry, services you offer."),
          field("Other words customers use", input("keywords", { maxlength: 200, placeholder: "e.g. fridge, refrigerator, freezer, deep freezer" }), "Helps us find you when people use different words."),
          categoryPicker(f.categories, changed),
        ),
      ),
      h(
        "section",
        { class: "card form-card" },
        h("h2", { text: "Where and when" }),
        h("p", { text: "Customers are shown the businesses nearest to them first." }),
        h(
          "div",
          { class: "form-grid" },
          h("div", { class: "form-row" }, field("Area", area), field("Street address", input("address", { maxlength: 200, placeholder: "e.g. Shop 4, Avondale Shopping Centre" }))),
          h("div", { class: "field" }, h("span", { class: "label", text: "Map pin" }), h("div", { style: "display:flex;gap:10px;align-items:center;flex-wrap:wrap" }, pinButton, pinNote)),
          field("Opening hours", input("hours", { maxlength: 120, placeholder: "e.g. Mon to Sat, 8am to 5pm" })),
          h("div", { class: "field" }, h("span", { class: "label", text: "Who you sell to" }), trade),
        ),
      ),
      h(
        "section",
        { class: "card form-card" },
        h("h2", { text: "Contact" }),
        h("p", { text: "Customers reach you on WhatsApp at this number." }),
        h(
          "div",
          { class: "form-grid" },
          field("WhatsApp number", input("phone", { inputmode: "tel", disabled: p.verification === "verified" }), p.verification === "verified" ? "This business is verified, so our team changes its number: message us on WhatsApp." : null),
          h("div", { class: "form-row" }, field("Email", input("email", { type: "email", maxlength: 200 })), field("Website", input("website", { maxlength: 200 }))),
        ),
      ),
      h("section", { class: "card form-card" }, h("h2", { text: "Photos" }), h("p", { text: "Up to eight photos of your shopfront and inside. Product photos are on each product." }), gallery),
    ),
    saveBar,
  );
  window.onbeforeunload = () => (dirty ? "You have unsaved changes." : undefined);
  S.cleanup.push(() => (window.onbeforeunload = null));
}

// ---------- Start ----------

window.addEventListener("hashchange", () => {
  if (S.me && S.options && business()) renderRoute();
});

async function boot() {
  // Sign-in links carry the token after "#" (never sent to a server); older ones had "?signin=".
  const fromHash = location.hash.startsWith("#signin=") ? new URLSearchParams(location.hash.slice(1)).get("signin") : null;
  const token = fromHash || new URLSearchParams(location.search).get("signin");
  if (token) {
    history.replaceState(null, "", fromHash ? "/app/" : `/app/${location.hash}`);
    showSigningIn();
    try {
      await api("POST", "/auth/exchange", { token });
    } catch (err) {
      return showSignIn(err.message);
    }
  }
  try {
    S.me = await api("GET", "/me");
    if (!S.me.businesses.length) return showNoBusiness();
    S.options = await api("GET", "/options");
  } catch (err) {
    if (err.status === 401) return; // the sign-in page is showing
    root.replaceChildren(
      h(
        "div",
        { class: "auth" },
        h(
          "div",
          { class: "card auth-card" },
          h("h1", { text: "We couldn't load your dashboard" }),
          h("p", { class: "notice bad", text: err.message }),
          h("button", { class: "btn btn-lg", type: "button", onclick: () => location.reload() }, "Try again"),
        ),
      ),
    );
    return;
  }
  const saved = store.get("dz.business");
  S.businessId = S.me.businesses.some((b) => b.id === saved) ? saved : S.me.businesses[0].id;
  renderShell();
}

boot();
