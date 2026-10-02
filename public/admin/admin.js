// The admin portal: the team's view of everything on the service. Team members sign in with their own
// account (email and password), never the WhatsApp links business owners use. Staff handle chats,
// reports and listings; admins also manage field agents, the team, and people's data.

import {
  ago,
  ApiError,
  busy,
  closeAllSheets,
  confirmDialog,
  dateTime,
  h,
  icon,
  money,
  num,
  openSheet,
  phoneLabel,
  present,
  promptDialog,
  saveFile,
  shortDate,
  store,
  toast,
} from "/assets/ui.js";
import { insightScreens } from "/admin/insights.js";

const TOKEN_KEY = "ops.token"; // the same key as the first console, so a session carries over
const root = document.getElementById("root");
const S = { me: null, counts: {}, categories: null, brand: null, ticket: 0, cleanup: [] };
const isAdmin = () => S.me?.role === "admin";
const stale = (ticket) => ticket !== S.ticket;

// ---------- The API ----------

function errorText(data, status) {
  if (typeof data?.error === "string") return data.error;
  if (Array.isArray(data?.error)) return data.error.map((i) => i.message ?? String(i)).join("; ");
  return `Something went wrong (${status}).`;
}

async function api(method, path, body) {
  const token = store.get(TOKEN_KEY);
  let res;
  try {
    res = await fetch(`/ops/api${path}`, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError("We couldn't reach the server. Check your connection and try again.", 0);
  }
  const data = (res.headers.get("content-type") ?? "").includes("json") ? await res.json() : await res.blob();
  if (res.status === 401 && path !== "/login") {
    showLogin(token ? "Your session has ended. Please sign in again." : "");
    throw new ApiError("Please sign in", 401);
  }
  if (!res.ok) throw new ApiError(errorText(data, res.status), res.status);
  return data;
}
const get = (path) => api("GET", path);
const post = (path, body) => api("POST", path, body ?? {});
const del = (path) => api("DELETE", path);
const qs = (params) => new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== "")).toString();

async function categories() {
  S.categories ??= await get("/categories");
  return S.categories;
}
const categoryName = (slug) => S.categories?.find((c) => c.slug === slug)?.name ?? slug ?? "";

/** Photos are private: they're fetched with the team's session, then shown from memory. */
async function showPhoto(img, id) {
  try {
    img.src = URL.createObjectURL(await get(`/photos/${id}`));
  } catch {
    img.alt = "Photo not available";
  }
}

// ---------- Small pieces ----------

function pageHead(title, lead, ...actions) {
  return h(
    "div",
    { class: "page-head" },
    h("div", {}, h("h1", { text: title }), lead ? h("p", { class: "lead", text: lead }) : null),
    actions.length ? h("div", { class: "actions" }, actions) : null,
  );
}

const badge = (text, kind = "") => h("span", { class: `badge ${kind}`, text });
/** "1 business", "3 businesses". */
const plural = (n, one, many) => `${num(n)} ${n === 1 ? one : many}`;
const verificationBadge = (v) => (v === "verified" ? badge("Verified", "good") : badge("Not verified yet", "warn"));
const statusBadge = (s) => (s === "active" ? null : badge(s === "paused" ? "Paused" : s === "removed" ? "Removed" : s, s === "removed" ? "bad" : "warn"));
const phoneLink = (digits) => (digits ? h("a", { href: `tel:+${digits}`, text: phoneLabel(digits) }) : h("span", { class: "muted", text: "not given" }));
/** "+263 77 ••• 4567": enough to tell customers apart without showing their number. */
const maskedPhone = (digits) => (/^263\d{9}$/.test(String(digits)) ? `+263 ${String(digits).slice(3, 5)} ••• ${String(digits).slice(-4)}` : "");

function field(label, control, hint) {
  control.id ||= `f-${Math.random().toString(36).slice(2, 8)}`;
  return h("div", { class: "field" }, h("label", { for: control.id, text: label }), control, hint ? h("span", { class: "hint", text: hint }) : null);
}

function selectOf(options, value, onchange, attrs = {}) {
  return h("select", { class: "select", value: value ?? "", onchange, ...attrs }, options.map(([v, label]) => h("option", { value: v }, label)));
}

function segmented(options, value, onpick, label) {
  return h(
    "div",
    { class: "segmented", role: "group", "aria-label": label },
    options.map(([v, text]) => h("button", { type: "button", "aria-pressed": String(v === value), onclick: () => onpick(v) }, text)),
  );
}

function categorySelect(list, placeholder = "Choose a category…") {
  return h(
    "select",
    { class: "select" },
    h("option", { value: "" }, placeholder),
    list.filter((c) => c.risk !== "blocked").map((c) => h("option", { value: c.slug }, `${c.group_name} › ${c.name}${c.risk === "normal" ? "" : ` (${c.risk})`}`)),
  );
}

/**
 * A table that turns into one card per row on phones. Columns: { label, key, render, num, wrap }.
 * `onRow` makes each row open something (a business, usually).
 */
function table(columns, rows, { empty = "Nothing here.", onRow } = {}) {
  if (!rows.length) return h("div", { class: "card" }, h("div", { class: "empty" }, h("p", { text: empty })));
  return h(
    "div",
    { class: "card table-card scroll" },
    h(
      "table",
      { class: "table stack" },
      h("thead", {}, h("tr", {}, columns.map((c) => h("th", { class: c.num ? "num" : null, text: c.label })))),
      h(
        "tbody",
        {},
        rows.map((r) =>
          h(
            "tr",
            { style: onRow ? "cursor:pointer" : null, onclick: onRow ? (e) => !e.target.closest("button, a, select, input, textarea, label") && onRow(r) : null },
            columns.map((c) =>
              h(
                "td",
                { class: [c.num ? "num" : "", c.wrap ? "wrap" : "", c.label ? "" : "no-label"].join(" ").trim() || null, "data-label": c.label || null },
                c.render ? c.render(r) : (r[c.key] ?? ""),
              ),
            ),
          ),
        ),
      ),
    ),
  );
}

function kpi(label, value, foot, { href, alert } = {}) {
  return h(
    href ? "a" : "div",
    { class: `card kpi${alert ? " alert" : ""}`, href },
    h("span", { class: "kpi-label", text: label }),
    h("span", { class: "kpi-value", text: value }),
    foot ? h("span", { class: "kpi-foot", text: foot }) : null,
  );
}

function panel(title, lead, ...body) {
  return h("section", { class: "card panel section-gap" }, h("div", { class: "panel-head" }, h("div", {}, h("h2", { text: title }), lead ? h("p", { text: lead }) : null)), body);
}

const days = (params, fallback = 30) => ([7, 30, 90].includes(Number(params.get("days"))) ? Number(params.get("days")) : fallback);
const go = (name, params = {}) => {
  const query = qs(params);
  location.hash = `#/${name}${query ? `?${query}` : ""}`;
};

const stopCharts = () => {
  for (const fn of S.cleanup.splice(0)) fn();
};

// ---------- Signing in ----------

async function brand() {
  S.brand ??= await fetch("/app/api/public/options")
    .then((r) => r.json())
    .then((o) => o.brand)
    .catch(() => "");
  return S.brand;
}

function brandmark(name) {
  return h("a", { class: "brandmark", href: "#/overview" }, h("img", { src: "/assets/logo.svg", alt: "" }), name, h("span", { class: "admin-tag", text: "Admin" }));
}

async function showLogin(message) {
  S.me = null;
  closeAllSheets();
  stopCharts();
  document.title = "Sign in · Admin";
  const name = await brand();
  const status = h("p", { class: "notice bad", hidden: !message, role: "alert" }, message ?? "");
  const email = h("input", { class: "input", type: "email", autocomplete: "username", required: true });
  const password = h("input", { class: "input", type: "password", autocomplete: "current-password", required: true });
  const submit = h("button", { class: "btn btn-lg", type: "submit" }, "Sign in");
  const token = h("input", { class: "input", type: "password", autocomplete: "off", placeholder: "OPS_TOKEN" });
  const fail = (err) => {
    status.textContent = err.message;
    status.hidden = false;
  };
  root.replaceChildren(
    h(
      "div",
      { class: "auth" },
      h(
        "div",
        { class: "card auth-card" },
        brandmark(name),
        h("h1", { text: "Team sign-in" }),
        h("p", { class: "muted", text: "For the people who run the service. Businesses sign in with the link we send them on WhatsApp instead." }),
        status,
        h(
          "form",
          {
            onsubmit: async (e) => {
              e.preventDefault();
              submit.classList.add("is-busy");
              try {
                const r = await post("/login", { email: email.value, password: password.value });
                store.set(TOKEN_KEY, r.token);
                await boot();
              } catch (err) {
                fail(err);
              } finally {
                submit.classList.remove("is-busy");
              }
            },
          },
          field("Email", email),
          field("Password", password),
          submit,
        ),
        h(
          "details",
          {},
          h("summary", { text: "Use the ops token instead" }),
          h("p", { text: "For setting up the first accounts, or for scripts. Everything done this way is recorded as \"ops token\"." }),
          h(
            "form",
            {
              onsubmit: async (e) => {
                e.preventDefault();
                store.set(TOKEN_KEY, token.value.trim());
                await boot();
              },
            },
            token,
            h("button", { class: "btn btn-secondary", type: "submit" }, "Continue"),
          ),
        ),
      ),
      h("p", { class: "muted", style: "font-size:13px", text: "Forgotten your password? An admin can give you a new one." }),
    ),
  );
}

async function signOut() {
  await post("/logout").catch(() => {});
  store.set(TOKEN_KEY, "");
  showLogin("");
}

// ---------- The shell ----------

const NAV = [
  { items: [{ key: "overview", label: "Overview", icon: "overview" }] },
  {
    group: "Analytics",
    items: [
      { key: "demand", label: "Demand", icon: "insights" },
      { key: "supply", label: "Supply", icon: "products" },
      { key: "experience", label: "Customer experience", icon: "user" },
    ],
  },
  {
    group: "Customers",
    items: [
      { key: "chats", label: "Live chats", icon: "chat", count: "open_handoffs", hot: true },
      { key: "reports", label: "Reports", icon: "flag", count: "open_reports", hot: true },
      { key: "people", label: "People", icon: "customers" },
    ],
  },
  {
    group: "Businesses",
    items: [
      { key: "businesses", label: "All businesses", icon: "profile" },
      { key: "verify", label: "To verify", icon: "shield", count: "to_verify" },
      { key: "signups", label: "Website sign-ups", icon: "inbox", count: "web_registrations_pending" },
      { key: "callbacks", label: "Call-backs", icon: "phone" },
      { key: "rechecks", label: "Re-checks", icon: "refresh" },
      { key: "tips", label: "Customer tips", icon: "bulb", count: "new_recommendations" },
    ],
  },
  {
    group: "Demand",
    items: [
      { key: "requests", label: "Requests", icon: "list" },
      { key: "gaps", label: "Supply gaps", icon: "target" },
    ],
  },
  {
    group: "Understanding",
    items: [
      { key: "vocabulary", label: "Vocabulary", icon: "book" },
      { key: "words", label: "Word list", icon: "edit" },
      { key: "check", label: "Check answers", icon: "checkCircle" },
      { key: "label", label: "Label requests", icon: "tag" },
    ],
  },
  {
    group: "Team",
    items: [
      { key: "agents", label: "Field agents", icon: "userPlus", admin: true },
      { key: "team", label: "Team accounts", icon: "key", admin: true },
      { key: "activity", label: "Activity log", icon: "activity", admin: true },
    ],
  },
  { group: "System", items: [{ key: "system", label: "Health and costs", icon: "server" }] },
];
const ADMIN_ONLY = new Set(NAV.flatMap((g) => g.items).filter((i) => i.admin).map((i) => i.key));

function closeNav() {
  document.querySelector(".shell.admin")?.classList.remove("nav-open");
}

function renderShell() {
  const initials = (S.me.name || "?")
    .split(/\s+/)
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  const nav = h(
    "nav",
    { class: "nav", "aria-label": "Admin" },
    NAV.map((g) => {
      const items = g.items.filter((i) => !i.admin || isAdmin());
      if (!items.length) return null;
      return [
        g.group ? h("div", { class: "nav-group", text: g.group }) : null,
        items.map((i) =>
          h(
            "a",
            { href: `#/${i.key}`, onclick: closeNav },
            icon(i.icon),
            h("span", { text: i.label }),
            i.count ? h("span", { class: `count${i.hot ? " hot" : ""}`, "data-count": i.count, hidden: true }) : null,
          ),
        ),
      ];
    }),
  );
  root.replaceChildren(
    h(
      "div",
      { class: "shell admin" },
      h(
        "aside",
        { class: "sidebar" },
        brandmark(S.brand),
        nav,
        h(
          "div",
          { class: "sidebar-foot" },
          h(
            "a",
            { class: "user-card", href: "#/account", onclick: closeNav },
            h("span", { class: "avatar", text: initials }),
            h("span", {}, h("strong", { text: S.me.name }), h("small", { text: S.me.role === "admin" ? "Admin" : "Staff" })),
          ),
          h("button", { class: "btn btn-ghost btn-sm", type: "button", style: "justify-content:flex-start", onclick: signOut }, icon("out"), "Sign out"),
        ),
      ),
      h("div", { class: "nav-scrim", onclick: closeNav }),
      h(
        "div",
        { class: "main" },
        h(
          "header",
          { class: "topbar" },
          h(
            "button",
            {
              class: "btn btn-ghost btn-icon btn-sm menu-btn",
              type: "button",
              "aria-label": "Menu",
              onclick: () => document.querySelector(".shell.admin").classList.add("nav-open"),
            },
            icon("menu"),
          ),
          h("strong", { class: "topbar-business", text: "Admin" }),
          h("span", { class: "spacer" }),
        ),
        h("main", { class: "view", id: "view" }),
      ),
    ),
  );
  renderRoute();
}

function updateBadges() {
  for (const el of document.querySelectorAll("[data-count]")) {
    const n = S.counts?.[el.dataset.count] ?? 0;
    el.textContent = num(n);
    el.hidden = !n;
  }
}

async function refreshCounts() {
  try {
    S.counts = await get("/summary");
    updateBadges();
  } catch {
    /* the page itself shows what went wrong */
  }
}

function route() {
  const [name, query] = location.hash.replace(/^#\/?/, "").split("?");
  const known = SCREENS[name] && (!ADMIN_ONLY.has(name) || isAdmin());
  return { name: known ? name : "overview", params: new URLSearchParams(query ?? "") };
}

/** The analytics pages: a wider canvas, and filter changes that keep the page in view while it updates. */
const REPORTS = new Set(["overview", "demand", "supply", "experience"]);
let shownRoute = null;

async function renderRoute({ keepScroll = false, dim = false } = {}) {
  const view = document.getElementById("view");
  if (!view) return;
  stopCharts();
  const r = route();
  shownRoute = r.name;
  const ticket = ++S.ticket;
  view.classList.toggle("wide", REPORTS.has(r.name));
  view.classList.toggle("is-loading", dim);
  for (const a of document.querySelectorAll(".nav a")) a.setAttribute("aria-current", a.getAttribute("href") === `#/${r.name}` ? "page" : "false");
  if (!keepScroll) {
    view.replaceChildren(h("div", { class: "skeleton", style: "height:120px;margin-bottom:16px" }), h("div", { class: "skeleton", style: "height:320px" }));
    window.scrollTo(0, 0);
  }
  try {
    const nodes = await SCREENS[r.name](r.params, ticket);
    if (stale(ticket)) return;
    const y = window.scrollY;
    view.replaceChildren(...present([nodes]));
    if (keepScroll) window.scrollTo(0, y);
    document.title = `${NAV.flatMap((g) => g.items).find((i) => i.key === r.name)?.label ?? "Account"} · Admin`;
  } catch (err) {
    if (err.status === 401 || stale(ticket)) return;
    view.replaceChildren(pageHead("Something went wrong"), h("p", { class: "notice bad", text: err.message }));
  } finally {
    if (!stale(ticket)) view.classList.remove("is-loading");
  }
  if (r.name !== "overview") refreshCounts();
}

/** Show the same page again with fresh data, where the person was. */
const refresh = () => renderRoute({ keepScroll: true });

// ---------- Customers ----------

function windowLeft(closesAt) {
  const ms = closesAt ? new Date(closesAt).getTime() - Date.now() : 0;
  if (ms <= 0) return null;
  const hours = Math.floor(ms / 3600_000);
  return `${hours ? `${hours}h ` : ""}${Math.floor((ms % 3600_000) / 60_000)}m left`;
}

async function chats() {
  const [list, cats] = await Promise.all([get("/handoffs"), categories()]);
  return [
    pageHead(
      "Live chats",
      "Customers waiting for a person: they asked for one, we had nobody for them, or we couldn't understand them. Replies go out on our WhatsApp number. Tell the assistant what they wanted, and it answers that wording itself next time.",
    ),
    list.length ? h("div", { class: "grid" }, list.map((c) => chatCard(c, cats))) : h("p", { class: "notice", text: "No one is waiting for a person." }),
  ];
}

function chatCard(chat, cats) {
  const left = windowLeft(chat.window_closes_at);
  const text = h("textarea", {
    class: "textarea",
    placeholder: left ? "Reply as the team…" : "Their 24-hour window has closed: WhatsApp won't deliver a reply until they message us again.",
    disabled: !left,
  });
  const request = chat.request;
  const wanted = categorySelect(cats, "What were they looking for?");
  if (request?.category_slug) wanted.value = request.category_slug;
  const reading = request?.reading;
  const readingText = reading
    ? `The assistant's reading: ${reading.candidates?.length ? `could be ${reading.candidates.map(categoryName).join(" or ")}` : "no category recognised"}${
        reading.unknown?.length ? `; words it didn't know: ${reading.unknown.join(", ")}` : ""
      }.`
    : "";
  const messages = (chat.recent_messages || []).map((m) => {
    const body = m.body || {};
    const notes = m.notes || {};
    const content =
      m.direction === "out"
        ? body.text || body.message?.text || body.message?.body || "[a message]"
        : body.text || body.title || (notes.transcript ? `Voice note: ${notes.transcript}` : body.type === "image" ? `Photo: ${body.caption || notes.seen || ""}` : body.type ? `[${body.type}]` : "");
    return h("div", { class: `bubble ${m.direction === "out" ? "out" : "in"}` }, content, h("small", { text: dateTime(m.created_at) }));
  });
  return h(
    "article",
    { class: "card chat-card" },
    h(
      "div",
      { class: "chat-head" },
      h("strong", { text: chat.profile_name || "Customer" }),
      chat.channel === "business" ? badge("Business") : null,
      h("span", { class: "muted", text: `${phoneLabel(chat.wa_id)} · waiting since ${dateTime(chat.updated_at)}` }),
      h("span", { class: "spacer", style: "flex:1" }),
      left ? badge(`Reply window: ${left}`, "good") : badge("Window closed", "warn"),
    ),
    h("div", { class: "chat-log" }, messages.length ? messages : h("span", { class: "muted", text: "No messages kept." })),
    request?.raw_text
      ? h(
          "div",
          { class: "teach" },
          h("span", {}, h("strong", { text: "Their request: " }), request.raw_text),
          readingText ? h("span", { class: "muted", text: readingText }) : null,
          h(
            "div",
            { class: "cell-actions" },
            wanted,
            h(
              "button",
              {
                class: "btn btn-secondary btn-sm",
                type: "button",
                onclick: (e) =>
                  busy(e.currentTarget, async () => {
                    if (!wanted.value) throw new Error("Choose what they were looking for.");
                    await post(`/requests/${request.id}/teach`, { category: wanted.value });
                    toast(`Saved. The assistant reads this wording as ${categoryName(wanted.value)} from now on.`);
                  }),
              },
              "Teach the assistant",
            ),
          ),
        )
      : null,
    text,
    h(
      "div",
      { class: "cell-actions" },
      h(
        "button",
        {
          class: "btn",
          type: "button",
          disabled: !left,
          onclick: (e) =>
            busy(e.currentTarget, async () => {
              if (!text.value.trim()) throw new Error("Write a reply first.");
              await post(`/contacts/${chat.contact_id}/reply`, { text: text.value.trim() });
              toast("Reply sent.");
              refresh();
            }),
        },
        "Send reply",
      ),
      h(
        "button",
        {
          class: "btn btn-secondary",
          type: "button",
          onclick: (e) =>
            busy(e.currentTarget, async () => {
              await post(`/contacts/${chat.contact_id}/release`);
              toast("Handed back to the assistant.");
              refresh();
            }),
        },
        "Hand back to the assistant",
      ),
      h(
        "button",
        {
          class: "btn btn-danger",
          type: "button",
          onclick: async (e) => {
            const button = e.currentTarget;
            const reason = await promptDialog({ title: "Block this number?", body: "Say why. It's kept for the record.", ok: "Block", danger: true });
            if (reason === null) return;
            await busy(button, async () => {
              await post(`/contacts/${chat.contact_id}/block`, { blocked: true, reason: reason || undefined });
              await post(`/contacts/${chat.contact_id}/release`);
              toast("Number blocked.");
              refresh();
            });
          },
        },
        "Block number",
      ),
    ),
  );
}

async function reports() {
  const rows = await get("/reports");
  const setStatus = (r, status) => post(`/reports/${r.id}/status`, { status });
  return [
    pageHead("Reports", "Customers' complaints about businesses, oldest waiting at the bottom."),
    table(
      [
        { label: "When", render: (r) => dateTime(r.created_at) },
        {
          label: "Business",
          render: (r) =>
            h(
              "div",
              { class: "stack-sm" },
              h("a", { href: "#", onclick: (e) => (e.preventDefault(), openBusiness(r.business_id)), text: r.business }),
              h("div", { class: "badges" }, verificationBadge(r.verification), statusBadge(r.business_status)),
            ),
        },
        {
          label: "What happened",
          wrap: true,
          render: (r) => h("div", { class: "stack-sm" }, h("span", { text: r.reason }), r.had_introduction ? badge("They contacted them through us", "plain") : null),
        },
        {
          label: "",
          render: (r) =>
            h(
              "div",
              { class: "cell-actions" },
              h(
                "button",
                {
                  class: "btn btn-secondary btn-sm",
                  type: "button",
                  onclick: (e) =>
                    busy(e.currentTarget, async () => {
                      await setStatus(r, "reviewed");
                      toast("Marked reviewed.");
                      refresh();
                    }),
                },
                "Reviewed",
              ),
              h(
                "button",
                {
                  class: "btn btn-danger btn-sm",
                  type: "button",
                  onclick: (e) =>
                    busy(e.currentTarget, async () => {
                      await post(`/businesses/${r.business_id}/status`, { status: "paused" });
                      await setStatus(r, "actioned");
                      toast(`${r.business} is paused.`);
                      refresh();
                    }),
                },
                "Pause business",
              ),
            ),
        },
      ],
      rows,
      { empty: "No open reports." },
    ),
  ];
}

async function people(params) {
  const phone = h("input", { class: "input", type: "search", placeholder: "Phone number, e.g. 0771 234 567", value: params.get("phone") ?? "" });
  const nodes = [
    pageHead("People", "Find anyone who has messaged our number. Block abusive numbers. Admins can export or delete someone's data when they ask."),
    h(
      "form",
      {
        class: "filters",
        onsubmit: (e) => {
          e.preventDefault();
          go("people", { phone: phone.value.trim() });
        },
      },
      h("div", { class: "search" }, icon("search"), phone),
      h("button", { class: "btn", type: "submit" }, "Find"),
    ),
  ];
  if (!params.get("phone")) return nodes;
  const rows = await get(`/contacts?${qs({ phone: params.get("phone") })}`);
  return [...nodes, rows.length ? h("div", { class: "grid" }, rows.map(contactCard)) : h("p", { class: "notice", text: "Nobody with that number has messaged us." })];
}

function contactCard(c) {
  const facts = [
    phoneLabel(c.wa_id),
    `first message ${shortDate(c.created_at)}`,
    c.last_inbound_at ? `last ${dateTime(c.last_inbound_at)}` : null,
    `${num(c.messages)} messages`,
    `${num(c.requests)} requests`,
    c.businesses ? `${num(c.businesses)} listings` : null,
    c.consent_at ? "agreed to the privacy notice" : "hasn't agreed to the privacy notice",
  ].filter(Boolean);
  return h(
    "article",
    { class: "card panel" },
    h("div", { class: "chat-head" }, h("strong", { text: c.profile_name || "(no name)" }), badge(c.channel === "customer" ? "Customer" : "Business"), c.is_blocked ? badge("Blocked", "bad") : null),
    h("p", { class: "muted", text: facts.join(" · ") }),
    c.blocked_reason ? h("p", { class: "muted", text: `Blocked: ${c.blocked_reason}` }) : null,
    h(
      "div",
      { class: "cell-actions" },
      h(
        "button",
        {
          class: "btn btn-secondary btn-sm",
          type: "button",
          onclick: async (e) => {
            const button = e.currentTarget;
            let reason;
            if (!c.is_blocked) {
              reason = await promptDialog({ title: "Block this number?", body: "Say why. It's kept for the record.", ok: "Block", danger: true });
              if (reason === null) return;
            }
            await busy(button, async () => {
              await post(`/contacts/${c.id}/block`, { blocked: !c.is_blocked, reason: reason || undefined });
              toast(c.is_blocked ? "Unblocked." : "Blocked.");
              refresh();
            });
          },
        },
        c.is_blocked ? "Unblock" : "Block",
      ),
      isAdmin()
        ? h(
            "button",
            {
              class: "btn btn-secondary btn-sm",
              type: "button",
              onclick: (e) =>
                busy(e.currentTarget, async () => {
                  const data = await get(`/contacts/${c.id}/export`);
                  saveFile(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }), `contact-${c.wa_id}.json`);
                }),
            },
            icon("download"),
            "Export their data",
          )
        : null,
      isAdmin()
        ? h(
            "button",
            {
              class: "btn btn-danger btn-sm",
              type: "button",
              onclick: async (e) => {
                const button = e.currentTarget;
                const ok = await confirmDialog({
                  title: `Delete everything about ${phoneLabel(c.wa_id)}?`,
                  body: "Their messages, requests and ratings are deleted for good. Businesses they own stay listed. Only do this when they ask.",
                  ok: "Delete their data",
                  danger: true,
                });
                if (!ok) return;
                await busy(button, async () => {
                  const r = await post(`/contacts/${c.id}/erase`);
                  toast(`Deleted ${num(r.messages)} messages and ${num(r.requests)} requests.`);
                  refresh();
                });
              },
            },
            "Delete their data",
          )
        : null,
    ),
  );
}

// ---------- Businesses ----------

const SOURCES = { self: "Signed up themselves", field: "Field agent", import: "Imported", seed: "Sample" };

async function businesses(params) {
  const q = params.get("q") ?? "";
  const filters = { q, verification: params.get("verification") ?? "", status: params.get("status") ?? "", source: params.get("source") ?? "" };
  const rows = await get(`/businesses?${qs({ ...filters, limit: 200 })}`);
  const search = h("input", { class: "input", type: "search", placeholder: "Name or phone", value: q });
  const change = (key) => (e) => go("businesses", { ...filters, q: search.value.trim(), [key]: e.target.value });
  return [
    pageHead("All businesses", "Every listing, newest first. Open one to see its owner, catalogue and photos, or to change it."),
    h(
      "form",
      {
        class: "filters",
        onsubmit: (e) => {
          e.preventDefault();
          go("businesses", { ...filters, q: search.value.trim() });
        },
      },
      h("div", { class: "search" }, icon("search"), search),
      selectOf(
        [
          ["", "Verified or not"],
          ["verified", "Verified"],
          ["registered", "Not verified yet"],
        ],
        filters.verification,
        change("verification"),
        { "aria-label": "Verification" },
      ),
      selectOf(
        [
          ["", "Any status"],
          ["active", "Live"],
          ["paused", "Paused"],
          ["removed", "Removed"],
        ],
        filters.status,
        change("status"),
        { "aria-label": "Status" },
      ),
      selectOf([["", "Any source"], ...Object.entries(SOURCES)], filters.source, change("source"), { "aria-label": "Source" }),
    ),
    table(
      [
        { label: "Business", render: (r) => h("div", { class: "stack-sm" }, h("strong", { text: r.name }), r.agent ? h("small", { class: "muted", text: `by ${r.agent}` }) : null) },
        { label: "Phone", render: (r) => phoneLabel(r.phone) },
        { label: "Area", key: "area" },
        {
          label: "Status",
          render: (r) =>
            h(
              "div",
              { class: "badges" },
              verificationBadge(r.verification),
              statusBadge(r.status),
              r.audit_status ? badge(`Call-back ${r.audit_status}`, r.audit_status === "failed" ? "bad" : "good") : null,
            ),
        },
        { label: "Products", num: true, render: (r) => (r.products ? num(r.products) : "–") },
        { label: "Source", render: (r) => SOURCES[r.source] ?? r.source },
        { label: "Added", render: (r) => shortDate(r.created_at) },
      ],
      rows,
      { empty: "No businesses match.", onRow: (r) => openBusiness(r.id) },
    ),
  ];
}

/** Everything about one business, in a drawer: owner, catalogue, photos, track record, and actions. */
async function openBusiness(id) {
  const sheet = openSheet({ kind: "drawer", title: "Business", body: h("div", { class: "skeleton", style: "height:300px" }) });
  const draw = async () => {
    let b;
    try {
      b = await get(`/businesses/${id}`);
    } catch (err) {
      if (err.status !== 401) sheet.setBody(h("p", { class: "notice bad", text: err.message }));
      return;
    }
    await categories();
    sheet.setTitle(b.name);
    const reload = async () => {
      await draw();
      refresh();
    };
    const checks = Object.entries(b.checks || {}).map(([k, v]) => `${k === "premisesSeen" ? "premises seen" : k === "idChecked" ? "ID checked" : k}: ${v ? "yes" : "no"}`);
    sheet.setBody(
      h(
        "div",
        { class: "badges" },
        verificationBadge(b.verification),
        statusBadge(b.status) ?? badge("Live", "good"),
        badge(SOURCES[b.source] ?? b.source, "plain"),
        badge({ retail: "Sells to the public", wholesale: "Wholesale", both: "Retail and wholesale" }[b.trade] ?? b.trade, "plain"),
      ),
      h(
        "dl",
        { class: "kv" },
        [
          ["Phone", phoneLink(b.phone)],
          ["Area", b.area ?? "–"],
          ["Address", b.address || "–"],
          ["Hours", b.hours || "–"],
          ["Categories", b.categories.map(categoryName).join(", ") || "–"],
          ["What they do", b.description || "–"],
          ["Email", b.email || "–"],
          ["Website", b.website || "–"],
          ["Added", `${dateTime(b.created_at)}${b.verified_at ? ` · verified ${shortDate(b.verified_at)}${b.verified_by ? ` by ${b.verified_by}` : ""}` : ""}`],
          checks.length ? ["Checks", checks.join(" · ")] : null,
        ]
          .filter(Boolean)
          .map(([k, v]) => [h("dt", { text: k }), h("dd", {}, v)]),
      ),
      ownerSection(b, reload),
      catalogueSection(b),
      photoSection(b, reload),
      recordSection(b),
    );
    const setStatus = (status, message) =>
      busy(null, async () => {
        await post(`/businesses/${b.id}/status`, { status });
        toast(message);
        await reload();
      });
    sheet.setFoot(
      b.status !== "active"
        ? h("button", { class: "btn btn-secondary", type: "button", onclick: () => setStatus("active", `${b.name} is live.`) }, "Make live")
        : h("button", { class: "btn btn-secondary", type: "button", onclick: () => setStatus("paused", `${b.name} is paused.`) }, "Pause"),
      b.verification !== "verified"
        ? h(
            "button",
            {
              class: "btn",
              type: "button",
              onclick: (e) =>
                busy(e.currentTarget, async () => {
                  await post(`/businesses/${b.id}/verify`);
                  toast(`${b.name} is verified.`);
                  await reload();
                }),
            },
            icon("shield"),
            "Mark verified",
          )
        : null,
      selectOf(
        [
          ["retail", "Sells to the public"],
          ["wholesale", "Sells to businesses"],
          ["both", "Sells to both"],
        ],
        b.trade,
        (e) =>
          busy(null, async () => {
            await post(`/businesses/${b.id}/trade`, { trade: e.target.value });
            toast("Saved.");
            await reload();
          }),
        { "aria-label": "Who they sell to", style: "width:auto" },
      ),
      h("span", { class: "spacer" }),
      isAdmin() && b.status !== "removed"
        ? h(
            "button",
            {
              class: "btn btn-danger",
              type: "button",
              onclick: async () => {
                if (await confirmDialog({ title: `Remove ${b.name}?`, body: "Customers won't see it. It stays in the records, and can be made live again.", ok: "Remove", danger: true })) {
                  setStatus("removed", `${b.name} is removed.`);
                }
              },
            },
            "Remove",
          )
        : null,
      isAdmin()
        ? h(
            "button",
            {
              class: "btn btn-danger",
              type: "button",
              onclick: async () => {
                const ok = await confirmDialog({
                  title: `Delete ${b.name} completely?`,
                  body: "Its photos, products and history go for good. Only do this when the owner asks us to forget them.",
                  ok: "Delete completely",
                  danger: true,
                });
                if (!ok) return;
                await busy(null, async () => {
                  await post(`/businesses/${b.id}/erase`);
                  toast(`${b.name} is deleted.`);
                  sheet.close();
                  refresh();
                });
              },
            },
            icon("trash"),
            "Delete",
          )
        : null,
    );
  };
  await draw();
}

function ownerSection(b, reload) {
  const o = b.owner;
  // A one-time link for the owner, handed over by the team: before launch, or when WhatsApp can't reach them.
  const linkBox = h("div");
  const linkButton = isAdmin()
    ? h(
        "div",
        {},
        h(
          "button",
          {
            class: "btn btn-secondary btn-sm",
            type: "button",
            onclick: (e) =>
              busy(e.currentTarget, async () => {
                const r = await post(`/businesses/${b.id}/owner/link`);
                linkBox.replaceChildren(
                  secretBox(
                    "Dashboard sign-in link",
                    r.url,
                    `Give it only to the owner of ${b.name}. It works once, until ${dateTime(r.expiresAt)}, and signs them in as the owner of this business.`,
                  ),
                );
              }),
          },
          "Dashboard link for the owner",
        ),
      )
    : null;
  return h(
    "section",
    { class: "detail-section" },
    h("h3", { text: "Owner" }),
    o
      ? [
          h(
            "dl",
            { class: "kv" },
            h("dt", { text: "WhatsApp" }),
            h("dd", {}, phoneLink(o.wa_id), o.profile_name ? ` · ${o.profile_name}` : "", o.is_blocked ? [" ", badge("Blocked", "bad")] : null),
            h("dt", { text: "Last message" }),
            h("dd", { text: o.last_inbound_at ? dateTime(o.last_inbound_at) : "never" }),
            h("dt", { text: "Dashboard" }),
            // Sessions are kept only while they last, so this says what's true now, not a full history.
            h(
              "dd",
              {},
              o.dashboard_sessions
                ? `Signed in ${ago(o.last_dashboard_sign_in)} · ${plural(o.dashboard_sessions, "active session", "active sessions")}`
                : "Not signed in",
            ),
          ),
          o.dashboard_sessions
            ? h(
                "div",
                {},
                h(
                  "button",
                  {
                    class: "btn btn-secondary btn-sm",
                    type: "button",
                    onclick: async (e) => {
                      const button = e.currentTarget;
                      const ok = await confirmDialog({
                        title: "Sign the owner out of the dashboard?",
                        body: "Every browser they're signed in on is signed out, and unused sign-in links stop working. They can ask for a new link on WhatsApp.",
                        ok: "Sign them out",
                      });
                      if (!ok) return;
                      await busy(button, async () => {
                        const r = await post(`/businesses/${b.id}/owner/sign-out`);
                        toast(`Signed out of ${num(r.ended)} session${r.ended === 1 ? "" : "s"}.`);
                        await reload();
                      });
                    },
                  },
                  icon("out"),
                  "Sign out of the dashboard",
                ),
              )
            : null,
        ]
      : h("p", { class: "muted", text: "Nobody manages this listing yet: it's claimed when its number messages us on WhatsApp." }),
    linkButton,
    linkBox,
  );
}

function catalogueSection(b) {
  const c = b.catalogue;
  const box = h("div", { class: "stack-sm" });
  const search = h("input", { class: "input", type: "search", placeholder: "Find a product", "aria-label": "Find a product" });
  let offset = 0;
  let timer;
  const load = async (append = false) => {
    offset = append ? offset : 0;
    const data = await get(`/businesses/${b.id}/products?${qs({ q: search.value.trim(), limit: 25, offset })}`);
    offset += data.items.length;
    const rows = data.items.map((p) => {
      const thumb = h("img", { alt: "", style: "width:36px;height:36px;border-radius:8px;object-fit:cover;background:var(--surface-2)" });
      if (p.photoId) showPhoto(thumb, p.photoId);
      return h(
        "li",
        {},
        p.photoId ? thumb : h("span", { class: "thumb", style: "width:36px;height:36px" }, icon("image")),
        h(
          "span",
          { class: "grow" },
          h("span", { text: p.name }),
          h("small", { text: [p.price != null ? money(p.price) : p.priceText || "no price", p.unit, p.category, p.inStock ? null : "out of stock", `changed ${ago(p.updatedAt)}`].filter(Boolean).join(" · ") }),
        ),
        h(
          "button",
          {
            class: "btn btn-ghost btn-sm",
            type: "button",
            title: "Take this product down",
            onclick: async (e) => {
              const button = e.currentTarget;
              const reason = await promptDialog({
                title: `Take down "${p.name}"?`,
                body: "Customers won't see it, and its photo is deleted. Say why: it's kept in the activity log.",
                placeholder: "e.g. Not allowed to be sold",
                ok: "Take down",
                danger: true,
                required: true,
              });
              if (reason === null) return;
              await busy(button, async () => {
                await post(`/businesses/${b.id}/products/archive`, { ids: [p.id], reason });
                toast(`${p.name} was taken down.`);
                await load();
              });
            },
          },
          icon("trash"),
          h("span", { class: "sr-only", text: `Take down ${p.name}` }),
        ),
      );
    });
    const list = append ? box.querySelector(".mini-list") : null;
    if (list) list.append(...rows);
    else box.replaceChildren(rows.length ? h("ul", { class: "mini-list" }, rows) : h("p", { class: "muted", text: search.value ? "No products match." : "No products listed." }));
    box.querySelector(".more")?.remove();
    if (offset < data.total) {
      box.append(
        h(
          "button",
          { class: "btn btn-ghost btn-sm more", type: "button", onclick: (e) => busy(e.currentTarget, () => load(true)) },
          `Show more (${num(data.total - offset)} left)`,
        ),
      );
    }
  };
  search.oninput = () => {
    clearTimeout(timer);
    timer = setTimeout(() => busy(null, () => load()), 250);
  };
  if (c.total) busy(null, () => load());
  return h(
    "section",
    { class: "detail-section" },
    h("h3", { text: "Catalogue" }),
    h(
      "p",
      { class: "muted" },
      c.total
        ? `${num(c.total)} products · ${num(c.noPrice)} without a price · ${num(c.stale)} prices over 30 days old · ${num(c.outOfStock)} out of stock · ${num(c.noPhoto)} without a photo`
        : "No products listed yet.",
    ),
    c.total ? [search, box] : null,
  );
}

function photoSection(b, reload) {
  const photos = b.photos.filter((p) => p.kind !== "product");
  return h(
    "section",
    { class: "detail-section" },
    h("h3", { text: "Photos" }),
    photos.length
      ? h(
          "div",
          { class: "thumbs" },
          photos.map((p) => {
            const img = h("img", { alt: p.kind });
            showPhoto(img, p.id);
            return h(
              "figure",
              {},
              img,
              h("figcaption", {}, badge({ shopfront: "Shopfront", inside: "Inside" }[p.kind] ?? p.kind, "plain")),
              h(
                "button",
                {
                  class: "btn btn-secondary btn-icon btn-sm remove",
                  type: "button",
                  "aria-label": "Delete this photo",
                  onclick: async (e) => {
                    const button = e.currentTarget;
                    if (!(await confirmDialog({ title: "Delete this photo?", body: "It's deleted for good, and recorded in the activity log.", ok: "Delete", danger: true }))) return;
                    await busy(button, async () => {
                      await del(`/businesses/${b.id}/photos/${p.id}`);
                      toast("Photo deleted.");
                      await reload();
                    });
                  },
                },
                icon("close"),
              ),
            );
          }),
        )
      : h("p", { class: "muted", text: "No shopfront or inside photos." }),
  );
}

const RECHECK_LABELS = { still_good: "still good", unverified: "verified badge removed", paused: "paused" };

function recordSection(b) {
  const lines = [
    b.record?.answered
      ? `Customers' follow-up answers, last 90 days: ${b.record.sorted} sorted, ${b.record.couldntHelp} couldn't help, ${b.record.noReply} didn't reply.`
      : "No follow-up answers from customers yet.",
    ...b.audits.map((a) => `Call-back: ${a.outcome.replace(/_/g, " ")} by ${a.audited_by}, ${shortDate(a.created_at)}${a.note ? ` (${a.note})` : ""}`),
    ...b.rechecks.map((c) => `Re-check: ${RECHECK_LABELS[c.outcome] ?? c.outcome} by ${c.checked_by}, ${shortDate(c.created_at)}${c.note ? ` (${c.note})` : ""}`),
  ];
  return h("section", { class: "detail-section" }, h("h3", { text: "Track record" }), h("ul", { class: "reasons" }, lines.map((l) => h("li", { text: l }))));
}

async function verify() {
  const rows = await get("/verification-queue");
  return [
    pageHead("To verify", "Businesses that signed up themselves, on WhatsApp or the website, grouped by area. Visit, check the premises and ID, then mark them verified."),
    table(
      [
        { label: "Area", render: (r) => [r.area, r.city].filter(Boolean).join(", ") || "–" },
        { label: "Business", render: (r) => h("a", { href: "#", onclick: (e) => (e.preventDefault(), openBusiness(r.id)), text: r.name }) },
        { label: "Phone", render: (r) => phoneLink(r.phone) },
        { label: "What they do", wrap: true, render: (r) => r.description || "–" },
        { label: "Signed up", render: (r) => shortDate(r.created_at) },
        {
          label: "",
          render: (r) =>
            h(
              "button",
              {
                class: "btn btn-sm",
                type: "button",
                onclick: (e) =>
                  busy(e.currentTarget, async () => {
                    await post(`/businesses/${r.id}/verify`);
                    toast(`${r.name} is verified.`);
                    refresh();
                  }),
              },
              "Mark verified",
            ),
        },
      ],
      rows,
      { empty: "Nobody is waiting to be verified." },
    ),
  ];
}

async function signups(params) {
  const status = ["pending", "completed", "expired", "all"].includes(params.get("status")) ? params.get("status") : "pending";
  const rows = await get(`/web-registrations?status=${status}`);
  return [
    pageHead(
      "Website sign-ups",
      "Businesses that registered on the website. A listing is created when the owner sends their code from WhatsApp, or when you list it after calling them. Before launch, codes can't be sent: call each one, then List it.",
      segmented(
        [
          ["pending", "Waiting for the code"],
          ["completed", "Finished"],
          ["expired", "Code ran out"],
          ["all", "All"],
        ],
        status,
        (s) => go("signups", { status: s }),
        "Which sign-ups",
      ),
    ),
    table(
      [
        { label: "Code", render: (r) => h("span", { class: "mono", text: r.code }) },
        {
          label: "Business",
          render: (r) =>
            r.businessId ? h("a", { href: "#", onclick: (e) => (e.preventDefault(), openBusiness(r.businessId)), text: r.name ?? "Open the listing" }) : (r.name ?? "–"),
        },
        { label: "Phone", render: (r) => (r.phone ? phoneLink(r.phone) : h("span", { class: "muted", text: r.completedAt ? "on the listing" : "–" })) },
        { label: "Area", render: (r) => r.area ?? "–" },
        { label: "Sells", wrap: true, render: (r) => r.categories.join(", ") || "–" },
        { label: "Started", render: (r) => dateTime(r.createdAt) },
        {
          label: "Now",
          render: (r) =>
            r.completedAt
              ? badge(`Listed ${shortDate(r.completedAt)}`, "good")
              : new Date(r.expiresAt) > new Date()
                ? badge(`Code works until ${dateTime(r.expiresAt)}`, "warn")
                : badge("Code ran out", "bad"),
        },
        {
          label: "",
          render: (r) =>
            r.completedAt
              ? null
              : h(
                  "button",
                  {
                    class: "btn btn-secondary btn-sm",
                    type: "button",
                    onclick: async (e) => {
                      const button = e.currentTarget;
                      const ok = await confirmDialog({
                        title: `List ${r.name ?? "this business"}?`,
                        body: "Do this after calling the owner to check the details. It goes live now. They manage it by typing my business on WhatsApp, or with a dashboard link from its page.",
                        ok: "List it",
                      });
                      if (!ok) return;
                      await busy(button, async () => {
                        const res = await post(`/web-registrations/${r.id}/list`);
                        toast(res.created ? `${res.name} is listed.` : `${res.name} was already listed.`);
                        refresh();
                      });
                    },
                  },
                  "List it",
                ),
        },
      ],
      rows,
      { empty: status === "pending" ? "No sign-ups are waiting for their code." : "None." },
    ),
  ];
}

async function callbacks(params) {
  const percent = [5, 10, 20, 50, 100].includes(Number(params.get("percent"))) ? Number(params.get("percent")) : 10;
  const rows = await get(`/audits/queue?days=14&percent=${percent}`);
  const outcomes = [
    ["confirmed", "Confirmed"],
    ["details_wrong", "Details wrong"],
    ["wrong_number", "Wrong number"],
    ["not_a_business", "Not a business"],
    ["refused", "Refused to talk"],
  ];
  return [
    pageHead(
      "Call-backs",
      "Phone a random share of each agent's recent registrations. A wrong number or a fake business hides the listing.",
      selectOf(
        [5, 10, 20, 50, 100].map((p) => [String(p), `Check ${p}%`]),
        String(percent),
        (e) => go("callbacks", { percent: e.target.value }),
        { "aria-label": "Share to check", style: "width:auto" },
      ),
    ),
    table(
      [
        { label: "Agent", key: "agent" },
        { label: "Business", render: (r) => h("div", { class: "badges" }, h("a", { href: "#", onclick: (e) => (e.preventDefault(), openBusiness(r.id)), text: r.name }), verificationBadge(r.verification)) },
        { label: "Phone", render: (r) => phoneLink(r.phone) },
        { label: "Area", render: (r) => r.area ?? "–" },
        { label: "Registered", render: (r) => shortDate(r.created_at) },
        {
          label: "What you found",
          render: (r) => {
            const outcome = selectOf(outcomes, "confirmed", null, { "aria-label": "Result" });
            const note = h("input", { class: "input", placeholder: "Note (optional)", "aria-label": "Note" });
            return h(
              "div",
              { class: "cell-actions" },
              outcome,
              note,
              h(
                "button",
                {
                  class: "btn btn-sm",
                  type: "button",
                  onclick: (e) =>
                    busy(e.currentTarget, async () => {
                      await post(`/businesses/${r.id}/audit`, { outcome: outcome.value, note: note.value.trim() || undefined });
                      toast("Saved.");
                      refresh();
                    }),
                },
                "Save",
              ),
            );
          },
        },
      ],
      rows,
      { empty: "Nothing to call back from the last 14 days." },
    ),
  ];
}

async function rechecks() {
  const rows = await get("/rechecks");
  const outcomes = [
    ["still_good", "Still good: keep verified"],
    ["unverified", "Remove the verified badge"],
    ["paused", "Pause the listing"],
  ];
  return [
    pageHead(
      "Re-checks",
      "Verified businesses to look at again: customers let down, open reports, low ratings, or verified over a year ago. We tell customers verified businesses are genuine and reliable; this list keeps that true.",
    ),
    table(
      [
        { label: "Business", render: (r) => h("div", { class: "badges" }, h("a", { href: "#", onclick: (e) => (e.preventDefault(), openBusiness(r.id)), text: r.name }), statusBadge(r.status)) },
        { label: "Phone", render: (r) => phoneLink(r.phone) },
        { label: "Area", render: (r) => [r.area, r.city].filter(Boolean).join(", ") || "–" },
        { label: "Why", wrap: true, render: (r) => h("ul", { class: "reasons" }, r.reasons.map((reason) => h("li", { text: reason }))) },
        { label: "Verified", render: (r) => (r.verified_at ? shortDate(r.verified_at) : "–") },
        {
          label: "What you found",
          render: (r) => {
            const outcome = selectOf(outcomes, "still_good", null, { "aria-label": "Result" });
            const note = h("input", { class: "input", placeholder: "Note (optional)", "aria-label": "Note" });
            return h(
              "div",
              { class: "cell-actions" },
              outcome,
              note,
              h(
                "button",
                {
                  class: "btn btn-sm",
                  type: "button",
                  onclick: (e) =>
                    busy(e.currentTarget, async () => {
                      await post(`/businesses/${r.id}/recheck`, { outcome: outcome.value, reasons: r.reasons, note: note.value.trim() || undefined });
                      toast("Saved.");
                      refresh();
                    }),
                },
                "Save",
              ),
            );
          },
        },
      ],
      rows,
      { empty: "No verified business needs a second look." },
    ),
  ];
}

async function tips() {
  const rows = await get("/recommendations?status=new");
  const act = (r, status, message) => (e) =>
    busy(e.currentTarget, async () => {
      await post(`/recommendations/${r.id}/status`, { status });
      toast(message);
      refresh();
    });
  return [
    pageHead("Customer tips", "Businesses customers recommended. Call or visit them, then register them in the field app."),
    table(
      [
        { label: "When", render: (r) => shortDate(r.created_at) },
        {
          label: "Business",
          render: (r) =>
            h(
              "div",
              { class: "badges" },
              h("strong", { text: r.name }),
              r.already_listed ? badge("Already listed", "good") : null,
              r.times_recommended > 1 ? badge(`${r.times_recommended} tips`, "plain") : null,
            ),
        },
        { label: "What they do", wrap: true, key: "what" },
        { label: "Category", key: "category" },
        { label: "Area", render: (r) => [r.area, r.city].filter(Boolean).join(", ") || "–" },
        { label: "Phone", render: (r) => phoneLink(r.phone) },
        {
          label: "",
          render: (r) =>
            h(
              "div",
              { class: "cell-actions" },
              h("button", { class: "btn btn-secondary btn-sm", type: "button", onclick: act(r, "contacted", "Marked contacted.") }, "Contacted"),
              h("button", { class: "btn btn-sm", type: "button", onclick: act(r, "listed", "Marked listed.") }, "Listed"),
              h("button", { class: "btn btn-danger btn-sm", type: "button", onclick: act(r, "rejected", "Marked not suitable.") }, "Not suitable"),
            ),
        },
      ],
      rows,
      { empty: "No new tips." },
    ),
  ];
}

// ---------- Demand ----------

const REQUEST_STATUSES = {
  open: ["Open", ""],
  answered: ["Answered", "good"],
  connected: ["Connected", "good"],
  no_results: ["Found nobody", "bad"],
  asked_around: ["Asked around", "warn"],
  handoff: ["With a person", "warn"],
  closed: ["Closed", ""],
};
const UNDERSTOOD_BY = { local: "understood locally", phrasebook: "from the phrasebook", customer: "the customer picked", claude: "by Claude", photo: "from a photo", fallback: "not understood" };

async function requests(params) {
  const status = params.get("status") ?? "";
  const [rows] = await Promise.all([get(`/requests?${qs({ status, limit: 200 })}`), categories()]);
  return [
    pageHead(
      "Requests",
      "What customers asked for, newest first. Their numbers are partly hidden; look someone up under People when you need to.",
      selectOf([["", "Every request"], ...Object.entries(REQUEST_STATUSES).map(([k, [label]]) => [k, label])], status, (e) => go("requests", { status: e.target.value }), {
        "aria-label": "Status",
        style: "width:auto",
      }),
    ),
    table(
      [
        { label: "When", render: (r) => dateTime(r.created_at) },
        { label: "They wrote", wrap: true, render: (r) => r.raw_text || r.query || "–" },
        {
          label: "Understood as",
          render: (r) => h("div", { class: "stack-sm" }, h("span", { text: categoryName(r.category_slug) || "no category" }), h("small", { class: "muted", text: UNDERSTOOD_BY[r.understood_by] ?? r.understood_by ?? "" })),
        },
        { label: "Area", render: (r) => r.area ?? "–" },
        {
          label: "Result",
          render: (r) => {
            const [label, kind] = REQUEST_STATUSES[r.status] ?? [r.status, ""];
            return h("div", { class: "badges" }, badge(label, kind), r.result_count ? h("span", { class: "muted", text: `${r.result_count} shown` }) : null);
          },
        },
        { label: "Customer", render: (r) => h("span", { class: "mono", text: maskedPhone(r.wa_id) }) },
      ],
      rows,
      { empty: "No requests." },
    ),
  ];
}

async function gaps(params) {
  const period = days(params, 7);
  const rows = await get(`/supply-gaps?days=${period}`);
  await categories();
  return [
    pageHead(
      "Supply gaps",
      "What people asked for that no supplier in its own category could answer: they got related suppliers, or a person took over. Send field agents here first.",
      segmented(
        [
          [7, "7 days"],
          [30, "30 days"],
          [90, "90 days"],
        ],
        period,
        (d) => go("gaps", { days: d }),
        "Period",
      ),
    ),
    table(
      [
        { label: "Category", render: (r) => categoryName(r.category) },
        { label: "Area", key: "area" },
        { label: "Requests", num: true, render: (r) => num(r.requests) },
        { label: "From businesses", render: (r) => (r.from_businesses ? badge(`${r.from_businesses} wholesale`, "plain") : "") },
        { label: "Recent examples", wrap: true, render: (r) => h("span", { class: "examples", text: (r.examples || []).join(" · ") }) },
      ],
      rows,
      { empty: "No gaps in this period." },
    ),
  ];
}

// ---------- Understanding ----------

async function vocabulary() {
  const [unmatched, cats, suggestions] = await Promise.all([get("/unmatched?days=30"), categories(), get("/vocabulary/suggestions")]);
  const addWord = async (slug, word) => {
    const r = await post(`/categories/${encodeURIComponent(slug)}/synonyms`, { add: [word] });
    toast(`Added "${word}" to ${categoryName(slug)}. Words added so far: ${r.extra_synonyms.join(", ")}`);
  };
  const word = h("input", { class: "input", placeholder: "A word or phrase customers use", required: true });
  const pick = categorySelect(cats);
  return [
    pageHead("Vocabulary", "Words customers use that the assistant didn't know, and searches that matched no category. Add them to the right category so the next customer is understood straight away."),
    h(
      "section",
      { class: "card panel" },
      h(
        "form",
        {
          class: "form-inline",
          onsubmit: (e) => {
            e.preventDefault();
            busy(e.submitter, async () => {
              if (!word.value.trim() || !pick.value) throw new Error("Give a word and choose its category.");
              await addWord(pick.value, word.value.trim());
              word.value = "";
            });
          },
        },
        field("Word or phrase", word),
        field("Category", pick),
        h("button", { class: "btn", type: "submit" }, icon("plus"), "Add word"),
      ),
    ),
    h("h2", { class: "section-title", text: "Suggested words" }),
    h("p", { class: "muted", text: "Words the assistant didn't know, with what they turned out to mean. Add the ones that nearly always mean one category." }),
    table(
      [
        { label: "Word", render: (r) => h("strong", { text: r.word }) },
        { label: "Seen", num: true, render: (r) => num(r.uses) },
        { label: "Mostly meant", key: "category_name" },
        { label: "Agreement", num: true, render: (r) => badge(`${r.agreement}%`, r.agreement >= 90 ? "good" : r.agreement < 60 ? "warn" : "plain") },
        { label: "Wording it came in", wrap: true, render: (r) => h("span", { class: "examples", text: r.examples.join(" · ") }) },
        {
          label: "",
          render: (r) =>
            h(
              "button",
              {
                class: "btn btn-secondary btn-sm",
                type: "button",
                onclick: (e) =>
                  busy(e.currentTarget, async () => {
                    await addWord(r.category, r.word);
                    refresh();
                  }),
              },
              `Add to ${r.category_name}`,
            ),
        },
      ],
      suggestions,
      { empty: "No suggestions yet." },
    ),
    h("h2", { class: "section-title", text: "Searches that matched no category" }),
    table(
      [
        { label: "Customers typed", render: (r) => h("strong", { text: r.query }) },
        { label: "Requests", num: true, render: (r) => num(r.requests) },
        { label: "Found nobody", num: true, render: (r) => num(r.no_results) },
        { label: "Examples", wrap: true, render: (r) => h("span", { class: "examples", text: (r.examples || []).join(" · ") }) },
        {
          label: "Add to category",
          render: (r) => {
            const select = categorySelect(cats, "Choose…");
            return h(
              "div",
              { class: "cell-actions" },
              select,
              h(
                "button",
                {
                  class: "btn btn-secondary btn-sm",
                  type: "button",
                  onclick: (e) =>
                    busy(e.currentTarget, async () => {
                      if (!select.value) throw new Error("Choose a category first.");
                      await addWord(select.value, r.query);
                      refresh();
                    }),
                },
                "Add",
              ),
            );
          },
        },
      ],
      unmatched,
      { empty: "Every search matched a category in the last 30 days." },
    ),
  ];
}

const ROLE_LABELS = {
  service: "service",
  product: "product",
  object: "general word (weak)",
  brand: "brand (weak)",
  occasion: "occasion (weak)",
  action: "action",
  spec: "detail (ignored)",
  filler: "filler (ignored)",
};
const ACTIONS = ["repair", "make", "buy", "hire", "move", "dig", "build", "paint", "sew", "clean", "wash", "cook", "teach", "learn", "drive", "hair", "send", "install", "print"];

async function words(params) {
  const language = ["sn", "en", "nd"].includes(params.get("language")) ? params.get("language") : "sn";
  const status = params.has("status") ? params.get("status") : "draft";
  const search = params.get("q") ?? "";
  const [rows, cats] = await Promise.all([get(`/lexicon?${new URLSearchParams({ language, status, q: search })}`), categories()]);
  const nav = (changes) => go("words", { language, status, q: search, ...changes });
  const picked = new Set();
  const review = (ids, next) =>
    busy(null, async () => {
      if (!ids.length) throw new Error("Tick some words first.");
      await post("/lexicon/review", { ids, status: next });
      toast(next === "approved" ? "Approved." : "Rejected.");
      refresh();
    });
  const searchBox = h("input", { class: "input", type: "search", placeholder: "Find a word or meaning", value: search });

  const term = h("input", { class: "input", placeholder: "Word, phrase or verb root", required: true });
  const lang = selectOf(
    [
      ["sn", "Shona"],
      ["en", "English"],
      ["nd", "Ndebele"],
    ],
    language,
    null,
  );
  const role = selectOf(Object.entries(ROLE_LABELS), "service", null);
  const category = categorySelect(cats, "Category it points to");
  const action = selectOf([["", "Action (for action words)"], ...ACTIONS.map((a) => [a, a])], "", null);
  const root_ = h("input", { type: "checkbox" });
  const gloss = h("input", { class: "input", placeholder: "Meaning in English" });

  return [
    pageHead(
      "Word list",
      "What words mean to the assistant. The Shona and Ndebele lists are first drafts: a native speaker should check each word. Until a word is approved, requests that depend on it get a \"Did you mean…?\" question instead of a straight answer.",
      h(
        "button",
        {
          class: "btn btn-secondary",
          type: "button",
          onclick: (e) =>
            busy(e.currentTarget, async () => saveFile(await get(`/lexicon/export.csv?${new URLSearchParams({ language, status })}`), `word-list-${language}.csv`)),
        },
        icon("download"),
        "Download as a spreadsheet",
      ),
    ),
    h(
      "form",
      {
        class: "filters",
        onsubmit: (e) => {
          e.preventDefault();
          nav({ q: searchBox.value.trim() });
        },
      },
      selectOf(
        [
          ["sn", "Shona"],
          ["en", "English"],
          ["nd", "Ndebele"],
        ],
        language,
        (e) => nav({ language: e.target.value }),
        { "aria-label": "Language" },
      ),
      selectOf(
        [
          ["draft", "To review"],
          ["approved", "Approved"],
          ["rejected", "Rejected"],
          ["", "All"],
        ],
        status,
        (e) => nav({ status: e.target.value }),
        { "aria-label": "Status" },
      ),
      h("div", { class: "search" }, icon("search"), searchBox),
      h("button", { class: "btn btn-secondary", type: "submit" }, "Find"),
    ),
    h(
      "div",
      { class: "filters" },
      h("button", { class: "btn btn-sm", type: "button", onclick: () => review([...picked], "approved") }, "Approve ticked"),
      h("button", { class: "btn btn-danger btn-sm", type: "button", onclick: () => review([...picked], "rejected") }, "Reject ticked"),
      h("span", { class: "muted", text: `${num(rows.length)} words. "Customers agreed" counts people who picked the word's category when asked.` }),
    ),
    table(
      [
        { label: "", render: (r) => h("input", { type: "checkbox", "aria-label": `Tick ${r.term}`, onchange: (e) => (e.target.checked ? picked.add(r.id) : picked.delete(r.id)) }) },
        { label: "Word", render: (r) => h("div", { class: "stack-sm" }, h("strong", { text: r.term }), r.forms.length ? h("small", { class: "muted", text: `verb root: ${r.forms.join(", ")}` }) : null) },
        { label: "Meaning", wrap: true, key: "gloss" },
        {
          label: "What it does",
          wrap: true,
          render: (r) => [ROLE_LABELS[r.role] || r.role, r.category_names.length ? `→ ${r.category_names.join(" or ")}` : null, r.action ? `(${r.action})` : null].filter(Boolean).join(" "),
        },
        { label: "Customers agreed", num: true, render: (r) => num(r.confirmed) },
        {
          label: "Status",
          render: (r) =>
            h(
              "div",
              { class: "stack-sm" },
              badge(r.status === "draft" ? "To review" : r.status === "approved" ? "Approved" : "Rejected", r.status === "approved" ? "good" : r.status === "rejected" ? "bad" : "warn"),
              r.reviewed_by ? h("small", { class: "muted", text: `${r.reviewed_by}, ${shortDate(r.reviewed_at)}` }) : null,
            ),
        },
        {
          label: "",
          render: (r) =>
            h(
              "div",
              { class: "cell-actions" },
              r.status !== "approved" ? h("button", { class: "btn btn-secondary btn-sm", type: "button", onclick: () => review([r.id], "approved") }, "Right") : null,
              r.status !== "rejected" ? h("button", { class: "btn btn-danger btn-sm", type: "button", onclick: () => review([r.id], "rejected") }, "Wrong") : null,
            ),
        },
      ],
      rows,
      { empty: "No words here." },
    ),
    panel(
      "Add a word, or correct what one means",
      "Services and products point to a category. Actions change the category of what they apply to (\"gadzira\" and fridge is appliance repairs); tick \"verb root\" for a Shona root like \"gadzir\" so its forms are recognised. Brands, occasions and general words only decide when nothing stronger is said.",
      h(
        "form",
        {
          class: "form-inline",
          onsubmit: (e) => {
            e.preventDefault();
            busy(e.submitter, async () => {
              await post("/lexicon", {
                term: term.value,
                language: lang.value,
                role: role.value,
                categories: category.value ? [category.value] : [],
                action: action.value || null,
                root: root_.checked,
                gloss: gloss.value,
              });
              toast(`Saved "${term.value}". It works straight away.`);
              term.value = gloss.value = "";
            });
          },
        },
        field("Word", term),
        field("Language", lang),
        field("What it is", role),
        field("Category", category),
        field("Action", action),
        field("Meaning in English", gloss),
        h("label", { class: "check", style: "align-self:center" }, root_, h("span", { text: "Verb root" })),
        h("button", { class: "btn", type: "submit" }, "Save word"),
      ),
    ),
  ];
}

async function check() {
  const [rows, cats] = await Promise.all([get("/review/sample?limit=50"), categories()]);
  const verdict = (r, v, category) =>
    busy(null, async () => {
      await post(`/requests/${r.id}/review`, { verdict: v, category });
      toast("Saved.");
      refresh();
    });
  return [
    pageHead(
      "Check answers",
      "Once a week, check the answers customers said were wrong, then a random sample of answers the assistant gave without asking anyone. Aim for 98% right. A wrong answer is fixed for that wording straight away.",
    ),
    table(
      [
        { label: "When", render: (r) => shortDate(r.created_at) },
        { label: "Customer wrote", wrap: true, key: "raw_text" },
        {
          label: "Assistant understood",
          render: (r) =>
            h(
              "div",
              { class: "stack-sm" },
              h("strong", { text: `${r.category_name || "no category"}${r.area ? ` · ${r.area}` : ""}` }),
              r.flagged_at ? badge("The customer said this was wrong", "bad") : null,
            ),
        },
        { label: "Why", wrap: true, render: (r) => h("span", { class: "muted", text: (r.reading?.reasons || []).join("; ") }) },
        {
          label: "",
          render: (r) => {
            const right = categorySelect(cats, "The right category…");
            return h(
              "div",
              { class: "cell-actions" },
              h("button", { class: "btn btn-sm", type: "button", onclick: () => verdict(r, "right") }, "Right"),
              h("button", { class: "btn btn-secondary btn-sm", type: "button", onclick: () => verdict(r, "should_ask") }, "Should have asked"),
              right,
              h(
                "button",
                {
                  class: "btn btn-danger btn-sm",
                  type: "button",
                  onclick: () => (right.value ? verdict(r, "wrong", right.value) : toast("Pick the right category first.", "bad")),
                },
                "Wrong",
              ),
            );
          },
        },
      ],
      rows,
      { empty: "Nothing to check this week." },
    ),
  ];
}

async function label() {
  const [next, summary, cats] = await Promise.all([get("/labels/next?limit=20"), get("/labels/summary"), categories()]);
  const byLabel = { local: "Understood locally", phrasebook: "From the phrasebook", customer: "The customer picked", claude: "By Claude", photo: "From a photo", fallback: "Not understood" };
  const rate = (right, n) => (n ? `${Math.round((100 * right) / n)}%` : "–");
  const others = [
    ["search:", "Something we don't list"],
    ["greeting:", "Greeting or thanks"],
    ["out_of_scope:", "A question about something else"],
    ["human:", "Wants a person"],
    ["unclear:", "Too vague to tell"],
  ];
  const pick = (r) => {
    const select = h(
      "select",
      { class: "select", "aria-label": "They wanted" },
      h("optgroup", { label: "Not a category" }, others.map(([v, l]) => h("option", { value: v }, l))),
      h("optgroup", { label: "Categories" }, cats.filter((c) => c.risk !== "blocked").map((c) => h("option", { value: c.slug }, `${c.group_name} › ${c.name}`))),
    );
    select.value = r.intent === "search" || !r.intent ? r.category_slug || "search:" : `${r.intent}:`;
    return select;
  };
  return [
    pageHead("Label requests", `What did customers actually want? Label a random sample of real requests: about ${summary.target} are enough to tune the assistant. A correction also teaches it.`),
    h(
      "div",
      { class: "tiles" },
      kpi("Requests labelled", `${num(summary.labelled)} of ${num(summary.target)}`),
      kpi("The assistant was right", rate(summary.right, summary.labelled)),
    ),
    summary.byStep.length
      ? panel(
          "How it was understood",
          null,
          table(
            [
              { label: "Step", render: (r) => byLabel[r.by] || r.by || "(not recorded)" },
              { label: "Labelled", num: true, render: (r) => num(r.labelled) },
              { label: "Right", num: true, render: (r) => rate(r.right, r.labelled) },
            ],
            summary.byStep,
          ),
        )
      : null,
    h("h2", { class: "section-title", text: "To label" }),
    table(
      [
        { label: "Customer wrote", wrap: true, key: "raw_text" },
        {
          label: "The assistant",
          render: (r) =>
            h("span", { class: "muted", text: [r.category_name || (r.intent && r.intent !== "search" ? r.intent : "no category"), byLabel[r.understood_by] || r.understood_by].filter(Boolean).join(" · ") }),
        },
        {
          label: "They wanted",
          render: (r) => {
            const select = pick(r);
            return h(
              "div",
              { class: "cell-actions" },
              select,
              h(
                "button",
                {
                  class: "btn btn-sm",
                  type: "button",
                  onclick: (e) =>
                    busy(e.currentTarget, async () => {
                      const [intent, category] = select.value.includes(":") ? select.value.split(":") : ["search", select.value];
                      await post(`/requests/${r.id}/label`, { intent, category: category || null });
                      toast("Saved.");
                      refresh();
                    }),
                },
                "Save",
              ),
            );
          },
        },
      ],
      next.requests,
      { empty: "Nothing left to label from the last 90 days." },
    ),
  ];
}

// ---------- Team ----------

function secretBox(title, value, note) {
  return h(
    "div",
    { class: "secret" },
    h("strong", { text: title }),
    h("code", { text: value }),
    note ? h("span", { class: "muted", text: note }) : null,
    h("div", {}, h("button", { class: "btn btn-secondary btn-sm", type: "button", onclick: () => navigator.clipboard?.writeText(value).then(() => toast("Copied.")) }, "Copy")),
  );
}

async function agents() {
  const rows = await get("/agents");
  const result = h("div");
  const showLink = (agent, url) =>
    result.replaceChildren(
      secretBox(`Setup link for ${agent}`, url, "Send it to the agent on WhatsApp and have them open it on their phone. Anyone with the link can register businesses as this agent, so make a new one if it's shared or lost."),
    );
  const name = h("input", { class: "input", required: true });
  const phone = h("input", { class: "input", inputmode: "tel" });
  const city = h("input", { class: "input" });
  return [
    pageHead("Field agents", "Add agents, send them their setup link, and watch the quality of what they register."),
    h(
      "section",
      { class: "card panel" },
      h(
        "form",
        {
          class: "form-inline",
          onsubmit: (e) => {
            e.preventDefault();
            busy(e.submitter, async () => {
              const created = await post("/agents", { name: name.value.trim(), phone: phone.value.trim() || undefined, city: city.value.trim() || undefined });
              name.value = phone.value = city.value = "";
              await refresh();
              document.querySelector("#agent-link")?.replaceChildren(
                secretBox(`Setup link for ${created.agent.name}`, created.setupUrl, "Send it to the agent on WhatsApp and have them open it on their phone. Anyone with the link can register businesses as this agent."),
              );
            });
          },
        },
        field("Full name", name),
        field("Phone (optional)", phone),
        field("City (optional)", city),
        h("button", { class: "btn", type: "submit" }, icon("userPlus"), "Add agent"),
      ),
      h("div", { id: "agent-link" }, result),
    ),
    h("div", { class: "section-gap" }),
    table(
      [
        { label: "Agent", render: (r) => h("div", { class: "badges" }, h("strong", { text: r.name }), r.active ? null : badge("Switched off", "bad")) },
        { label: "City", render: (r) => r.city ?? "–" },
        { label: "Last seen", render: (r) => (r.last_seen_at ? dateTime(r.last_seen_at) : "never") },
        { label: "7 days", num: true, render: (r) => num(r.registered_7d) },
        { label: "30 days", num: true, render: (r) => num(r.registered_30d) },
        { label: "Verified (30d)", num: true, render: (r) => num(r.verified_30d) },
        {
          label: "Call-backs passed",
          num: true,
          render: (r) => {
            const total = r.audits_passed + r.audits_failed;
            return total ? `${Math.round((100 * r.audits_passed) / total)}% of ${total}` : "none yet";
          },
        },
        { label: "Got customers", num: true, render: (r) => num(r.with_customers) },
        {
          label: "",
          render: (r) =>
            h(
              "div",
              { class: "cell-actions" },
              h(
                "button",
                {
                  class: "btn btn-secondary btn-sm",
                  type: "button",
                  onclick: (e) =>
                    busy(e.currentTarget, async () => {
                      showLink(r.name, (await post(`/agents/${r.id}/token`)).setupUrl);
                      window.scrollTo(0, 0);
                    }),
                },
                "New link",
              ),
              h(
                "button",
                {
                  class: `btn btn-sm ${r.active ? "btn-danger" : "btn-secondary"}`,
                  type: "button",
                  onclick: (e) =>
                    busy(e.currentTarget, async () => {
                      await post(`/agents/${r.id}/active`, { active: !r.active });
                      toast(r.active ? `${r.name} is switched off.` : `${r.name} is back on.`);
                      refresh();
                    }),
                },
                r.active ? "Switch off" : "Switch on",
              ),
            ),
        },
      ],
      rows,
      { empty: "No field agents yet." },
    ),
  ];
}

async function team() {
  const users = await get("/users");
  const result = h("div", { id: "team-secret" });
  const name = h("input", { class: "input", required: true });
  const email = h("input", { class: "input", type: "email", required: true });
  const role = selectOf(
    [
      ["staff", "Staff"],
      ["admin", "Admin"],
    ],
    "staff",
    null,
  );
  const showPassword = (label, password) => {
    const box = document.querySelector("#team-secret") ?? result;
    box.replaceChildren(secretBox(label, password, "Shown once. Pass it on privately; they can change it under their account."));
  };
  const change = (u, body, message) => (e) =>
    busy(e.currentTarget, async () => {
      const r = await post(`/users/${u.id}`, body);
      await refresh();
      if (r.password) showPassword(`New password for ${u.email}`, r.password);
      else toast(message);
    });
  return [
    pageHead(
      "Team accounts",
      "One account per person, so the activity log shows who did what. Staff handle chats, reports and listings; admins also manage field agents, the team and people's data.",
    ),
    h(
      "section",
      { class: "card panel" },
      h(
        "form",
        {
          class: "form-inline",
          onsubmit: (e) => {
            e.preventDefault();
            busy(e.submitter, async () => {
              const r = await post("/users", { name: name.value.trim(), email: email.value.trim(), role: role.value });
              name.value = email.value = "";
              await refresh();
              showPassword(`Password for ${r.user.email}`, r.password);
            });
          },
        },
        field("Full name", name),
        field("Email", email),
        field("Role", role),
        h("button", { class: "btn", type: "submit" }, icon("userPlus"), "Add person"),
      ),
      result,
    ),
    h("div", { class: "section-gap" }),
    table(
      [
        { label: "Name", render: (u) => h("div", { class: "badges" }, h("strong", { text: u.name }), u.active ? null : badge("Switched off", "bad"), u.id === S.me.userId ? badge("You", "plain") : null) },
        { label: "Email", key: "email" },
        { label: "Role", render: (u) => (u.role === "admin" ? badge("Admin", "brand") : badge("Staff", "plain")) },
        { label: "Last sign-in", render: (u) => (u.last_login_at ? dateTime(u.last_login_at) : "never") },
        {
          label: "",
          render: (u) =>
            u.id === S.me.userId
              ? h("a", { href: "#/account", text: "Your account" })
              : h(
                  "div",
                  { class: "cell-actions" },
                  h("button", { class: "btn btn-secondary btn-sm", type: "button", onclick: change(u, { resetPassword: true }, "New password made.") }, icon("key"), "New password"),
                  h(
                    "button",
                    { class: "btn btn-secondary btn-sm", type: "button", onclick: change(u, { role: u.role === "admin" ? "staff" : "admin" }, "Role changed.") },
                    u.role === "admin" ? "Make staff" : "Make admin",
                  ),
                  h(
                    "button",
                    { class: `btn btn-sm ${u.active ? "btn-danger" : "btn-secondary"}`, type: "button", onclick: change(u, { active: !u.active }, u.active ? "Switched off." : "Switched on.") },
                    u.active ? "Switch off" : "Switch on",
                  ),
                ),
        },
      ],
      users,
      { empty: "No accounts yet. Add the first person above." },
    ),
  ];
}

const ACTION_LABELS = {
  login: "Signed in",
  "password.change": "Changed their password",
  "user.create": "Added a team member",
  "user.update": "Changed a team account",
  "contact.reply": "Replied to a chat",
  "contact.release": "Handed a chat back",
  "contact.block": "Blocked or unblocked a number",
  "report.status": "Updated a report",
  "business.create": "Added a business",
  "business.verify": "Verified a business",
  "business.status": "Changed a listing's status",
  "business.trade": "Changed who a business sells to",
  "business.recheck": "Re-checked a business",
  "product.remove": "Took down products",
  "photo.remove": "Deleted a photo",
  "owner.sign_out": "Signed an owner out of the dashboard",
};

async function activity() {
  const rows = await get("/activity?limit=300");
  return [
    pageHead("Activity log", "Who did what in the admin portal, newest first."),
    table(
      [
        { label: "When", render: (r) => dateTime(r.created_at) },
        { label: "Who", key: "actor" },
        { label: "What", render: (r) => ACTION_LABELS[r.action] ?? r.action },
        { label: "On", render: (r) => h("span", { class: "mono", style: "font-size:12px", text: r.target || "" }) },
        {
          label: "Details",
          wrap: true,
          render: (r) =>
            Object.entries(r.details || {})
              .filter(([, v]) => v != null && v !== "")
              .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`)
              .join(" · "),
        },
      ],
      rows,
      { empty: "Nothing recorded yet." },
    ),
  ];
}

// ---------- System ----------

/** Products on WhatsApp: what's in our catalog (the product cards), what's waiting, what Meta refused, and alerts. */
function productsPanel(cat) {
  const line = (label, text) => h("li", { class: "row" }, h("span", { text: label }), h("strong", { text }));
  const alerts = cat.alerts.on
    ? `on · ${plural(cat.alerts.sent7d, "alert", "alerts")} sent in 7 days · ${plural(cat.alerts.switchedOff, "person has", "people have")} switched them off`
    : "off (PRODUCT_ALERTS)";
  if (!cat.enabled) {
    return panel(
      "Products on WhatsApp",
      "Replies show what stores list, with prices, as text. WhatsApp's own product cards (photos, \"View items\") need our Meta catalog: set WHATSAPP_CATALOG_ID.",
      h("ul", { class: "rows" }, line("Alerts to customers", alerts)),
    );
  }
  const resend = isAdmin()
    ? h(
        "button",
        {
          class: "btn btn-secondary btn-sm",
          type: "button",
          onclick: async (e) => {
            const button = e.currentTarget;
            const ok = await confirmDialog({
              title: "Send every product again?",
              body: "Every product with a photo and a price goes to the catalog again, and anything that shouldn't be there comes out. Use it after connecting a new catalog or fixing a setting.",
              ok: "Send everything again",
            });
            if (!ok) return;
            await busy(button, async () => {
              const r = await post("/catalog/sync");
              toast(`${plural(r.marked, "product", "products")} will go in the next minute.`);
              refresh();
            });
          },
        },
        "Send everything again",
      )
    : null;
  return panel(
    "Products on WhatsApp",
    "Products with a photo and a price go into our catalog, so replies can show WhatsApp's own product cards. A change on the dashboard goes within a minute.",
    h(
      "ul",
      { class: "rows" },
      line("Catalog", `${cat.kind === "meta" ? "Meta" : "Simulated"} · ${cat.catalogId}`),
      line("In the catalog", `${plural(cat.live, "product", "products")}${cat.errors ? `, ${num(cat.errors)} refused by Meta` : ""}`),
      line(
        "Waiting to go",
        `${plural(cat.waiting, "product", "products")}${cat.pending_batches ? ` · ${plural(cat.pending_batches, "batch", "batches")} being checked by Meta` : ""}`,
      ),
      line("Last sent", cat.last_synced ? dateTime(cat.last_synced) : "not yet"),
      line("Product cards in replies", cat.cards ? "on" : "off (PRODUCT_CARDS)"),
      line("Alerts to customers", alerts),
    ),
    cat.problems?.length
      ? table(
          [
            { label: "Product", render: (r) => r.name || r.retailer_id },
            { label: "Business", render: (r) => r.business || "" },
            { label: "What Meta said", wrap: true, key: "error" },
          ],
          cat.problems,
        )
      : null,
    resend ? h("div", { class: "actions" }, resend) : null,
  );
}

async function system() {
  const [s, cat] = await Promise.all([get("/system"), get("/catalog").catch(() => null)]);
  const usd = (n) => `$${Number(n || 0).toFixed(2)}`;
  const spentToday = s.claude.today.reduce((sum, r) => sum + r.usd, 0);
  const callsToday = s.claude.today.reduce((sum, r) => sum + r.calls, 0);
  const byLabel = { local: "Understood locally", phrasebook: "From the phrasebook", customer: "The customer picked", claude: "By Claude", photo: "From a photo", fallback: "Not understood" };
  const questions = s.questions7d || { asked: 0, picked: 0, something_else: 0 };
  const checked = s.precision28d || { reviewed: 0, right: 0 };
  const wordCount = (lang, st) => s.lexicon?.words.find((w) => w.language === lang && w.status === st)?.words ?? 0;
  const matchLabel = { exact: "Suppliers in their category", related: "Related suppliers only", retail: "Retail stores (no wholesaler)", none: "Handed to a person" };
  const shares = (rows, labels, key) => {
    const total = rows.reduce((sum, r) => sum + r.requests, 0);
    return rows.length ? rows.map((r) => `${labels[r[key]] || r[key]}: ${r.requests} (${Math.round((100 * r.requests) / total)}%)`).join(" · ") : "no requests yet";
  };
  const c = s.costs;
  const t = s.targets;
  const rate = (n, of) => (of ? Math.round((100 * n) / of) : null);
  const line = (label, text) => h("li", { class: "row" }, h("span", { text: label }), h("strong", { text }));
  return [
    pageHead("Health and costs", `Version ${s.version} · ${s.env} · running since ${dateTime(s.startedAt)}`),
    h(
      "div",
      { class: "tiles" },
      kpi("Messages waiting", num(s.inbound_unprocessed), "to be handled", { alert: s.inbound_unprocessed > 0 }),
      kpi("Replies being retried", num(s.outbound_retrying), null, { alert: s.outbound_retrying > 0 }),
      kpi("Replies failed, 24 hours", num(s.outbound_failed_24h), null, { alert: s.outbound_failed_24h > 0 }),
      kpi("Background jobs due", num(s.jobs_due)),
      kpi("Jobs failed, 24 hours", num(s.jobs_failed_24h), null, { alert: s.jobs_failed_24h > 0 }),
      kpi("Claude today", usd(spentToday), `${num(callsToday)} calls, of ${usd(s.claude.dailyBudgetUsd)} a day`, {
        alert: s.claude.dailyBudgetUsd > 0 && spentToday >= 0.8 * s.claude.dailyBudgetUsd,
      }),
    ),
    c
      ? panel(
          "Running costs",
          `Replies inside a customer's 24-hour window are free. Templates, at about ${usd(c.templatePriceUsd)} each, go out only as the settings below allow.`,
          h(
            "ul",
            { class: "rows" },
            line("Today", `Claude ${usd(c.today.claudeUsd)} · ${num(c.today.templates)} templates (${usd(c.today.templatesUsd)})`),
            line("This month", `Claude ${usd(c.month.claudeUsd)} · ${num(c.month.templates)} templates (${usd(c.month.templatesUsd)})`),
            line("Heading for", `${usd(c.projectedMonthUsd)} this month`),
            c.per1000RequestsUsd != null ? line("Per 1,000 requests", `${usd(c.per1000RequestsUsd)} (${num(c.month.requests)} so far)`) : null,
            line(
              "Paid templates",
              [
                `lead notices ${c.settings.leadNotices === "always" ? "always" : "never"}`,
                `follow-ups ${c.settings.paidFollowUps ? "when the window has closed" : "never"}`,
                `weekly summaries ${c.settings.weeklySummaries === "always" ? "every Monday" : c.settings.weeklySummaries === "window_only" ? "only free ones" : "off"}`,
                `at most ${c.settings.templateDailyCap} a day`,
              ].join(" · "),
            ),
          ),
        )
      : null,
    t
      ? panel(
          "Understanding targets",
          null,
          table(
            [
              { label: "Measure", render: (r) => r[0] },
              { label: "Now", num: true, render: (r) => (r[1] == null ? "no data yet" : `${r[1]}${r[2]}`) },
              { label: "Target", render: (r) => r[3] },
              { label: "", render: (r) => (r[1] == null ? "" : r[4](r[1]) ? badge("On target", "good") : badge("Not yet", "warn")) },
            ],
            [
              ["Understood without Claude, 7 days", rate(t.without_claude, t.requests), "%", "80% or more", (v) => v >= 80],
              ["Claude calls per 100 requests, 7 days", t.requests ? Math.round((100 * t.claude_calls) / t.requests) : null, "", "10 or fewer", (v) => v <= 10],
              ["Handed to a person, 7 days", rate(t.handoffs, t.requests), "%", "under 2%", (v) => v < 2],
              ["Answers checked and right, 4 weeks", rate(checked.right, checked.reviewed), "%", "98% or more", (v) => v >= 98],
              ["Labelled requests the assistant got right", rate(t.labelled_right, t.labelled), "%", `${t.labelled} of 300 labelled`, () => t.labelled >= 300],
            ],
          ),
        )
      : null,
    panel(
      "The last 7 days",
      null,
      h(
        "ul",
        { class: "rows" },
        line("How requests were understood", shares(s.understood7d, byLabel, "by")),
        line("What customers got", shares(s.matched7d, matchLabel, "match")),
        line(
          "\"Did you mean…?\"",
          questions.asked
            ? `asked ${questions.asked}, a category picked ${questions.picked}, "something else" ${questions.something_else}; customers said we got it wrong ${questions.flagged ?? 0} times`
            : "none asked",
        ),
        line(
          "Word lists",
          [
            ["sn", "Shona"],
            ["nd", "Ndebele"],
          ]
            .map(([lang, name]) => `${name}: ${wordCount(lang, "approved")} approved, ${wordCount(lang, "draft")} waiting for a native speaker`)
            .join(" · "),
        ),
        line("Claude, 7 days", `${num(s.claude.last7Days?.calls ?? 0)} calls, ${usd(s.claude.last7Days?.usd)}; at most ${s.claude.perNumberPerDay} a number a day`),
      ),
    ),
    cat ? productsPanel(cat) : null,
    panel(
      "Set-up",
      null,
      h(
        "ul",
        { class: "rows" },
        line("Last message in", s.last_inbound_at ? dateTime(s.last_inbound_at) : "none yet"),
        line("Last reply out", s.last_sent_at ? dateTime(s.last_sent_at) : "none yet"),
        line("Database", s.database),
        line("WhatsApp", s.whatsapp === "off" ? "Off: before launch, not connected yet" : s.whatsapp),
        line("Photos stored on", s.storage),
        line("Understanding", s.features.understanding),
        line("Alerts go to", s.features.alertsTo),
        line("Limits per number", `${s.limits.perMinute} a minute, ${s.limits.perDay} a day, ${s.limits.mediaPerDay} photos and voice notes a day`),
        line("Kept for", `chats ${s.retention.messageDays} days, request wording ${s.retention.requestDays} days`),
      ),
    ),
    panel(
      "Recent alerts",
      "Since the last restart.",
      table(
        [
          { label: "When", render: (a) => dateTime(a.at) },
          { label: "Alert", wrap: true, key: "text" },
        ],
        s.alerts,
        { empty: "No alerts." },
      ),
    ),
  ];
}

// ---------- Your account ----------

async function account() {
  const current = h("input", { class: "input", type: "password", autocomplete: "current-password", required: true });
  const next = h("input", { class: "input", type: "password", autocomplete: "new-password", minlength: "10", required: true });
  return [
    pageHead("Your account", `Signed in as ${S.me.name} (${S.me.role === "admin" ? "admin" : "staff"}).`),
    S.me.userId
      ? h(
          "section",
          { class: "card panel" },
          h("div", { class: "panel-head" }, h("div", {}, h("h2", { text: "Change your password" }), h("p", { text: "At least 10 characters. You'll sign in again afterwards." }))),
          h(
            "form",
            {
              class: "form-inline",
              onsubmit: (e) => {
                e.preventDefault();
                busy(e.submitter, async () => {
                  await post("/me/password", { current: current.value, password: next.value });
                  store.set(TOKEN_KEY, "");
                  showLogin("Your password is changed. Sign in with the new one.");
                });
              },
            },
            field("Current password", current),
            field("New password", next),
            h("button", { class: "btn", type: "submit" }, "Change password"),
          ),
        )
      : h("p", { class: "notice", text: "You're using the shared ops token or the development login, which have no password. Add personal accounts under Team accounts." }),
    h("div", { class: "section-gap" }, h("button", { class: "btn btn-secondary", type: "button", onclick: signOut }, icon("out"), "Sign out")),
  ];
}

const INSIGHTS = insightScreens({
  get,
  track: (fn) => S.cleanup.push(fn),
  stale,
  onSummary: (summary) => {
    S.counts = summary;
    updateBadges();
  },
  openBusiness,
});

const SCREENS = {
  overview: INSIGHTS.overview,
  demand: INSIGHTS.demand,
  supply: INSIGHTS.supply,
  experience: INSIGHTS.experience,
  chats,
  reports,
  people,
  businesses,
  verify,
  signups,
  callbacks,
  rechecks,
  tips,
  requests,
  gaps,
  vocabulary,
  words,
  check,
  label,
  agents,
  team,
  activity,
  system,
  account,
};

// ---------- Start ----------

window.addEventListener("hashchange", () => {
  if (!S.me) return;
  // A new filter on the same report keeps the page in view, dimmed, until the new numbers arrive.
  const same = route().name === shownRoute && REPORTS.has(shownRoute);
  renderRoute(same ? { keepScroll: true, dim: true } : {});
});

async function boot() {
  try {
    [S.me] = await Promise.all([get("/me"), brand()]);
  } catch (err) {
    if (err.status === 401) return; // the sign-in page is showing
    root.replaceChildren(
      h(
        "div",
        { class: "auth" },
        h(
          "div",
          { class: "card auth-card" },
          h("h1", { text: "We couldn't load the admin portal" }),
          h("p", { class: "notice bad", text: err.message }),
          h("button", { class: "btn btn-lg", type: "button", onclick: () => location.reload() }, "Try again"),
        ),
      ),
    );
    return;
  }
  renderShell();
  refreshCounts();
}

boot();
