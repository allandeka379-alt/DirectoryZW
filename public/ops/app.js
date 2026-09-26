// Ops console: a thin page over /ops/api. The session token is kept in this browser only.

const TOKEN_KEY = "ops.token";
const view = document.getElementById("view");
/** The signed-in person: { name, role }. */
let me = null;

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

const store = {
  get: (k) => { try { return localStorage.getItem(k) || ""; } catch { return ""; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* blocked */ } },
};

class Unauthorized extends Error {}

async function api(path, options = {}) {
  const token = store.get(TOKEN_KEY);
  const res = await fetch(`/ops/api${path}`, {
    ...options,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(options.body ? { "Content-Type": "application/json" } : {}) },
  });
  if (res.status === 401 && path !== "/login") throw new Unauthorized();
  const body = res.headers.get("content-type")?.includes("json") ? await res.json() : await res.blob();
  if (!res.ok) throw new Error(typeof body?.error === "string" ? body.error : body?.error ? JSON.stringify(body.error) : `Request failed (${res.status})`);
  return body;
}
const post = (path, body) => api(path, { method: "POST", body: JSON.stringify(body ?? {}) });

/** Save a JSON response as a file (data exports). */
async function download(path, filename) {
  const data = await api(path);
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const a = h("a", { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Save a file the API sends (a spreadsheet export). */
async function downloadFile(path, filename) {
  const blob = await api(path);
  const url = URL.createObjectURL(blob);
  const a = h("a", { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

const isAdmin = () => me?.role === "admin";

/** A category picker, grouped like the categories list. */
function categorySelect(categories, placeholder = "Choose a category…") {
  return h("select", {},
    h("option", { value: "" }, placeholder),
    ...categories
      .filter((c) => c.risk !== "blocked")
      .map((c) => h("option", { value: c.slug }, `${c.group_name} › ${c.name}${c.risk === "normal" ? "" : ` (${c.risk})`}`)));
}

/** What the assistant made of a request, in a line: "read as Plumbers or Builders; didn't know: xyz". */
function readingLine(reading, nameOf) {
  if (!reading) return "";
  const parts = [];
  if (reading.candidates?.length) parts.push(`could be ${reading.candidates.map(nameOf).join(" or ")}`);
  else parts.push("no category recognised");
  if (reading.unknown?.length) parts.push(`words it didn't know: ${reading.unknown.join(", ")}`);
  return `The assistant's reading: ${parts.join("; ")}.`;
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

const RECHECK_LABELS = { still_good: "still good", unverified: "✅ removed", paused: "paused" };

const date = (v) => (v ? new Date(v).toLocaleString() : "");
const day = (v) => (v ? new Date(v).toLocaleDateString() : "");

function table(columns, rows, onRowClick) {
  return h("div", { class: "table-wrap" },
    h("table", {},
      h("thead", {}, h("tr", {}, ...columns.map((c) => h("th", { class: c.num ? "num" : null }, c.label)))),
      h("tbody", {}, ...(rows.length
        ? rows.map((r) => h("tr", { class: onRowClick ? "click" : null, onclick: onRowClick ? () => onRowClick(r) : null },
            ...columns.map((c) => h("td", { class: c.num ? "num" : null }, c.render ? c.render(r) : (r[c.key] ?? "")))))
        : [h("tr", {}, h("td", { colspan: String(columns.length), class: "muted" }, "Nothing here."))])),
    ));
}

function header(title, lead) {
  return [h("h1", {}, title), lead ? h("p", { class: "lead" }, lead) : null];
}

// ---------- screens ----------

const screens = {
  async overview() {
    const s = await api("/summary");
    const tile = (n, label) => h("div", { class: "tile" }, h("b", {}, n ?? 0), h("span", {}, label));
    return [
      ...header("Overview", "The last 7 days, plus what's waiting for the team."),
      h("div", { class: "tiles" },
        tile(s.verified_businesses, "Verified businesses"),
        tile(s.registered_businesses, "Not yet verified"),
        tile(s.requests_7d, "Requests, 7 days"),
        tile(s.no_results_7d, "No results, 7 days"),
        tile(s.introductions_7d, "Customers connected, 7 days"),
        tile(s.open_handoffs, "Chats waiting for a person"),
        tile(s.open_reports, "Open reports"),
        tile(s.reports_over_a_day, "Reports waiting over a day"),
        tile(s.active_agents, "Active field agents"),
        tile(s.new_recommendations, "New customer tips"),
      ),
    ];
  },

  async handoffs() {
    const [chats, categories] = await Promise.all([api("/handoffs"), api("/categories")]);
    return [
      ...header("Handoffs", "Customers waiting for a person: they asked for one, we had no supplier for them, or we couldn't understand them. Replies go out on the customer number. Tell the assistant what they wanted, and it answers the same wording itself next time."),
      ...(chats.length ? chats.map((chat) => handoffCard(chat, categories)) : [h("p", { class: "muted" }, "No one is waiting.")]),
    ];
  },

  async gaps() {
    const days = Number(new URLSearchParams(location.hash.split("?")[1]).get("days")) || 7;
    const rows = await api(`/supply-gaps?days=${days}`);
    return [
      ...header("Supply gaps", "What people asked for that no supplier in its own category could answer: they got related suppliers, or a person took over. Send field teams here first."),
      h("p", { class: "row" }, "Period: ",
        h("select", { onchange: (e) => { location.hash = `gaps?days=${e.target.value}`; } },
          ...[7, 30, 90].map((d) => h("option", { value: String(d), selected: d === days || null }, `${d} days`)))),
      table([
        { label: "Category", key: "category" },
        { label: "Area", key: "area" },
        { label: "Requests", key: "requests", num: true },
        { label: "Recent examples", render: (r) => (r.examples || []).join(" · ") },
      ], rows),
    ];
  },

  async reports() {
    const rows = await api("/reports");
    const act = (r, status) => async () => { await post(`/reports/${r.id}/status`, { status }); render(); };
    return [
      ...header("Reports", "Customers' complaints about businesses."),
      table([
        { label: "When", render: (r) => date(r.created_at) },
        { label: "Business", render: (r) => h("span", {}, r.business, " ", h("span", { class: "tag" }, r.verification),
          r.business_status !== "active" ? [" ", h("span", { class: "tag warn" }, r.business_status)] : null) },
        { label: "What happened", render: (r) => h("span", {}, r.reason, r.had_introduction ? [" ", h("span", { class: "tag ok", title: "They connected with this business through us" }, "contacted them via us")] : null) },
        { label: "", render: (r) => h("div", { class: "row" },
          h("button", { onclick: act(r, "reviewed") }, "Reviewed"),
          h("button", { onclick: async () => { await post(`/businesses/${r.business_id}/status`, { status: "paused" }); await act(r, "actioned")(); } }, "Pause business")) },
      ], rows),
    ];
  },

  async verify() {
    const rows = await api("/verification-queue");
    return [
      ...header("To verify", "Businesses that signed up themselves. Visit, check premises and ID, then mark verified."),
      table([
        { label: "Area", render: (r) => [r.area, r.city].filter(Boolean).join(", ") },
        { label: "Business", key: "name" },
        { label: "Phone", render: (r) => h("a", { href: `tel:+${r.phone}` }, `+${r.phone}`) },
        { label: "What they do", key: "description" },
        { label: "Signed up", render: (r) => day(r.created_at) },
        { label: "", render: (r) => h("button", { onclick: async () => {
          await post(`/businesses/${r.id}/verify`);
          render();
        } }, "Mark verified") },
      ], rows),
    ];
  },

  async audits() {
    const q = new URLSearchParams(location.hash.split("?")[1]);
    const percent = Number(q.get("percent")) || 10;
    const rows = await api(`/audits/queue?days=14&percent=${percent}`);
    const outcomes = [["confirmed", "Confirmed"], ["details_wrong", "Details wrong"], ["wrong_number", "Wrong number"], ["not_a_business", "Not a business"], ["refused", "Refused to talk"]];
    return [
      ...header("Call-backs", "Phone a random share of each agent's recent registrations. A wrong number or fake business hides the listing."),
      h("p", { class: "row" }, "Check ",
        h("select", { onchange: (e) => { location.hash = `audits?percent=${e.target.value}`; } },
          ...[5, 10, 20, 50, 100].map((p) => h("option", { value: String(p), selected: p === percent || null }, `${p}%`))),
        " of each agent's registrations from the last 14 days."),
      table([
        { label: "Agent", key: "agent" },
        { label: "Business", render: (r) => h("span", {}, r.name, " ", h("span", { class: "tag" }, r.verification)) },
        { label: "Phone", render: (r) => h("a", { href: `tel:+${r.phone}` }, `+${r.phone}`) },
        { label: "Area", key: "area" },
        { label: "Registered", render: (r) => day(r.created_at) },
        { label: "Result", render: (r) => {
          const outcome = h("select", {}, ...outcomes.map(([v, l]) => h("option", { value: v }, l)));
          const note = h("input", { placeholder: "Note (optional)" });
          return h("div", { class: "row" }, outcome, note, h("button", { class: "primary", onclick: async () => {
            await post(`/businesses/${r.id}/audit`, { outcome: outcome.value, note: note.value || undefined });
            render();
          } }, "Save"));
        } },
      ], rows),
    ];
  },

  async rechecks() {
    const rows = await api("/rechecks");
    const outcomes = [["still_good", "Still good: renew ✅"], ["unverified", "Remove ✅"], ["paused", "Pause the listing"]];
    const detail = h("div");
    return [
      ...header("Re-checks", "Verified businesses to look at again: customers let down, open reports, low ratings, or verified over a year ago. " +
        "Visit or phone them, then record what you found. We tell customers that verified businesses are genuine and reliable, so this list is how we keep that true."),
      detail,
      table([
        { label: "Business", render: (r) => h("span", {}, r.name, r.status !== "active" ? [" ", h("span", { class: "tag warn" }, r.status)] : null, " ",
          h("button", { onclick: async () => { detail.replaceChildren(await businessDetail(r.id)); window.scrollTo(0, 0); } }, "Details")) },
        { label: "Phone", render: (r) => h("a", { href: `tel:+${r.phone}` }, `+${r.phone}`) },
        { label: "Area", render: (r) => [r.area, r.city].filter(Boolean).join(", ") },
        { label: "Why", render: (r) => h("ul", { class: "reasons" }, ...r.reasons.map((reason) => h("li", {}, reason))) },
        { label: "Verified", render: (r) => day(r.verified_at) },
        { label: "What you found", render: (r) => {
          const outcome = h("select", {}, ...outcomes.map(([v, l]) => h("option", { value: v }, l)));
          const note = h("input", { placeholder: "What you found (optional)" });
          return h("div", { class: "row" }, outcome, note, h("button", { class: "primary", onclick: async () => {
            await post(`/businesses/${r.id}/recheck`, { outcome: outcome.value, reasons: r.reasons, note: note.value || undefined });
            render();
          } }, "Save"));
        } },
      ], rows),
    ];
  },

  async agents() {
    const rows = await api("/agents");
    const result = h("div");
    const showLink = (agent, url) => result.replaceChildren(h("div", { class: "notice" },
      h("strong", {}, `Setup link for ${agent}`),
      h("p", { class: "muted" }, "Send it to the agent on WhatsApp and have them open it on their phone. Anyone with the link can register businesses as this agent, so make a new one if it's shared or lost."),
      h("div", { class: "setup" }, url),
      h("p", {}, h("button", { onclick: () => navigator.clipboard?.writeText(url) }, "Copy link"))));
    const name = h("input", { placeholder: "Full name", required: true });
    const phone = h("input", { placeholder: "Phone (optional)" });
    const city = h("input", { placeholder: "City (optional)" });
    const form = h("form", { class: "inline", onsubmit: async (e) => {
      e.preventDefault();
      const created = await post("/agents", { name: name.value, phone: phone.value || undefined, city: city.value || undefined });
      showLink(created.agent.name, created.setupUrl);
      name.value = phone.value = city.value = "";
      refreshTable();
    } }, name, phone, city, h("button", { class: "primary" }, "Add agent"));
    const tableBox = h("div");
    const refreshTable = async () => {
      const list = await api("/agents");
      tableBox.replaceChildren(agentTable(list));
    };
    const agentTable = (list) => table([
      { label: "Agent", render: (r) => h("span", {}, r.name, r.active ? "" : " ", r.active ? null : h("span", { class: "tag bad" }, "inactive")) },
      { label: "City", key: "city" },
      { label: "Last seen", render: (r) => date(r.last_seen_at) || "never" },
      { label: "7 days", key: "registered_7d", num: true },
      { label: "30 days", key: "registered_30d", num: true },
      { label: "Verified (30d)", key: "verified_30d", num: true },
      { label: "Call-backs passed", num: true, render: (r) => {
        const total = r.audits_passed + r.audits_failed;
        return total ? `${Math.round((100 * r.audits_passed) / total)}% of ${total}` : "none yet";
      } },
      { label: "Got customers", key: "with_customers", num: true },
      { label: "", render: (r) => h("div", { class: "row" },
        h("button", { onclick: async () => showLink(r.name, (await post(`/agents/${r.id}/token`)).setupUrl) }, "New link"),
        h("button", { class: r.active ? "danger" : null, onclick: async () => { await post(`/agents/${r.id}/active`, { active: !r.active }); refreshTable(); } }, r.active ? "Deactivate" : "Reactivate")) },
    ], list);
    tableBox.replaceChildren(agentTable(rows));
    return [...header("Field agents", "Add agents, send them their setup link, and watch quality."), h("div", { class: "card" }, form, result), tableBox];
  },

  async tips() {
    const rows = await api("/recommendations?status=new");
    const act = (r, status) => async () => { await post(`/recommendations/${r.id}/status`, { status }); render(); };
    return [
      ...header("Customer tips", "Businesses customers recommended. Visit or call them, then register them in the field app."),
      table([
        { label: "When", render: (r) => day(r.created_at) },
        { label: "Business", render: (r) => h("span", {}, h("strong", {}, r.name), r.already_listed ? [" ", h("span", { class: "tag ok" }, "already listed")] : null, r.times_recommended > 1 ? [" ", h("span", { class: "tag" }, `${r.times_recommended} tips`)] : null) },
        { label: "What they do", key: "what" },
        { label: "Category", key: "category" },
        { label: "Area", render: (r) => [r.area, r.city].filter(Boolean).join(", ") },
        { label: "Phone", render: (r) => (r.phone ? h("a", { href: `tel:+${r.phone}` }, `+${r.phone}`) : h("span", { class: "muted" }, "not given")) },
        { label: "", render: (r) => h("div", { class: "row" },
          h("button", { onclick: act(r, "contacted") }, "Contacted"),
          h("button", { class: "primary", onclick: act(r, "listed") }, "Listed"),
          h("button", { class: "danger", onclick: act(r, "rejected") }, "Not suitable")) },
      ], rows),
    ];
  },

  async vocabulary() {
    const [rows, categories, suggestions] = await Promise.all([api("/unmatched?days=30"), api("/categories"), api("/vocabulary/suggestions")]);
    const options = categories.map((c) => h("option", { value: c.slug }, `${c.group_name} › ${c.name}${c.risk === "normal" ? "" : ` (${c.risk})`}`));
    const status = h("p", { class: "muted" });
    const addWord = async (slug, word) => {
      const res = await post(`/categories/${encodeURIComponent(slug)}/synonyms`, { add: [word] });
      status.textContent = `Added "${word}". Words added so far for this category: ${res.extra_synonyms.join(", ")}`;
    };
    const word = h("input", { placeholder: "Word or phrase customers use", required: true });
    const pick = h("select", {}, ...options.map((o) => o.cloneNode(true)));
    const form = h("form", { class: "inline", onsubmit: async (e) => {
      e.preventDefault();
      if (!word.value.trim()) return;
      await addWord(pick.value, word.value.trim());
      word.value = "";
    } }, word, pick, h("button", { class: "primary" }, "Add word"));
    return [
      ...header("Vocabulary", "Words customers use that the assistant didn't know, and searches that matched no category. Add the words to the right category so the next customer is understood straight away. Shona and English word meanings are in the Word list."),
      h("div", { class: "card" }, form, status),
      h("h2", {}, "Suggested words"),
      h("p", { class: "muted" }, "Words the assistant didn't know, with what they turned out to mean: a person's answer, the customer's own pick, or Claude's. Add the ones that nearly always mean one category."),
      table([
        { label: "Word", render: (r) => h("strong", {}, r.word) },
        { label: "Seen", key: "uses", num: true },
        { label: "Mostly meant", key: "category_name" },
        { label: "Agreement", num: true, render: (r) => h("span", { class: r.agreement >= 90 ? "tag ok" : r.agreement < 60 ? "tag warn" : "tag" }, `${r.agreement}%`) },
        { label: "Wording it came in", render: (r) => r.examples.join(" · ") },
        { label: "", render: (r) => h("button", { onclick: async () => {
          await addWord(r.category, r.word);
          render();
        } }, `Add to ${r.category_name}`) },
      ], suggestions),
      h("h2", {}, "Searches that matched no category"),
      table([
        { label: "Customers typed", key: "query" },
        { label: "Requests", key: "requests", num: true },
        { label: "No results", key: "no_results", num: true },
        { label: "Examples", render: (r) => (r.examples || []).join(" · ") },
        { label: "Add to category", render: (r) => {
          const select = h("select", {}, h("option", { value: "" }, "Choose…"), ...options.map((o) => o.cloneNode(true)));
          return h("div", { class: "row" }, select, h("button", { onclick: async () => {
            if (!select.value) return;
            await addWord(select.value, r.query);
            render();
          } }, "Add"));
        } },
      ], rows),
    ];
  },

  async words() {
    const q = new URLSearchParams(location.hash.split("?")[1]);
    const language = q.get("language") || "sn";
    const status = q.has("status") ? q.get("status") : "draft";
    const search = q.get("q") || "";
    const [rows, categories] = await Promise.all([api(`/lexicon?${new URLSearchParams({ language, status, q: search })}`), api("/categories")]);
    const go = (changes) => { location.hash = `words?${new URLSearchParams({ language, status, q: search, ...changes })}`; };
    const review = async (ids, next) => { if (ids.length) { await post("/lexicon/review", { ids, status: next }); render(); } };
    const picked = new Set();
    const searchBox = h("input", { type: "search", placeholder: "Find a word or meaning", value: search });

    const term = h("input", { placeholder: "Word, phrase or verb root", required: true });
    const lang = h("select", {}, h("option", { value: "sn" }, "Shona"), h("option", { value: "en" }, "English"), h("option", { value: "nd" }, "Ndebele"));
    lang.value = language;
    const role = h("select", {}, ...Object.entries(ROLE_LABELS).map(([v, l]) => h("option", { value: v }, l)));
    const category = categorySelect(categories, "Category it points to");
    const action = h("select", {}, h("option", { value: "" }, "Action (for action words)"),
      ...["repair", "make", "buy", "hire", "move", "dig", "build", "paint", "sew", "clean", "wash", "cook", "teach", "learn", "drive", "hair", "send", "install", "print"].map((a) => h("option", { value: a }, a)));
    const root = h("input", { type: "checkbox" });
    const gloss = h("input", { placeholder: "Meaning in English" });
    const addStatus = h("p", { class: "muted" });
    const addForm = h("form", { class: "inline", onsubmit: async (e) => {
      e.preventDefault();
      try {
        await post("/lexicon", {
          term: term.value, language: lang.value, role: role.value, categories: category.value ? [category.value] : [],
          action: action.value || null, root: root.checked, gloss: gloss.value,
        });
        addStatus.textContent = `Saved "${term.value}". It works straight away.`;
        term.value = gloss.value = "";
      } catch (err) {
        addStatus.replaceChildren(h("span", { class: "error" }, err.message));
      }
    } }, term, lang, role, category, action, h("label", { class: "row" }, root, "verb root"), gloss, h("button", { class: "primary" }, "Save word"));

    return [
      ...header("Word list", "What words mean to the assistant. The Shona and Ndebele lists are first drafts by the developers: a native speaker should check each word. Until a word is approved, requests that depend on it get a \"Did you mean…?\" question instead of a straight answer."),
      h("div", { class: "row" },
        h("select", { onchange: (e) => go({ language: e.target.value }) },
          ...[["sn", "Shona"], ["en", "English"], ["nd", "Ndebele"]].map(([v, l]) => h("option", { value: v, selected: v === language || null }, l))),
        h("select", { onchange: (e) => go({ status: e.target.value }) },
          ...[["draft", "To review"], ["approved", "Approved"], ["rejected", "Rejected"], ["", "All"]].map(([v, l]) => h("option", { value: v, selected: v === status || null }, l))),
        h("form", { class: "inline", onsubmit: (e) => { e.preventDefault(); go({ q: searchBox.value }); } }, searchBox, h("button", {}, "Find")),
        h("button", { onclick: () => downloadFile(`/lexicon/export.csv?${new URLSearchParams({ language, status })}`, `word-list-${language}.csv`) }, "Download as a spreadsheet")),
      h("p", { class: "row" },
        h("button", { class: "primary", onclick: () => review([...picked], "approved") }, "Approve ticked"),
        h("button", { class: "danger", onclick: () => review([...picked], "rejected") }, "Reject ticked"),
        h("span", { class: "muted" }, `${rows.length} words. "Customers agreed" counts people who picked the word's category when asked.`)),
      table([
        { label: "", render: (r) => h("input", { type: "checkbox", onchange: (e) => (e.target.checked ? picked.add(r.id) : picked.delete(r.id)) }) },
        { label: "Word", render: (r) => h("span", {}, h("strong", {}, r.term), r.forms.length ? h("div", { class: "muted" }, `verb root: ${r.forms.join(", ")}`) : null) },
        { label: "Meaning", key: "gloss" },
        { label: "What it does", render: (r) => [ROLE_LABELS[r.role] || r.role, r.category_names.length ? `→ ${r.category_names.join(" or ")}` : null, r.action ? `(${r.action})` : null].filter(Boolean).join(" ") },
        { label: "Customers agreed", key: "confirmed", num: true },
        { label: "Status", render: (r) => h("span", {}, h("span", { class: `tag ${r.status === "approved" ? "ok" : r.status === "rejected" ? "bad" : "warn"}` }, r.status === "draft" ? "to review" : r.status),
          r.reviewed_by ? h("div", { class: "muted" }, `${r.reviewed_by}, ${day(r.reviewed_at)}`) : null) },
        { label: "", render: (r) => h("div", { class: "row" },
          r.status !== "approved" ? h("button", { onclick: () => review([r.id], "approved") }, "Right") : null,
          r.status !== "rejected" ? h("button", { class: "danger", onclick: () => review([r.id], "rejected") }, "Wrong") : null) },
      ], rows),
      h("details", { class: "card" },
        h("summary", {}, "Add a word, or correct what one means"),
        h("p", { class: "muted" }, "Services and products point to a category. Actions change the category of what they apply to (\"gadzira\" + fridge = appliance repairs); tick \"verb root\" for a Shona root like \"gadzir\" so its forms (anogadzira, kugadzirisa) are recognised. Brands, occasions and general words only decide when nothing stronger is said."),
        addForm, addStatus),
    ];
  },

  async check() {
    const [rows, categories] = await Promise.all([api("/review/sample?limit=50"), api("/categories")]);
    const verdict = (r, v, category) => async () => { await post(`/requests/${r.id}/review`, { verdict: v, category }); render(); };
    return [
      ...header("Check answers", "Once a week, check the answers customers said were wrong, then a random sample of answers the assistant gave without asking anyone. Aim for 98% right. A wrong answer is fixed for that wording straight away; also tell the developers, so they can fix the word list or the rules."),
      table([
        { label: "When", render: (r) => day(r.created_at) },
        { label: "Customer wrote", key: "raw_text" },
        { label: "Assistant understood", render: (r) => h("span", {}, h("strong", {}, r.category_name || "no category"), r.area ? ` · ${r.area}` : "",
          r.flagged_at ? h("div", {}, h("span", { class: "tag bad" }, "customer said this was wrong")) : null) },
        { label: "Why", render: (r) => h("span", { class: "muted" }, (r.reading?.reasons || []).join("; ")) },
        { label: "", render: (r) => {
          const right = categorySelect(categories, "The right category…");
          return h("div", { class: "row" },
            h("button", { class: "primary", onclick: verdict(r, "right") }, "Right"),
            h("button", { onclick: verdict(r, "should_ask") }, "Should have asked"),
            right,
            h("button", { class: "danger", onclick: async () => {
              if (!right.value) return alert("Pick the right category first.");
              await verdict(r, "wrong", right.value)();
            } }, "Wrong"));
        } },
      ], rows),
    ];
  },

  async label() {
    const [next, summary, categories] = await Promise.all([api("/labels/next?limit=20"), api("/labels/summary"), api("/categories")]);
    const byLabel = { local: "Understood locally", phrasebook: "From the phrasebook", customer: "The customer picked", claude: "By Claude", photo: "From a photo", fallback: "Not understood" };
    const pct = (right, n) => (n ? `${Math.round((100 * right) / n)}%` : "-");
    // Ways a request can be labelled besides a category.
    const others = [
      ["search:", "Something we don't list"],
      ["greeting:", "Greeting or thanks"],
      ["out_of_scope:", "A question about something else"],
      ["human:", "Wants a person"],
      ["unclear:", "Too vague to tell"],
    ];
    const save = async (r, value) => {
      const [intent, category] = value.includes(":") ? value.split(":") : ["search", value];
      await post(`/requests/${r.id}/label`, { intent, category: category || null });
      render();
    };
    const pick = (r) => {
      const select = h("select", {},
        h("optgroup", { label: "Not a category" }, ...others.map(([v, l]) => h("option", { value: v }, l))),
        h("optgroup", { label: "Categories" }, ...categories.filter((c) => c.risk !== "blocked").map((c) => h("option", { value: c.slug }, `${c.group_name} › ${c.name}`))));
      select.value = r.intent === "search" || !r.intent ? (r.category_slug || "search:") : `${r.intent}:`;
      return select;
    };
    return [
      ...header("Label requests", `What did customers actually want? Label a random sample of real requests: about ${summary.target} are enough to tune the assistant and choose Claude's model (see "npm run eval"). A correction also teaches the assistant.`),
      h("div", { class: "tiles" },
        h("div", { class: "tile" }, h("b", {}, `${summary.labelled} of ${summary.target}`), h("span", {}, "Requests labelled")),
        h("div", { class: "tile" }, h("b", {}, pct(summary.right, summary.labelled)), h("span", {}, "The assistant was right"))),
      summary.byStep.length ? table([
        { label: "How it was understood", render: (r) => byLabel[r.by] || r.by || "(not recorded)" },
        { label: "Labelled", key: "labelled", num: true },
        { label: "Right", num: true, render: (r) => pct(r.right, r.labelled) },
      ], summary.byStep) : null,
      h("h2", {}, "To label"),
      next.requests.length ? table([
        { label: "Customer wrote", key: "raw_text" },
        { label: "The assistant", render: (r) => h("span", { class: "muted" },
          [r.category_name || (r.intent && r.intent !== "search" ? r.intent : "no category"), byLabel[r.understood_by] || r.understood_by].filter(Boolean).join(" · ")) },
        { label: "They wanted", render: (r) => {
          const select = pick(r);
          return h("div", { class: "row" }, select, h("button", { class: "primary", onclick: () => save(r, select.value) }, "Save"));
        } },
      ], next.requests) : h("p", { class: "muted" }, "Nothing left to label from the last 90 days."),
    ];
  },

  async people() {
    const q = new URLSearchParams(location.hash.split("?")[1]);
    const phone = h("input", { type: "search", placeholder: "Phone number, e.g. 0771234567", value: q.get("phone") || "" });
    const nodes = [
      ...header("People", "Find anyone who has messaged either number. Block abusive numbers. Admins can export or delete someone's data when they ask."),
      h("form", { class: "inline", onsubmit: (e) => { e.preventDefault(); location.hash = `people?${new URLSearchParams({ phone: phone.value })}`; } },
        phone, h("button", { class: "primary" }, "Find")),
    ];
    if (!q.get("phone")) return nodes;
    const rows = await api(`/contacts?${new URLSearchParams({ phone: q.get("phone") })}`);
    return [...nodes, ...(rows.length ? rows.map(contactCard) : [h("p", { class: "muted" }, "Nobody with that number has messaged us.")])];
  },

  async team() {
    const result = h("div");
    const showPassword = (label, password) => result.replaceChildren(h("div", { class: "notice" },
      h("strong", {}, label),
      h("p", { class: "muted" }, "Shown once. Pass it on privately; they can change it under Account."),
      h("div", { class: "setup" }, password)));
    const name = h("input", { placeholder: "Full name", required: true });
    const email = h("input", { type: "email", placeholder: "Email", required: true });
    const role = h("select", {}, h("option", { value: "staff" }, "Staff"), h("option", { value: "admin" }, "Admin"));
    const tableBox = h("div");
    const refresh = async () => tableBox.replaceChildren(table([
      { label: "Name", render: (u) => h("span", {}, u.name, u.active ? null : [" ", h("span", { class: "tag bad" }, "switched off")]) },
      { label: "Email", key: "email" },
      { label: "Role", render: (u) => u.role },
      { label: "Last sign-in", render: (u) => date(u.last_login_at) || "never" },
      { label: "", render: (u) => h("div", { class: "row" },
        h("button", { onclick: async () => {
          const r = await post(`/users/${u.id}`, { resetPassword: true });
          showPassword(`New password for ${u.email}`, r.password);
        } }, "New password"),
        h("button", { onclick: async () => { await post(`/users/${u.id}`, { role: u.role === "admin" ? "staff" : "admin" }); refresh(); } },
          u.role === "admin" ? "Make staff" : "Make admin"),
        h("button", { class: u.active ? "danger" : null, onclick: async () => { await post(`/users/${u.id}`, { active: !u.active }); refresh(); } },
          u.active ? "Switch off" : "Switch on")) },
    ], await api("/users")));
    await refresh();
    return [
      ...header("Team", "One account per person, so the activity log shows who did what. Staff handle chats, reports and listings; admins also manage agents, the team and people's data."),
      h("div", { class: "card" },
        h("form", { class: "inline", onsubmit: async (e) => {
          e.preventDefault();
          const r = await post("/users", { name: name.value, email: email.value, role: role.value });
          showPassword(`Password for ${r.user.email}`, r.password);
          name.value = email.value = "";
          refresh();
        } }, name, email, role, h("button", { class: "primary" }, "Add person")),
        result),
      tableBox,
    ];
  },

  async activity() {
    const rows = await api("/activity?limit=300");
    return [
      ...header("Activity", "Who did what in the console, newest first."),
      table([
        { label: "When", render: (r) => date(r.created_at) },
        { label: "Who", key: "actor" },
        { label: "What", key: "action" },
        { label: "On", render: (r) => r.target || "" },
        { label: "Details", render: (r) => Object.entries(r.details || {}).filter(([, v]) => v != null && v !== "").map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`).join(" · ") },
      ], rows),
    ];
  },

  async system() {
    const s = await api("/system");
    const tile = (n, label, bad) => h("div", { class: `tile${bad ? " alert" : ""}` }, h("b", {}, n ?? 0), h("span", {}, label));
    const f = s.features;
    const usd = (n) => `$${Number(n || 0).toFixed(2)}`;
    const spentToday = s.claude.today.reduce((sum, r) => sum + r.usd, 0);
    const callsToday = s.claude.today.reduce((sum, r) => sum + r.calls, 0);
    const byLabel = { local: "Understood locally", phrasebook: "From the phrasebook", customer: "The customer picked (Did you mean…?)", claude: "By Claude", photo: "From a photo", fallback: "Not understood" };
    const questions = s.questions7d || { asked: 0, picked: 0, something_else: 0 };
    const check = s.precision28d || { reviewed: 0, right: 0 };
    const wordCount = (lang, st) => s.lexicon?.words.find((w) => w.language === lang && w.status === st)?.words ?? 0;
    const matchLabel = { exact: "Suppliers in their category", related: "Related suppliers only", none: "Handed to a person" };
    const shares = (rows, labels, key) => {
      const total = rows.reduce((sum, r) => sum + r.requests, 0);
      return rows.length
        ? rows.map((r) => `${labels[r[key]] || r[key]}: ${r.requests} (${Math.round((100 * r.requests) / total)}%)`).join(" · ")
        : "no requests yet";
    };
    return [
      ...header("System", `Version ${s.version} · ${s.env} · running since ${date(s.startedAt)}`),
      h("div", { class: "tiles" },
        tile(s.inbound_unprocessed, "Messages waiting to be handled", s.inbound_unprocessed > 0),
        tile(s.outbound_retrying, "Replies being retried", s.outbound_retrying > 0),
        tile(s.outbound_failed_24h, "Replies failed, 24 hours", s.outbound_failed_24h > 0),
        tile(s.jobs_due, "Background jobs due"),
        tile(s.jobs_failed_24h, "Background jobs failed, 24 hours", s.jobs_failed_24h > 0),
        tile(usd(spentToday), `Claude today, of ${usd(s.claude.dailyBudgetUsd)}`, spentToday >= 0.8 * s.claude.dailyBudgetUsd && s.claude.dailyBudgetUsd > 0),
        tile(callsToday, "Claude calls today"),
      ),
      costsCard(s.costs),
      targetsCard(s),
      h("div", { class: "card" },
        h("p", {}, h("strong", {}, "Requests, last 7 days: "), shares(s.understood7d, byLabel, "by")),
        h("p", {}, h("strong", {}, "Results, last 7 days: "), shares(s.matched7d, matchLabel, "match")),
        h("p", {}, h("strong", {}, "\"Did you mean…?\", last 7 days: "),
          questions.asked ? `asked ${questions.asked}, a category picked ${questions.picked}, "something else" ${questions.something_else}, no answer ${questions.asked - questions.picked - questions.something_else}` : "none asked",
          `. Customers said we got it wrong: ${questions.flagged ?? 0}.`),
        h("p", {}, h("strong", {}, "Answers checked, last 4 weeks: "),
          check.reviewed ? `${check.reviewed} checked, ${Math.round((100 * check.right) / check.reviewed)}% right (aim: 98%)` : "none yet (see Check answers)"),
        h("p", {}, h("strong", {}, "Word lists: "),
          [["sn", "Shona"], ["nd", "Ndebele"]].map(([lang, name]) =>
            `${name} ${wordCount(lang, "approved")} approved, ${wordCount(lang, "draft")} waiting for a native speaker, ${wordCount(lang, "rejected")} rejected`).join("; ") +
          (s.lexicon?.trustDrafts ? ". Draft words are trusted (LEXICON_TRUST_DRAFTS)." : ". Draft words lead to a question until approved.")),
        h("p", { class: "muted" },
          `Claude, last 7 days: ${s.claude.last7Days?.calls ?? 0} calls, ${usd(s.claude.last7Days?.usd)}. ` +
          `Today by use: ${s.claude.today.map((r) => `${r.feature} ${r.calls} (${usd(r.usd)})`).join(", ") || "none"}. ` +
          `At most ${s.claude.perNumberPerDay} Claude calls per number a day.`)),
      h("div", { class: "card" },
        h("p", {}, `Last message in: ${date(s.last_inbound_at) || "none yet"} · last reply out: ${date(s.last_sent_at) || "none yet"}`),
        h("p", {}, `Database: ${s.database} · WhatsApp: ${s.whatsapp} · photos stored on: ${s.storage}`),
        h("p", {}, `Understanding requests: ${f.understanding} · typed messages only · alerts: ${f.alertsTo}`),
        h("p", { class: "muted" }, `Limits per number: ${s.limits.perMinute} a minute, ${s.limits.perDay} a day, ${s.limits.mediaPerDay} photos and voice notes a day. Chats kept ${s.retention.messageDays} days; request wording kept ${s.retention.requestDays} days.`)),
      h("h2", {}, "Recent alerts"),
      s.alerts.length
        ? table([{ label: "When", render: (a) => date(a.at) }, { label: "Alert", key: "text" }], s.alerts)
        : h("p", { class: "muted" }, "No alerts since the last restart."),
    ];
  },

  async account() {
    const current = h("input", { type: "password", placeholder: "Current password", autocomplete: "current-password", required: true });
    const next = h("input", { type: "password", placeholder: "New password (10+ characters)", autocomplete: "new-password", minlength: "10", required: true });
    const message = h("p");
    return [
      ...header("Account", `Signed in as ${me.name} (${me.role}).`),
      me.userId
        ? h("form", { class: "inline card", onsubmit: async (e) => {
            e.preventDefault();
            try {
              await post("/me/password", { current: current.value, password: next.value });
              store.set(TOKEN_KEY, "");
              me = null;
              render();
            } catch (err) {
              message.replaceChildren(h("span", { class: "error" }, err.message));
            }
          } }, current, next, h("button", { class: "primary" }, "Change password"), message)
        : h("p", { class: "muted" }, "You're using the shared ops token or the development login, which have no password to change."),
      h("p", {}, h("button", { onclick: signOut }, "Sign out")),
    ];
  },

  async businesses() {
    const q = new URLSearchParams(location.hash.split("?")[1]);
    const search = h("input", { type: "search", placeholder: "Name or phone", value: q.get("q") || "" });
    const verification = h("select", {},
      ...[["", "Any status"], ["verified", "Verified"], ["registered", "Not yet verified"]].map(([v, l]) => h("option", { value: v, selected: q.get("verification") === v || null }, l)));
    const params = new URLSearchParams({ q: search.value, verification: verification.value });
    const rows = await api(`/businesses?${params}`);
    const detail = h("div");
    return [
      ...header("Businesses"),
      h("form", { class: "inline", onsubmit: (e) => {
        e.preventDefault();
        location.hash = `businesses?${new URLSearchParams({ q: search.value, verification: verification.value })}`;
      } }, search, verification, h("button", { class: "primary" }, "Search")),
      h("p"),
      detail,
      table([
        { label: "Business", key: "name" },
        { label: "Phone", render: (r) => `+${r.phone}` },
        { label: "Area", key: "area" },
        { label: "Status", render: (r) => h("span", { class: "row" },
          h("span", { class: `tag ${r.verification === "verified" ? "ok" : ""}` }, r.verification),
          r.status !== "active" ? h("span", { class: "tag warn" }, r.status) : null,
          r.audit_status ? h("span", { class: `tag ${r.audit_status === "failed" ? "bad" : "ok"}` }, `call-back ${r.audit_status}`) : null) },
        { label: "Source", render: (r) => (r.agent ? `field · ${r.agent}` : r.source) },
        { label: "Added", render: (r) => day(r.created_at) },
      ], rows, async (r) => { detail.replaceChildren(await businessDetail(r.id)); window.scrollTo(0, 0); }),
    ];
  },
};

/** What running the service costs: Claude and paid WhatsApp templates (docs/HARDENING.md). */
function costsCard(c) {
  if (!c) return null;
  const usd = (n) => `$${Number(n || 0).toFixed(2)}`;
  const set = c.settings;
  return h("div", { class: "card" },
    h("h2", {}, "Running costs"),
    h("p", {}, h("strong", {}, "Today: "), `Claude ${usd(c.today.claudeUsd)} · ${c.today.templates} paid WhatsApp templates (${usd(c.today.templatesUsd)})`),
    h("p", {}, h("strong", {}, "This month: "),
      `Claude ${usd(c.month.claudeUsd)} · ${c.month.templates} templates (${usd(c.month.templatesUsd)}) · heading for ${usd(c.projectedMonthUsd)}` +
      (c.per1000RequestsUsd != null ? ` · ${usd(c.per1000RequestsUsd)} per 1,000 requests (${c.month.requests} so far)` : "")),
    h("p", { class: "muted" },
      `Replies inside a customer's 24-hour window are free. Templates, at about ${usd(c.templatePriceUsd)} each, go out only when: ` +
      `lead notices ${set.leadNotices === "always" ? "always" : "never (only free ones)"} · ` +
      `follow-ups ${set.paidFollowUps ? "when the window has closed" : "never (sent free, " + set.followUpDelayHours + " hours after connecting)"} · ` +
      `weekly summaries ${set.weeklySummaries === "always" ? "every Monday" : set.weeklySummaries === "window_only" ? "never (only free ones)" : "off"} · ` +
      `at most ${set.templateDailyCap} a day.`));
}

/** Where the assistant stands against the targets in docs/UNDERSTANDING.md. */
function targetsCard(s) {
  const t = s.targets;
  if (!t) return null;
  const check = s.precision28d || { reviewed: 0, right: 0 };
  const rate = (n, of) => (of ? Math.round((100 * n) / of) : null);
  const rows = [
    ["Understood without Claude, last 7 days", rate(t.without_claude, t.requests), "%", "80% or more", (v) => v >= 80],
    ["Claude calls per 100 requests, last 7 days", t.requests ? Math.round((100 * t.claude_calls) / t.requests) : null, "", "10 or fewer", (v) => v <= 10],
    ["Handed to a person, last 7 days", rate(t.handoffs, t.requests), "%", "under 2%", (v) => v < 2],
    ["Answers checked and right, last 4 weeks", rate(check.right, check.reviewed), "%", "98% or more", (v) => v >= 98],
    ["Labelled real requests the assistant got right", rate(t.labelled_right, t.labelled), "%", `${t.labelled} of 300 labelled`, () => t.labelled >= 300],
  ];
  return h("div", { class: "card" },
    h("p", {}, h("strong", {}, "Targets")),
    table([
      { label: "Measure", render: (r) => r[0] },
      { label: "Now", num: true, render: (r) => (r[1] == null ? "no data yet" : `${r[1]}${r[2]}`) },
      { label: "Target", render: (r) => r[3] },
      { label: "", render: (r) => (r[1] == null ? "" : h("span", { class: `tag ${r[4](r[1]) ? "ok" : "warn"}` }, r[4](r[1]) ? "on target" : "not yet")) },
    ], rows),
    h("p", { class: "muted" },
      `Straight answers allow ${Object.entries(s.local.unknownWords).map(([l, n]) => `${l} ${n}`).join(", ")} unknown words (LOCAL_UNKNOWN_WORDS); ` +
      `the classifier offers guesses from ${Math.round(100 * s.local.classifierMin)}% (LOCAL_CLASSIFIER_MIN). Tune them with npm run eval -- --tune on labelled requests.`));
}

/** "3h 20m left" for a chat's free-reply window, or null once it has closed. */
function windowLeft(closesAt) {
  const ms = closesAt ? new Date(closesAt).getTime() - Date.now() : 0;
  if (ms <= 0) return null;
  const hours = Math.floor(ms / 3600_000);
  return `${hours ? `${hours}h ` : ""}${Math.floor((ms % 3600_000) / 60_000)}m left`;
}

function handoffCard(chat, categories = []) {
  const left = windowLeft(chat.window_closes_at);
  const text = h("textarea", { placeholder: left ? "Reply as the team…" : "Their 24-hour window has closed: WhatsApp won't deliver a reply until they message us again.", disabled: !left || null });
  const request = chat.request;
  const nameOf = (slug) => categories.find((c) => c.slug === slug)?.name || slug;
  const teachStatus = h("span", { class: "muted" });
  const wanted = categorySelect(categories, "What were they looking for?");
  if (request?.category_slug) wanted.value = request.category_slug;
  const teach = request?.raw_text
    ? h("div", { class: "notice" },
        h("p", {}, h("strong", {}, "Their request: "), request.raw_text),
        h("p", { class: "muted" }, readingLine(request.reading, nameOf)),
        h("div", { class: "row" }, wanted, h("button", { onclick: async () => {
          if (!wanted.value) return;
          await post(`/requests/${request.id}/teach`, { category: wanted.value });
          teachStatus.textContent = `Saved. The assistant will read this wording as ${nameOf(wanted.value)} from now on.`;
        } }, "Teach the assistant"), teachStatus))
    : null;
  const messages = (chat.recent_messages || []).map((m) => {
    const body = m.body || {};
    const notes = m.notes || {};
    const content = m.direction === "out"
      ? body.text
      : body.text || body.title ||
        (notes.transcript ? `🎙️ ${notes.transcript}` : body.type === "image" ? `📷 ${body.caption || notes.seen || "photo"}` : body.type ? `[${body.type}]` : "");
    return h("div", { class: `msg ${m.direction}` }, content || "", h("small", {}, date(m.created_at)));
  });
  return h("div", { class: "card" },
    h("strong", {}, chat.profile_name || "Customer"), " ",
    chat.channel === "business" ? [h("span", { class: "tag" }, "business number"), " "] : null,
    h("span", { class: "muted" }, `+${chat.wa_id} · waiting since ${date(chat.updated_at)}`), " ",
    left ? h("span", { class: "tag ok", title: "Replies are free and delivered until their 24-hour window closes" }, `Reply window: ${left}`)
      : h("span", { class: "tag warn" }, "Window closed"),
    h("div", { class: "msgs" }, ...messages),
    teach,
    text,
    h("div", { class: "row" },
      h("button", { class: "primary", disabled: !left || null, onclick: async () => {
        if (!text.value.trim()) return;
        await post(`/contacts/${chat.contact_id}/reply`, { text: text.value.trim() });
        render();
      } }, "Send reply"),
      h("button", { onclick: async () => { await post(`/contacts/${chat.contact_id}/release`); render(); } }, "Hand back to the assistant"),
      h("button", { class: "danger", onclick: async () => {
        const reason = prompt("Block this number? Say why (kept for the record).");
        if (reason === null) return;
        await post(`/contacts/${chat.contact_id}/block`, { blocked: true, reason: reason || undefined });
        await post(`/contacts/${chat.contact_id}/release`);
        render();
      } }, "Block number")),
  );
}

function contactCard(c) {
  return h("div", { class: "card" },
    h("strong", {}, c.profile_name || "(no name)"), " ",
    h("span", { class: "tag" }, c.channel === "customer" ? "customer number" : "business number"),
    c.is_blocked ? [" ", h("span", { class: "tag bad" }, "blocked")] : null,
    h("p", { class: "muted" }, [
      `+${c.wa_id}`,
      `first message ${day(c.created_at)}`,
      c.last_inbound_at ? `last ${date(c.last_inbound_at)}` : null,
      `${c.messages} messages`,
      `${c.requests} requests`,
      c.businesses ? `${c.businesses} listings` : null,
      c.consent_at ? "agreed to the privacy notice" : "hasn't agreed to the privacy notice",
    ].filter(Boolean).join(" · ")),
    c.blocked_reason ? h("p", { class: "muted" }, `Blocked: ${c.blocked_reason}`) : null,
    h("p", { class: "row" },
      h("button", { onclick: async () => {
        let reason;
        if (!c.is_blocked) {
          reason = prompt("Why block this number? (kept for the record)");
          if (reason === null) return;
        }
        await post(`/contacts/${c.id}/block`, { blocked: !c.is_blocked, reason: reason || undefined });
        render();
      } }, c.is_blocked ? "Unblock" : "Block"),
      isAdmin() ? h("button", { onclick: () => download(`/contacts/${c.id}/export`, `contact-${c.wa_id}.json`) }, "Export their data") : null,
      isAdmin() ? h("button", { class: "danger", onclick: async () => {
        if (!confirm(`Delete everything held about +${c.wa_id}: messages, requests and ratings? Businesses they own stay listed. This can't be undone.`)) return;
        const r = await post(`/contacts/${c.id}/erase`);
        alert(`Deleted ${r.messages} messages and ${r.requests} requests.`);
        render();
      } }, "Delete their data") : null));
}

async function businessDetail(id) {
  const b = await api(`/businesses/${id}`);
  const photos = h("div", { class: "photos" });
  for (const p of b.photos) {
    api(`/photos/${p.id}`).then((blob) => photos.append(h("img", { src: URL.createObjectURL(blob), alt: p.kind, title: p.kind }))).catch(() => {});
  }
  const setStatus = (status) => async () => { await post(`/businesses/${b.id}/status`, { status }); render(); };
  const checks = Object.entries(b.checks || {}).map(([k, v]) => `${k === "premisesSeen" ? "premises seen" : k === "idChecked" ? "ID checked" : k}: ${v ? "yes" : "no"}`);
  return h("div", { class: "card" },
    h("h1", {}, b.name),
    h("p", { class: "muted" }, [`+${b.phone}`, b.area, b.categories.join(", ")].filter(Boolean).join(" · ")),
    b.description ? h("p", {}, b.description) : null,
    h("p", { class: "row" },
      h("span", { class: `tag ${b.verification === "verified" ? "ok" : ""}` }, b.verification),
      h("span", { class: "tag" }, b.status),
      h("span", { class: "tag" }, `source: ${b.source}`),
      checks.length ? h("span", { class: "muted" }, checks.join(" · ")) : null),
    b.audits.length ? h("p", { class: "muted" }, "Call-backs: ", b.audits.map((a) => `${a.outcome} by ${a.audited_by} on ${day(a.created_at)}${a.note ? ` (${a.note})` : ""}`).join("; ")) : null,
    b.record.answered ? h("p", { class: "muted" }, `Customers' follow-up answers, last 90 days: ${b.record.sorted} sorted, ${b.record.couldntHelp} couldn't help, ${b.record.noReply} didn't reply.`) : null,
    b.rechecks.length ? h("p", { class: "muted" }, "Re-checks: ", b.rechecks.map((c) => `${RECHECK_LABELS[c.outcome] ?? c.outcome} by ${c.checked_by} on ${day(c.created_at)}${c.note ? ` (${c.note})` : ""}`).join("; ")) : null,
    photos,
    b.offerings.length ? h("details", {},
      h("summary", {}, `Price list: ${b.offerings.length} items (read ${day(b.offerings[0].created_at)})`),
      h("ul", { class: "offerings" }, ...b.offerings.map((o) => h("li", {}, o.name, o.price_usd != null ? ` · $${Number(o.price_usd).toFixed(2)}` : o.price_text ? ` · ${o.price_text}` : "")))) : null,
    h("p", { class: "row" },
      b.status !== "active" ? h("button", { onclick: setStatus("active") }, "Make live") : h("button", { onclick: setStatus("paused") }, "Pause"),
      b.verification !== "verified" ? h("button", { onclick: async () => {
        await post(`/businesses/${b.id}/verify`);
        render();
      } }, "Mark verified") : null,
      isAdmin() ? h("button", { class: "danger", onclick: () => confirm(`Remove ${b.name}? Customers won't see it; it stays in the records.`) && setStatus("removed")() }, "Remove") : null,
      isAdmin() ? h("button", { class: "danger", onclick: async () => {
        if (!confirm(`Delete ${b.name} completely, with its photos and price list? Only do this when the owner asked us to forget them. It can't be undone.`)) return;
        await post(`/businesses/${b.id}/erase`);
        render();
      } }, "Delete completely") : null),
  );
}

function loginForm(message) {
  const email = h("input", { type: "email", placeholder: "Email", autocomplete: "username", required: true });
  const password = h("input", { type: "password", placeholder: "Password", autocomplete: "current-password", required: true });
  const token = h("input", { type: "password", placeholder: "Ops token", autocomplete: "off" });
  const error = h("p", { class: "error" }, message || "");
  return [
    ...header("Sign in"),
    error,
    h("form", { class: "inline", onsubmit: async (e) => {
      e.preventDefault();
      try {
        const r = await post("/login", { email: email.value, password: password.value });
        store.set(TOKEN_KEY, r.token);
        me = null;
        render();
      } catch (err) {
        error.textContent = err.message;
      }
    } }, email, password, h("button", { class: "primary" }, "Sign in")),
    h("details", {},
      h("summary", {}, "Use the ops token instead"),
      h("p", { class: "muted" }, "For setting up the first accounts, or scripts. Everything is recorded as \"ops token\"."),
      h("form", { class: "inline", onsubmit: (e) => { e.preventDefault(); store.set(TOKEN_KEY, token.value.trim()); me = null; render(); } },
        token, h("button", {}, "Continue"))),
  ];
}

async function signOut() {
  try { await post("/logout"); } catch { /* already signed out */ }
  store.set(TOKEN_KEY, "");
  me = null;
  render();
}

const ADMIN_TABS = new Set(["agents", "team", "activity"]);

async function render() {
  const name = (location.hash.slice(1).split("?")[0]) || "overview";
  for (const a of document.querySelectorAll("#tabs a")) a.classList.toggle("active", a.getAttribute("href") === `#${name}`);
  const who = document.getElementById("who");
  // Screens return arrays that may hold null/false for sections that don't apply.
  const show = (nodes) => view.replaceChildren(...nodes.flat().filter((n) => n != null && n !== false));
  try {
    me ??= await api("/me");
    who.replaceChildren(h("a", { href: "#account" }, `${me.name} · ${me.role}`));
    for (const a of document.querySelectorAll("#tabs a")) a.hidden = ADMIN_TABS.has(a.getAttribute("href").slice(1)) && !isAdmin();
    const screen = (ADMIN_TABS.has(name) && !isAdmin() ? null : screens[name]) ?? screens.overview;
    show(await screen());
  } catch (err) {
    if (err instanceof Unauthorized) {
      me = null;
      who.replaceChildren();
      show(loginForm(store.get(TOKEN_KEY) ? "Your session has ended. Please sign in again." : ""));
    } else {
      show([...header("Something went wrong"), h("p", { class: "error" }, err.message)]);
    }
  }
}

window.addEventListener("hashchange", render);
render();
