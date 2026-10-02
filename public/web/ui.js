// Building blocks shared by the business dashboard and the admin portal: DOM helpers, icons,
// formatting, toasts, drawers and dialogs, and photo handling. User data is always set as text.

// ---------- DOM ----------

export function h(tag, props, ...kids) {
  const node = document.createElement(tag);
  let value;
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k === "value") value = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (typeof v === "boolean") node[k] = v;
    else node.setAttribute(k, String(v));
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    node.append(kid instanceof Node ? kid : String(kid));
  }
  if (value !== undefined) node.value = value;
  return node;
}

/** Nodes to insert, without the nulls left by optional parts (append() would print them as "null"). */
export const present = (nodes) => nodes.flat(Infinity).filter((n) => n != null && n !== false);

const ICONS = {
  overview: '<path d="M3 13h8V3H3zM13 21h8V11h-8zM3 21h8v-6H3zM13 3v6h8V3z"/>',
  products: '<path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="m3 8 9 5 9-5M12 13v8"/>',
  customers: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
  insights: '<path d="M3 3v18h18"/><path d="m7 15 4-4 3 3 6-7"/>',
  profile: '<path d="M3 21h18M5 21V8l7-5 7 5v13"/><path d="M9 21v-6h6v6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5M12 3v12"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5M12 15V3"/>',
  tag: '<path d="M20.59 13.41 13.42 20.58a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><circle cx="7" cy="7" r="1.5"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  close: '<path d="M18 6 6 18M6 6l12 12"/>',
  out: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5M21 12H9"/>',
  whatsapp: '<path d="M3 21l1.7-5.1A8.5 8.5 0 1 1 8.1 19.3z"/><path d="M9 9.5c.3 1.6 1.9 3.6 3.9 4.4l1.3-1.2 2 .9c-.2 1.3-1.4 2-2.7 1.8-3-.5-5.7-3.2-6.2-6.2C7.1 7.9 7.9 6.7 9.2 6.5l.9 2z"/>',
  file: '<path d="M14 3v4a1 1 0 0 0 1 1h4"/><path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2Z"/>',
  pin: '<path d="M12 22s7-6.1 7-12a7 7 0 1 0-14 0c0 5.9 7 12 7 12z"/><circle cx="12" cy="10" r="2.5"/>',
  chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  flag: '<path d="M4 22V4a1 1 0 0 1 1-1h13l-2.5 4.5L18 12H5"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/>',
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  phone: '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z"/>',
  refresh: '<path d="M21 12a9 9 0 0 1-15.5 6.2L3 16"/><path d="M3 12a9 9 0 0 1 15.5-6.2L21 8"/><path d="M21 3v5h-5M3 21v-5h5"/>',
  bulb: '<path d="M9 18h6M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.3 1 2.3h6c0-1 .4-1.8 1-2.3A7 7 0 0 0 12 2z"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  target: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
  book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5z"/><path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5"/>',
  check: '<path d="m5 12 5 5 9-10"/>',
  checkCircle: '<circle cx="12" cy="12" r="10"/><path d="m8 12 3 3 5-6"/>',
  userPlus: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6M22 11h-6"/>',
  user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  server: '<rect x="2" y="3" width="20" height="8" rx="2"/><rect x="2" y="13" width="20" height="8" rx="2"/><path d="M6 7h.01M6 17h.01"/>',
  menu: '<path d="M3 6h18M3 12h18M3 18h18"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>',
  key: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="m10.7 12.3 9.3-9.3M17 6l3 3M14 9l2 2"/>',
  external: '<path d="M15 3h6v6M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
};

export function icon(name) {
  const tpl = document.createElement("template");
  // A default size, so an icon never fills its box where no rule sizes it; CSS rules still win.
  tpl.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] ?? ""}</svg>`;
  return tpl.content.firstChild;
}

// ---------- Formatting ----------

export const money = (n) => (n == null ? "" : `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
export const num = (n) => Number(n ?? 0).toLocaleString("en-US");
export const pct = (x) => (x == null || !Number.isFinite(x) ? "–" : `${Math.round(x * 100)}%`);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const dateOf = (iso) => new Date(iso.length === 10 ? `${iso}T12:00:00` : iso);
export function shortDate(iso) {
  const d = dateOf(iso);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}
export const longDate = (iso) => `${WEEKDAYS[dateOf(iso).getDay()]} ${shortDate(iso)}`;
/** "29 Sep, 14:05" (with the year when it isn't this one). */
export function dateTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const year = d.getFullYear() === new Date().getFullYear() ? "" : ` ${d.getFullYear()}`;
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${year}, ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
export function ago(iso) {
  if (!iso) return "never";
  // Calendar days, not 24-hour spans: something from 11pm yesterday is "yesterday", not "today".
  const midnight = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((midnight(new Date()) - midnight(new Date(iso))) / 86400000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.round(days / 7)} weeks ago`;
  return shortDate(iso);
}
/** "$12.50", "12,5", "12" → 12.5; "" → null; NaN when it isn't a price. */
export function readPrice(text) {
  const s = String(text).replace(/us\$|\$|usd/gi, "").replace(/\s/g, "").replace(/,(\d{1,2})$/, ".$1").replace(/,/g, "");
  if (!s) return null;
  return /^\d+(\.\d+)?$/.test(s) ? Math.round(Number(s) * 100) / 100 : NaN;
}
/** "+263 77 123 4567" for a Zimbabwe number stored as 263771234567. */
export function phoneLabel(digits) {
  const d = String(digits ?? "");
  return /^263\d{9}$/.test(d) ? `+263 ${d.slice(3, 5)} ${d.slice(5, 8)} ${d.slice(8)}` : d ? `+${d}` : "";
}

// ---------- Storage that may be switched off ----------

export const store = {
  get: (k) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k, v) => {
    try {
      if (v == null || v === "") localStorage.removeItem(k);
      else localStorage.setItem(k, v);
    } catch {
      /* private mode */
    }
  },
};

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

// ---------- Toasts, drawers and dialogs ----------

export function toast(message, kind) {
  const t = h("div", { class: `toast${kind === "bad" ? " bad" : ""}`, role: kind === "bad" ? "alert" : "status" }, message);
  document.getElementById("toasts").append(t);
  setTimeout(() => t.remove(), kind === "bad" ? 6000 : 3200);
}

const sheets = [];
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && sheets.length) sheets[sheets.length - 1].close();
});

/** A drawer (from the right) or a dialog (centred; a bottom sheet on phones). */
export function openSheet({ kind = "dialog", title, subtitle, body, foot = [], onClose }) {
  const scrim = h("div", { class: "scrim" });
  const closeBtn = h("button", { class: "btn btn-ghost btn-icon btn-sm", "aria-label": "Close", type: "button" }, icon("close"));
  const bodyBox = h("div", { class: "sheet-body" }, body);
  const footBox = h("div", { class: "sheet-foot" }, foot);
  const heading = h("h2", { text: title });
  const panel = h(
    "div",
    { class: kind === "drawer" ? "drawer" : `dialog${kind === "small" ? " small" : ""}`, role: "dialog", "aria-modal": "true", "aria-label": title },
    h("div", { class: "sheet-head" }, h("div", {}, heading, subtitle ? h("p", { text: subtitle }) : null), closeBtn),
    bodyBox,
    footBox,
  );
  const sheet = {
    body: bodyBox,
    foot: footBox,
    panel,
    close() {
      scrim.remove();
      panel.remove();
      sheets.splice(sheets.indexOf(sheet), 1);
      onClose?.();
    },
    setTitle(text) {
      heading.textContent = text;
      panel.setAttribute("aria-label", text);
    },
    setFoot(...nodes) {
      footBox.replaceChildren(...present(nodes));
    },
    setBody(...nodes) {
      bodyBox.replaceChildren(...present(nodes));
    },
  };
  scrim.onclick = () => sheet.close();
  closeBtn.onclick = () => sheet.close();
  document.getElementById("layer").append(scrim, panel);
  sheets.push(sheet);
  setTimeout(() => (panel.querySelector(".sheet-body input, .sheet-body select, .sheet-body textarea") ?? footBox.querySelector(".btn:last-child"))?.focus(), 30);
  return sheet;
}

export function closeAllSheets() {
  for (const s of [...sheets].reverse()) s.close();
}

export function confirmDialog({ title, body, ok = "Confirm", danger = false }) {
  return new Promise((resolve) => {
    let answered = false;
    const sheet = openSheet({
      kind: "small",
      title,
      body: h("p", { class: "muted", text: body }),
      onClose: () => !answered && resolve(false),
    });
    sheet.setFoot(
      h("span", { class: "spacer" }),
      h("button", { class: "btn btn-secondary", type: "button", onclick: () => sheet.close() }, "Cancel"),
      h(
        "button",
        {
          class: danger ? "btn btn-danger" : "btn",
          type: "button",
          onclick: () => {
            answered = true;
            sheet.close();
            resolve(true);
          },
        },
        ok,
      ),
    );
  });
}

/** Asks for a line of text, e.g. why a number is being blocked. Resolves to null when cancelled. */
export function promptDialog({ title, body, placeholder = "", ok = "Save", danger = false, required = false }) {
  return new Promise((resolve) => {
    let answered = false;
    const input = h("input", { class: "input", placeholder, maxlength: 300 });
    const sheet = openSheet({
      kind: "small",
      title,
      body: [body ? h("p", { class: "muted", text: body }) : null, input],
      onClose: () => !answered && resolve(null),
    });
    const done = () => {
      if (required && !input.value.trim()) return input.focus();
      answered = true;
      sheet.close();
      resolve(input.value.trim());
    };
    input.onkeydown = (e) => e.key === "Enter" && done();
    sheet.setFoot(
      h("span", { class: "spacer" }),
      h("button", { class: "btn btn-secondary", type: "button", onclick: () => sheet.close() }, "Cancel"),
      h("button", { class: danger ? "btn btn-danger" : "btn", type: "button", onclick: done }, ok),
    );
  });
}

/** Run an action with a button busy, and show what went wrong. */
export async function busy(button, fn) {
  button?.classList.add("is-busy");
  try {
    return await fn();
  } catch (err) {
    if (err?.status !== 401) toast(err?.message ?? "Something went wrong.", "bad");
    return undefined;
  } finally {
    button?.classList.remove("is-busy");
  }
}

// ---------- Photos: shrunk in the browser, so they upload quickly on any connection ----------

export async function shrinkPhoto(file) {
  if (!/^image\/(jpeg|png|webp|heic|heif)$/i.test(file.type) && !/\.(jpe?g|png|webp)$/i.test(file.name)) {
    throw new Error("Choose a photo: JPEG, PNG or WebP.");
  }
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    bitmap = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("That photo couldn't be read."));
      img.src = URL.createObjectURL(file);
    });
  }
  const w0 = bitmap.width;
  const h0 = bitmap.height;
  const scale = Math.min(1, 1280 / Math.max(w0, h0));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(w0 * scale);
  canvas.height = Math.round(h0 * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  for (const q of [0.82, 0.7, 0.55]) {
    const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", q));
    if (blob && blob.size < 1.8 * 1024 * 1024) {
      const dataBase64 = await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1]);
        reader.readAsDataURL(blob);
      });
      return { contentType: "image/jpeg", dataBase64, url: URL.createObjectURL(blob) };
    }
  }
  throw new Error("That photo is too large. Try another.");
}

export function pickFile(accept) {
  return new Promise((resolve) => {
    const input = h("input", { type: "file", accept, style: "display:none" });
    const done = (file) => {
      resolve(file);
      input.remove();
    };
    input.onchange = () => done(input.files?.[0] ?? null);
    input.addEventListener("cancel", () => done(null));
    document.body.append(input);
    input.click();
  });
}

/** Save a file the browser already holds (an export) under a name. */
export function saveFile(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = h("a", { href: url, download: filename, style: "display:none" });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
