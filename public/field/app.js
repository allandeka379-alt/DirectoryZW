// Field app: register businesses in person, even without signal. Registrations queue on the
// phone (IndexedDB) and upload when there's a connection.

const TOKEN_KEY = "field.token";
const BOOT_KEY = "field.bootstrap";
const MINE_KEY = "field.mine";

const view = document.getElementById("view");
let boot = readJson(BOOT_KEY);
let mine = readJson(MINE_KEY);
let syncing = false;

// ---------- helpers ----------

function readJson(key) {
  try { return JSON.parse(localStorage.getItem(key) || "null"); } catch { return null; }
}
function writeJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage full or blocked */ }
}
function token() {
  try { return localStorage.getItem(TOKEN_KEY) || ""; } catch { return ""; }
}

/** Create an element: h("div", { class: "card" }, "text", child). Text is never parsed as HTML. */
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

/** Replace the screen, skipping empty slots (null/false) left by conditional sections. */
function show(...nodes) {
  view.replaceChildren(...nodes.flat().filter((n) => n != null && n !== false));
}

async function api(path, options = {}) {
  const res = await fetch(`/field/api${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${token()}`, ...(options.body ? { "Content-Type": "application/json" } : {}), ...options.headers },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

function km(lat1, lng1, lat2, lng2) {
  const r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lng2 - lng1) * r) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(a));
}

function nearestArea(lat, lng) {
  let best = null;
  for (const a of boot?.areas ?? []) {
    if (a.name === a.city && boot.areas.some((x) => x.city === a.city && x.name !== x.city)) continue;
    const d = km(lat, lng, a.lat, a.lng);
    if (!best || d < best.d) best = { a, d };
  }
  return best?.a ?? null;
}

function validPhone(value) {
  const d = value.replace(/\D/g, "");
  return /^(2637\d{8}|07\d{8}|7\d{8})$/.test(d) || (/^\d{10,15}$/.test(d) && !d.startsWith("0"));
}

// ---------- offline queue (IndexedDB) ----------

function openQueue() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("field-app", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("queue", { keyPath: "clientRef" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function queueTx(mode, fn) {
  const db = await openQueue();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("queue", mode);
    const result = fn(tx.objectStore("queue"));
    tx.oncomplete = () => resolve(result?.result ?? result);
    tx.onerror = () => reject(tx.error);
  });
}
const queueAll = () => queueTx("readonly", (s) => s.getAll());
const queuePut = (item) => queueTx("readwrite", (s) => s.put(item));
const queueDelete = (clientRef) => queueTx("readwrite", (s) => s.delete(clientRef));

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1]);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

async function resizePhoto(file, max = 1280, quality = 0.7) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
}

// ---------- sync ----------

async function sync() {
  if (syncing || !navigator.onLine || !token()) return;
  syncing = true;
  try {
    const items = (await queueAll()).filter((i) => i.status === "pending");
    for (const item of items) {
      const photos = [];
      for (const p of item.photos) photos.push({ kind: p.kind, contentType: p.blob.type || "image/jpeg", dataBase64: await blobToBase64(p.blob) });
      let res;
      try {
        res = await api("/businesses", {
          method: "POST",
          body: JSON.stringify({ ...item.payload, clientRef: item.clientRef, allowDuplicatePhone: item.allowDuplicatePhone || undefined, photos }),
        });
      } catch {
        break; // connection dropped; try again later
      }
      if (res.status === 201 || res.status === 200) {
        await queueDelete(item.clientRef);
        continue;
      }
      if (res.status === 409) Object.assign(item, { status: "duplicate", matches: res.body.matches || [] });
      else if (res.status === 400) Object.assign(item, { status: "error", error: res.body.error || "The server rejected this registration." });
      else break; // 401 or a server problem: keep it queued
      await queuePut(item);
    }
    await refreshMine();
  } finally {
    syncing = false;
    if (currentScreen === "home") renderHome();
  }
}

async function refreshMine() {
  if (!navigator.onLine || !token()) return;
  try {
    const res = await api("/mine");
    if (res.status === 200) {
      mine = res.body;
      writeJson(MINE_KEY, mine);
    }
  } catch { /* offline */ }
}

// ---------- screens ----------

let currentScreen = "home";

function setNet() {
  const el = document.getElementById("net");
  el.textContent = navigator.onLine ? "Online" : "Offline";
  el.classList.toggle("off", !navigator.onLine);
}

function renderSetup(message) {
  currentScreen = "setup";
  const input = h("input", { type: "text", placeholder: "Paste the setup link or code", autocomplete: "off" });
  show(
    h("h1", {}, "Set up this phone"),
    h("div", { class: "card" },
      h("p", {}, "Open the setup link your team lead sent you on this phone. You only need to do this once."),
      message ? h("div", { class: "notice bad" }, message) : null,
      h("label", {}, "Or paste it here"),
      input,
      h("p", {}, h("button", { class: "primary", onclick: () => {
        const v = input.value.trim();
        const t = v.includes("token=") ? v.split("token=")[1] : v;
        if (t) { localStorage.setItem(TOKEN_KEY, t); start(); }
      } }, "Continue")),
    ),
  );
}

async function renderHome() {
  currentScreen = "home";
  const items = await queueAll().catch(() => []);
  const waiting = items.filter((i) => i.status === "pending");
  const problems = items.filter((i) => i.status !== "pending");
  const counts = mine?.counts ?? {};
  show(
    h("div", { class: "stats" },
      h("div", { class: "stat" }, h("b", {}, counts.today ?? 0), h("span", {}, "today")),
      h("div", { class: "stat" }, h("b", {}, counts.week ?? 0), h("span", {}, "this week")),
      h("div", { class: "stat" }, h("b", {}, waiting.length), h("span", {}, "to upload")),
    ),
    h("p", {}, h("button", { class: "primary big", onclick: () => renderForm() }, "+ Register a business")),
    problems.length ? h("h2", {}, "Needs your attention") : null,
    ...problems.map(problemCard),
    waiting.length ? h("h2", {}, "Waiting to upload") : null,
    waiting.length
      ? h("div", { class: "card" },
          ...waiting.map((i) => h("div", { class: "item" }, h("div", {}, i.payload.name, h("div", { class: "muted" }, i.areaName || "")), h("span", { class: "tag warn" }, "Queued"))),
          h("p", { class: "muted" }, navigator.onLine ? "Uploading…" : "These upload automatically when you have signal."))
      : null,
    h("h2", {}, "Your recent registrations"),
    h("div", { class: "card" },
      ...(mine?.recent?.length
        ? mine.recent.map((b) => h("div", { class: "item" },
            h("div", {}, b.name, h("div", { class: "muted" }, [b.area, new Date(b.created_at).toLocaleDateString()].filter(Boolean).join(" · "))),
            h("span", { class: `tag ${b.audit_status === "failed" ? "bad" : b.verification === "verified" ? "ok" : ""}` },
              b.audit_status === "failed" ? "Failed check" : b.verification === "verified" ? "Verified" : "Registered")))
        : [h("p", { class: "muted" }, "Nothing yet.")]),
    ),
    counts.audits_failed ? h("p", { class: "muted" }, `Call-back checks: ${counts.audits_passed} passed, ${counts.audits_failed} failed.`) : null,
  );
}

function problemCard(item) {
  const body = [];
  if (item.status === "duplicate") {
    body.push(h("div", { class: "notice warn" }, "This may already be listed:"));
    for (const m of item.matches || []) {
      body.push(h("div", { class: "muted" }, `• ${m.name} (${m.area || "no area"}) · ${m.phone}${m.reason === "same_phone" ? " · same number" : " · similar name nearby"}`));
    }
    body.push(h("div", { class: "row" },
      h("button", { onclick: async () => { Object.assign(item, { status: "pending", allowDuplicatePhone: true }); await queuePut(item); sync(); renderHome(); } }, "It's a different business"),
      h("button", { onclick: async () => { await queueDelete(item.clientRef); renderHome(); } }, "Discard"),
    ));
  } else {
    body.push(h("div", { class: "notice bad" }, item.error || "Couldn't upload."));
    body.push(h("div", { class: "row" },
      h("button", { onclick: () => renderForm(item) }, "Fix it"),
      h("button", { onclick: async () => { await queueDelete(item.clientRef); renderHome(); } }, "Discard"),
    ));
  }
  return h("div", { class: "card" }, h("strong", {}, item.payload.name), ...body);
}

function renderForm(existing) {
  currentScreen = "form";
  const p = existing?.payload ?? {};
  const selected = new Set(p.categories ?? []);
  let gps = p.lat != null ? { lat: p.lat, lng: p.lng, accuracy: p.gpsAccuracyM } : null;
  const photos = existing?.photos ? [...existing.photos] : [];

  const name = h("input", { type: "text", value: p.name ?? "", autocomplete: "off", required: true });
  const phone = h("input", { type: "tel", value: p.phone ?? "", placeholder: "0771234567", autocomplete: "off" });
  const dupBox = h("div");
  const description = h("textarea", { placeholder: "What they sell or do, in the owner's words" }, p.description ?? "");
  const keywords = h("input", { type: "text", value: p.keywords ?? "", placeholder: "Brands, products, specialities" });
  const trade = h("select", {},
    ...[["retail", "The public"], ["wholesale", "Other businesses (wholesale only)"], ["both", "Both"]]
      .map(([v, l]) => h("option", { value: v, selected: (p.trade ?? "retail") === v || null }, l)));
  const chips = h("div", { class: "chips" });
  const filter = h("input", { type: "search", placeholder: "Search categories" });
  const catList = h("div", { class: "cats" });
  const gpsText = h("span", { class: "muted" });
  const area = h("select", {}, h("option", { value: "" }, "Choose the area"));
  const photoRow = h("div", { class: "photos" });
  const premises = h("input", { type: "checkbox", checked: p.checks?.premisesSeen || null });
  const idChecked = h("input", { type: "checkbox", checked: p.checks?.idChecked || null });
  const consent = h("input", { type: "checkbox", checked: p.consent || null });
  const errors = h("div", { class: "error" });

  const cities = [...new Set((boot?.areas ?? []).map((a) => a.city))];
  for (const city of cities) {
    const group = h("optgroup", { label: city });
    for (const a of boot.areas.filter((x) => x.city === city)) group.append(h("option", { value: String(a.id) }, a.name));
    area.append(group);
  }
  if (p.areaId) area.value = String(p.areaId);

  function drawChips() {
    chips.replaceChildren(...[...selected].map((slug) => h("span", { class: "chip" }, boot.categories.find((c) => c.slug === slug)?.name ?? slug)));
  }
  function drawCategories() {
    const q = filter.value.trim().toLowerCase();
    const rows = [];
    let lastGroup = "";
    for (const c of boot?.categories ?? []) {
      if (q && !c.name.toLowerCase().includes(q) && !c.group.toLowerCase().includes(q)) continue;
      if (c.group !== lastGroup) { rows.push(h("div", { class: "group" }, c.group)); lastGroup = c.group; }
      const box = h("input", { type: "checkbox", checked: selected.has(c.slug) || null, onchange: () => {
        if (box.checked && selected.size >= 3) { box.checked = false; errors.textContent = "Pick at most 3 categories."; return; }
        box.checked ? selected.add(c.slug) : selected.delete(c.slug);
        errors.textContent = "";
        drawChips();
      } });
      rows.push(h("label", { class: "check" }, box, c.name));
    }
    catList.replaceChildren(...(rows.length ? rows : [h("p", { class: "muted" }, "No matching category.")]));
  }
  function drawGps() {
    gpsText.textContent = gps ? `Captured, accurate to about ${Math.round(gps.accuracy ?? 0)} m` : "Not captured yet";
  }
  function drawPhotos() {
    photoRow.replaceChildren(...photos.map((ph, i) => {
      const kind = h("select", { onchange: () => { ph.kind = kind.value; } },
        ...["shopfront", "inside", "price_list"].map((k) => h("option", { value: k, selected: ph.kind === k || null }, k === "price_list" ? "Price list" : k === "inside" ? "Inside" : "Shopfront")));
      return h("div", { class: "photo" },
        h("img", { src: URL.createObjectURL(ph.blob), alt: "" }),
        kind,
        h("button", { class: "link", onclick: () => { photos.splice(i, 1); drawPhotos(); } }, "Remove"));
    }));
  }

  async function checkDuplicates() {
    dupBox.replaceChildren();
    if (!navigator.onLine || !validPhone(phone.value)) return;
    const params = new URLSearchParams({ phone: phone.value, name: name.value });
    if (gps) { params.set("lat", String(gps.lat)); params.set("lng", String(gps.lng)); }
    try {
      const res = await api(`/duplicates?${params}`);
      if (res.status === 200 && res.body.length) {
        dupBox.replaceChildren(h("div", { class: "notice warn" }, "Possibly already listed: ",
          res.body.map((m) => `${m.name} (${m.area || "no area"})`).join(", "), ". Check with the owner before registering again."));
      }
    } catch { /* offline */ }
  }

  const photoInput = h("input", { type: "file", accept: "image/*", capture: "environment", style: "display:none", onchange: async () => {
    for (const file of photoInput.files) {
      if (photos.length >= 3) break;
      try {
        photos.push({ kind: photos.length === 0 ? "shopfront" : "inside", blob: await resizePhoto(file) });
      } catch {
        errors.textContent = "Couldn't read that photo.";
      }
    }
    photoInput.value = "";
    drawPhotos();
  } });

  const captureGps = () => {
    if (!navigator.geolocation) { gpsText.textContent = "GPS isn't available on this phone."; return; }
    gpsText.textContent = "Getting your position…";
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        gps = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy };
        const near = nearestArea(gps.lat, gps.lng);
        if (near && !area.value) area.value = String(near.id);
        drawGps();
        checkDuplicates();
      },
      () => { gpsText.textContent = "Couldn't get GPS. Move outside or choose the area below."; },
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 60000 },
    );
  };

  async function save() {
    const problems = [];
    if (name.value.trim().length < 2) problems.push("Enter the business name.");
    if (!validPhone(phone.value)) problems.push("Enter the owner's WhatsApp number, like 0771234567.");
    if (!selected.size) problems.push("Pick at least one category.");
    if (!area.value && !gps) problems.push("Capture GPS or choose the area.");
    if (!consent.checked) problems.push("The owner must agree to be listed.");
    if (problems.length) { errors.replaceChildren(...problems.map((m) => h("div", {}, m))); return; }
    const areaId = area.value ? Number(area.value) : undefined;
    const item = {
      clientRef: existing?.clientRef ?? crypto.randomUUID(),
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      status: "pending",
      areaName: boot.areas.find((a) => a.id === areaId)?.name ?? "",
      payload: {
        name: name.value.trim(),
        phone: phone.value.trim(),
        categories: [...selected],
        description: description.value.trim() || undefined,
        keywords: keywords.value.trim() || undefined,
        trade: trade.value,
        areaId,
        lat: gps?.lat,
        lng: gps?.lng,
        gpsAccuracyM: gps?.accuracy,
        checks: { premisesSeen: premises.checked, idChecked: idChecked.checked },
        consent: true,
      },
      photos,
    };
    await queuePut(item);
    renderHome();
    sync();
  }

  phone.addEventListener("change", checkDuplicates);
  filter.addEventListener("input", drawCategories);
  drawChips();
  drawCategories();
  drawGps();
  drawPhotos();

  show(
    h("h1", {}, existing ? "Fix registration" : "Register a business"),
    h("div", { class: "card" },
      h("label", {}, "Business name"), name,
      h("label", {}, "Owner's WhatsApp number ", h("small", {}, "customers will message this number")), phone, dupBox,
      h("label", {}, "What they sell or do"), description,
      h("label", {}, "Categories ", h("small", {}, "up to 3")), chips, filter, catList,
      h("label", {}, "Brands and specialities ", h("small", {}, "optional")), keywords,
      h("label", {}, "Who they sell to ", h("small", {}, "wholesalers show up when shops look for suppliers")), trade,
    ),
    h("div", { class: "card" },
      h("label", {}, "Location"),
      h("div", { class: "row" }, h("button", { onclick: captureGps }, "📍 Capture GPS"), gpsText),
      h("label", {}, "Area"), area,
    ),
    h("div", { class: "card" },
      h("label", {}, "Photos ", h("small", {}, "shopfront first, up to 3. Never photograph IDs.")),
      h("button", { onclick: () => photoInput.click() }, "📷 Add photo"), photoInput, photoRow,
    ),
    h("div", { class: "card" },
      h("label", {}, "Checks"),
      h("label", { class: "check" }, premises, "I saw the business premises"),
      h("label", { class: "check" }, idChecked, "I checked the owner's ID or business registration (don't photograph it)"),
      h("p", { class: "muted" }, "Both checks make the listing Verified. Otherwise it shows as not yet verified."),
      h("label", { class: "check" }, consent, h("strong", {}, "The owner agrees to be listed and to receive customer messages on WhatsApp")),
    ),
    errors,
    h("div", { class: "actions" }, h("div", {},
      h("button", { onclick: () => renderHome() }, "Cancel"),
      h("button", { class: "primary", onclick: save }, "Save"),
    )),
  );
}

// ---------- start ----------

async function start() {
  const hash = new URLSearchParams(location.hash.slice(1));
  if (hash.get("token")) {
    localStorage.setItem(TOKEN_KEY, hash.get("token"));
    history.replaceState(null, "", location.pathname);
  }
  if (!token()) return renderSetup();
  if (navigator.onLine) {
    try {
      const res = await api("/bootstrap");
      if (res.status === 401) {
        localStorage.removeItem(TOKEN_KEY);
        return renderSetup(res.body.error);
      }
      if (res.status === 200) {
        boot = res.body;
        writeJson(BOOT_KEY, boot);
      }
    } catch { /* offline: use the saved copy */ }
  }
  if (!boot) return renderSetup("Connect to the internet once to finish setting up.");
  document.getElementById("brand").textContent = `${boot.brand} field app`;
  document.getElementById("agent").textContent = boot.agent.name + (boot.agent.city ? ` · ${boot.agent.city}` : "");
  await refreshMine();
  renderHome();
  sync();
}

window.addEventListener("online", () => { setNet(); sync(); });
window.addEventListener("offline", setNet);
setInterval(sync, 30000);
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/field/sw.js", { scope: "/field/" }).catch(() => {});
setNet();
start();
