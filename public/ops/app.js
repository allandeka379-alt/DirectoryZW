// Ops console: a thin page over /ops/api. The token is kept in this browser only.

const TOKEN_KEY = "ops.token";
const NAME_KEY = "ops.name";
const view = document.getElementById("view");

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
  if (res.status === 401) throw new Unauthorized();
  const body = res.headers.get("content-type")?.includes("json") ? await res.json() : await res.blob();
  if (!res.ok) throw new Error(body?.error ? JSON.stringify(body.error) : `Request failed (${res.status})`);
  return body;
}
const post = (path, body) => api(path, { method: "POST", body: JSON.stringify(body ?? {}) });

function operator() {
  let name = store.get(NAME_KEY);
  if (!name) {
    name = (prompt("Your name (recorded with the changes you make)") || "").trim();
    if (name) store.set(NAME_KEY, name);
  }
  return name;
}

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
        tile(s.active_agents, "Active field agents"),
        tile(s.online_leads, "Found online, to invite"),
        tile(s.new_recommendations, "New customer tips"),
      ),
    ];
  },

  async handoffs() {
    const chats = await api("/handoffs");
    return [
      ...header("Handoffs", "Customers who asked for a person. Replies go out on the customer number."),
      ...(chats.length ? chats.map(handoffCard) : [h("p", { class: "muted" }, "No one is waiting.")]),
    ];
  },

  async gaps() {
    const days = Number(new URLSearchParams(location.hash.split("?")[1]).get("days")) || 7;
    const rows = await api(`/supply-gaps?days=${days}`);
    return [
      ...header("Supply gaps", "What people asked for that we couldn't answer. Send field teams here first."),
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
        { label: "Business", render: (r) => h("span", {}, r.business, " ", h("span", { class: "tag" }, r.verification)) },
        { label: "What happened", key: "reason" },
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
          const agent = operator();
          if (!agent) return;
          await post(`/businesses/${r.id}/verify`, { agent });
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
            const by = operator();
            if (!by) return;
            await post(`/businesses/${r.id}/audit`, { outcome: outcome.value, note: note.value || undefined, by });
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

  async online() {
    const rows = await api("/online-leads");
    const close = (r, reason, question) => async () => {
      if (question && !confirm(question)) return;
      await post(`/online-leads/${r.id}/close`, { reason });
      render();
    };
    return [
      ...header("Found online", "Businesses the web search found when nothing was listed. Customers saw them marked as unchecked. Invite them to list for free; each one is deleted when it expires."),
      table([
        { label: "Business", render: (r) => h("span", {}, h("strong", {}, r.name), r.status === "invited" ? [" ", h("span", { class: "tag" }, "invited")] : null, h("br"), h("span", { class: "muted" }, r.description)) },
        { label: "Phone", render: (r) => h("a", { href: `tel:+${r.phone}` }, `+${r.phone}`) },
        { label: "Area", render: (r) => [r.area || r.area_text, r.city].filter(Boolean).join(", ") },
        { label: "Category", render: (r) => r.category || r.query },
        { label: "Source", render: (r) => h("a", { href: r.source_url, target: "_blank", rel: "noopener noreferrer" }, r.source_title || new URL(r.source_url).hostname) },
        { label: "Shown", key: "times_shown", num: true },
        { label: "Chats", key: "times_connected", num: true },
        { label: "Expires", render: (r) => day(r.expires_at) },
        { label: "", render: (r) => h("div", { class: "row" },
          r.status !== "invited" ? h("button", { onclick: async () => { await post(`/online-leads/${r.id}/status`, { status: "invited" }); render(); } }, "Invited") : null,
          h("button", { class: "primary", onclick: close(r, "listed") }, "Now listed"),
          h("button", { onclick: close(r, "declined", `${r.name} will never be shown from web results again. Continue?`) }, "Declined"),
          h("button", { class: "danger", onclick: close(r, "wrong") }, "Wrong details")) },
      ], rows),
    ];
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
    const [rows, categories] = await Promise.all([api("/unmatched?days=30"), api("/categories")]);
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
      ...header("Vocabulary", "Searches from the last 30 days that didn't match any category. Add the words people use to the right category so their next search finds businesses."),
      h("div", { class: "card" }, form, status),
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

function handoffCard(chat) {
  const text = h("textarea", { placeholder: "Reply as the team…" });
  const messages = (chat.recent_messages || []).map((m) => {
    const body = m.body || {};
    const content = m.direction === "out"
      ? body.text
      : body.text || body.title ||
        (body.transcript ? `🎙️ ${body.transcript}` : body.type === "image" ? `📷 ${body.caption || body.seen || "photo"}` : body.type ? `[${body.type}]` : "");
    return h("div", { class: `msg ${m.direction}` }, content || "", h("small", {}, date(m.created_at)));
  });
  return h("div", { class: "card" },
    h("strong", {}, chat.profile_name || "Customer"), " ", h("span", { class: "muted" }, `+${chat.wa_id} · waiting since ${date(chat.updated_at)}`),
    h("div", { class: "msgs" }, ...messages),
    text,
    h("div", { class: "row" },
      h("button", { class: "primary", onclick: async () => {
        if (!text.value.trim()) return;
        await post(`/contacts/${chat.contact_id}/reply`, { text: text.value.trim() });
        render();
      } }, "Send reply"),
      h("button", { onclick: async () => { await post(`/contacts/${chat.contact_id}/release`); render(); } }, "Hand back to the assistant")),
  );
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
    photos,
    b.offerings.length ? h("details", {},
      h("summary", {}, `Price list: ${b.offerings.length} items (read ${day(b.offerings[0].created_at)})`),
      h("ul", { class: "offerings" }, ...b.offerings.map((o) => h("li", {}, o.name, o.price_usd != null ? ` · $${Number(o.price_usd).toFixed(2)}` : o.price_text ? ` · ${o.price_text}` : "")))) : null,
    h("p", { class: "row" },
      b.status !== "active" ? h("button", { onclick: setStatus("active") }, "Make live") : h("button", { onclick: setStatus("paused") }, "Pause"),
      b.verification !== "verified" ? h("button", { onclick: async () => {
        const agent = operator();
        if (!agent) return;
        await post(`/businesses/${b.id}/verify`, { agent });
        render();
      } }, "Mark verified") : null,
      h("button", { class: "danger", onclick: () => confirm(`Remove ${b.name}?`) && setStatus("removed")() }, "Remove")),
  );
}

function tokenForm(message) {
  const input = h("input", { type: "password", placeholder: "Ops token", autocomplete: "current-password" });
  return [
    ...header("Sign in", "Enter the ops token (OPS_TOKEN on the server)."),
    message ? h("p", { class: "error" }, message) : null,
    h("form", { class: "inline", onsubmit: (e) => { e.preventDefault(); store.set(TOKEN_KEY, input.value.trim()); render(); } },
      input, h("button", { class: "primary" }, "Continue")),
  ];
}

async function render() {
  const name = (location.hash.slice(1).split("?")[0]) || "overview";
  for (const a of document.querySelectorAll("#tabs a")) a.classList.toggle("active", a.getAttribute("href") === `#${name}`);
  const screen = screens[name] ?? screens.overview;
  // Screens return arrays that may hold null/false for sections that don't apply.
  const show = (nodes) => view.replaceChildren(...nodes.flat().filter((n) => n != null && n !== false));
  try {
    show(await screen());
  } catch (err) {
    if (err instanceof Unauthorized) show(tokenForm(store.get(TOKEN_KEY) ? "That token didn't work." : ""));
    else show([...header("Something went wrong"), h("p", { class: "error" }, err.message)]);
  }
}

window.addEventListener("hashchange", render);
render();
