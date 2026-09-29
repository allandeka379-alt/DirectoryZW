// Registering a business on the website: three short steps, then a code to send on WhatsApp.

const $ = (id) => document.getElementById(id);
const form = $("form");
const steps = [...form.querySelectorAll("[data-step]")];
const stepper = [...$("stepper").children];
const state = { step: 1, categories: [], trade: "retail", options: null };

function showError(message) {
  $("error").textContent = message || "";
  $("error").hidden = !message;
}

function go(step) {
  state.step = step;
  steps.forEach((s) => (s.hidden = Number(s.dataset.step) !== step));
  stepper.forEach((li, i) => {
    li.classList.toggle("done", i + 1 < step);
    li.classList.toggle("current", i + 1 === step);
  });
  $("back").hidden = step === 1;
  $("next").textContent = step === 3 ? "Register my business" : "Continue";
  showError("");
  steps[step - 1].querySelector("input, select, textarea")?.focus();
}

// ---------- Categories: search, then up to three chips ----------

const search = $("cat-search");
const list = $("cat-list");
let matches = [];
let active = 0;

function norm(s) {
  return s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9 ]/g, " ");
}

/** How well a category fits what was typed: its name or a synonym starting with it first, then containing it. */
function score(c, q) {
  const terms = [c.name, ...(c.synonyms ?? [])].map(norm);
  const words = terms.flatMap((t) => t.split(/\s+/));
  const singular = q.length > 3 ? q.replace(/(es|s)$/, "") : q; // "fridges" finds "fridge"
  if (words.some((w) => w.startsWith(q))) return 3;
  if (terms.some((t) => t.includes(q))) return 2;
  if (singular !== q && terms.some((t) => t.includes(singular))) return 2;
  return norm(c.group).includes(q) ? 1 : 0;
}

function renderChosen() {
  const box = $("chosen");
  box.replaceChildren(
    ...state.categories.map((slug) => {
      const c = state.options.categories.find((x) => x.slug === slug);
      const chip = document.createElement("span");
      chip.className = "chip";
      chip.textContent = c ? c.name : slug;
      const x = document.createElement("button");
      x.type = "button";
      x.setAttribute("aria-label", `Remove ${chip.textContent}`);
      x.textContent = "×";
      x.onclick = () => {
        state.categories = state.categories.filter((s) => s !== slug);
        renderChosen();
      };
      chip.append(x);
      return chip;
    }),
  );
  search.disabled = state.categories.length >= 3;
  search.placeholder = state.categories.length >= 3 ? "Three chosen" : "Type to search: fridges, plumbing, cakes…";
}

function renderMatches() {
  list.replaceChildren(
    ...matches.map((c, i) => {
      const li = document.createElement("li");
      li.setAttribute("role", "option");
      li.setAttribute("aria-selected", String(i === active));
      li.append(Object.assign(document.createElement("span"), { textContent: c.name }), Object.assign(document.createElement("small"), { textContent: c.group }));
      li.onmousedown = (e) => {
        e.preventDefault();
        pick(c);
      };
      return li;
    }),
  );
  list.hidden = matches.length === 0;
  search.setAttribute("aria-expanded", String(!list.hidden));
}

function pick(c) {
  if (!state.categories.includes(c.slug) && state.categories.length < 3) state.categories.push(c.slug);
  search.value = "";
  matches = [];
  renderMatches();
  renderChosen();
  showError("");
}

search.addEventListener("input", () => {
  const q = norm(search.value).trim();
  active = 0;
  matches = !q
    ? []
    : state.options.categories
        .filter((c) => !state.categories.includes(c.slug))
        .map((c) => ({ c, s: score(c, q) }))
        .filter((x) => x.s > 0)
        .sort((x, y) => y.s - x.s || x.c.name.localeCompare(y.c.name))
        .slice(0, 8)
        .map((x) => x.c);
  renderMatches();
});
search.addEventListener("keydown", (e) => {
  if (list.hidden) return;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    active = (active + (e.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length;
    renderMatches();
  } else if (e.key === "Enter") {
    e.preventDefault();
    if (matches[active]) pick(matches[active]);
  } else if (e.key === "Escape") {
    matches = [];
    renderMatches();
  }
});
search.addEventListener("blur", () => setTimeout(() => ((matches = []), renderMatches()), 100));

// ---------- Who they sell to ----------

$("trade").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  state.trade = b.dataset.value;
  for (const x of $("trade").children) x.setAttribute("aria-pressed", String(x === b));
});

// ---------- Steps and sending ----------

function check(step) {
  if (step === 1) {
    if ($("name").value.trim().length < 2) return "Enter your business name.";
    if (!state.categories.length) return "Choose at least one category: start typing what you sell.";
  }
  if (step === 2 && !$("area").value) return "Choose your area.";
  if (step === 3) {
    const digits = $("phone").value.replace(/\D/g, "");
    if (digits.length < 9) return "Enter the number customers contact you on.";
    if (!$("consent").checked) return "Please agree to the business terms.";
  }
  return "";
}

function phoneNumber() {
  const d = $("phone").value.replace(/\D/g, "");
  if (d.startsWith("263")) return d;
  if (d.startsWith("0")) return `263${d.slice(1)}`;
  return `263${d}`;
}

$("back").onclick = () => go(state.step - 1);

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const problem = check(state.step);
  if (problem) return showError(problem);
  if (state.step < 3) return go(state.step + 1);
  const button = $("next");
  button.classList.add("is-busy");
  try {
    const res = await fetch("/app/api/public/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: $("name").value,
        categories: state.categories,
        description: $("description").value,
        areaId: Number($("area").value),
        address: $("address").value,
        hours: $("hours").value,
        trade: state.trade,
        phone: phoneNumber(),
        email: $("email").value,
        website: $("website").value,
        consent: true,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return showError(data.error || "Something went wrong. Please try again.");
    form.hidden = true;
    if (data.preLaunch) {
      // Before launch: no code to send on WhatsApp yet; the team calls.
      const n = phoneNumber();
      $("done-prelaunch").hidden = false;
      $("prelaunch-code").textContent = data.code;
      $("prelaunch-phone").textContent = `+${n.slice(0, 3)} ${n.slice(3, 5)} ${n.slice(5, 8)} ${n.slice(8)}`;
      $("done-prelaunch").scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    $("done").hidden = false;
    $("code").textContent = data.code;
    $("wa").href = data.whatsappLink;
    const n = data.whatsappNumber;
    $("wa-manual").textContent = `On a computer? From the WhatsApp you'll manage your listing from, send ${data.code} to +${n.slice(0, 3)} ${n.slice(3, 5)} ${n.slice(5, 8)} ${n.slice(8)}.`;
    $("expires").textContent = `The code works for 48 hours.`;
    $("done").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch {
    showError("We couldn't reach the server. Check your connection and try again.");
  } finally {
    button.classList.remove("is-busy");
  }
});

// ---------- Start ----------

(async () => {
  try {
    state.options = await (await fetch("/app/api/public/options")).json();
  } catch {
    return showError("We couldn't load the form. Refresh the page to try again.");
  }
  const byCity = new Map();
  for (const a of state.options.areas) {
    if (!byCity.has(a.city)) byCity.set(a.city, []);
    byCity.get(a.city).push(a);
  }
  const select = $("area");
  for (const [city, areas] of [...byCity].sort((a, b) => (a[0] === "Harare" ? -1 : b[0] === "Harare" ? 1 : a[0].localeCompare(b[0])))) {
    const group = document.createElement("optgroup");
    group.label = city;
    for (const a of areas.sort((x, y) => x.name.localeCompare(y.name))) group.append(new Option(a.name, a.id));
    select.append(group);
  }
  renderChosen();
})();
