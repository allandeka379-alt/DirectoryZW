/** The local WhatsApp simulator: a customer chat and a business chat side by side. */
export function simulatorPage(brand: string): string {
  return PAGE.replace("__BRAND__", escapeHtml(brand));
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

// Plain string (no template interpolation): the embedded script avoids backticks and "${".
const PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>WhatsApp simulator</title>
<style>
:root { --bg:#efeae2; --panel:#ffffff; --in:#ffffff; --out:#d9fdd3; --text:#111b21; --muted:#667781; --accent:#008069; --border:#d1d7db; }
@media (prefers-color-scheme: dark) {
  :root { --bg:#0b141a; --panel:#111b21; --in:#202c33; --out:#005c4b; --text:#e9edef; --muted:#8696a0; --accent:#00a884; --border:#2a3942; }
}
* { box-sizing: border-box; }
body { margin:0; font:14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; background:var(--bg); color:var(--text); }
header { display:flex; gap:12px; align-items:center; justify-content:space-between; flex-wrap:wrap; padding:10px 16px; background:var(--accent); color:#fff; }
header button { background:#fff; color:#008069; border:0; border-radius:16px; padding:6px 12px; cursor:pointer; font:inherit; }
main { display:grid; grid-template-columns:repeat(auto-fit, minmax(320px, 1fr)); gap:16px; padding:16px; }
.phone { background:var(--panel); border:1px solid var(--border); border-radius:12px; display:flex; flex-direction:column; height:calc(100vh - 110px); min-height:480px; }
.bar { padding:10px; border-bottom:1px solid var(--border); display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
.bar input, .bar select { padding:4px 6px; border:1px solid var(--border); border-radius:6px; background:var(--panel); color:var(--text); font:inherit; max-width:100%; }
.chat { flex:1; overflow-y:auto; padding:12px; display:flex; flex-direction:column; gap:8px; background:var(--bg); }
.msg { max-width:85%; padding:8px 10px; border-radius:8px; overflow-wrap:anywhere; box-shadow:0 1px 0.5px rgba(0,0,0,.13); }
.bot { align-self:flex-start; background:var(--in); }
.me { align-self:flex-end; background:var(--out); }
.meta, .footer, .rows small { font-size:12px; color:var(--muted); }
.meta { margin-top:4px; text-align:right; }
.footer { margin-top:6px; }
.btns { display:flex; flex-direction:column; margin-top:8px; }
.btns button, .rows button, .toggle { background:transparent; border:0; border-top:1px solid var(--border); color:var(--accent); padding:8px; cursor:pointer; font:inherit; }
.rows { display:none; }
.rows.open { display:block; }
.rows button { display:block; width:100%; text-align:left; }
.rows small { display:block; }
.section { font-size:12px; color:var(--muted); padding:6px 8px 0; }
.link { display:block; margin-top:8px; padding-top:8px; border-top:1px solid var(--border); text-align:center; color:var(--accent); font-weight:600; text-decoration:none; }
form.composer { display:flex; gap:8px; padding:10px; border-top:1px solid var(--border); }
form.composer input { flex:1; min-width:0; padding:8px 12px; border-radius:20px; border:1px solid var(--border); background:var(--panel); color:var(--text); font:inherit; }
form.composer button { border:0; border-radius:20px; padding:8px 14px; background:var(--accent); color:#fff; cursor:pointer; font:inherit; }
dialog { border:1px solid var(--border); border-radius:12px; background:var(--panel); color:var(--text); }
dialog select { max-width:280px; }
</style>
</head>
<body>
<header>
  <strong>WhatsApp simulator · __BRAND__</strong>
  <span>Messages stay on this computer. <button id="jobs" type="button">Run follow-ups now</button></span>
</header>
<main>
  <section class="phone" data-channel="customer">
    <div class="bar">
      <strong>Customer chat</strong>
      <label>My number <input class="from" value="263771234567" size="13"></label>
      <label>Name <input class="name" value="Tendai" size="8"></label>
    </div>
    <div class="chat"></div>
    <form class="composer"><button type="button" class="loc" title="Share location">📍</button><input class="text" placeholder="e.g. I need a plumber in Mabelreign" autocomplete="off"><button>Send</button></form>
  </section>
  <section class="phone" data-channel="business">
    <div class="bar">
      <strong>Business chat</strong>
      <label>Number <input class="from" value="263770001000" size="13"></label>
      <select class="pick"><option value="">Switch to a listed business…</option></select>
    </div>
    <div class="chat"></div>
    <form class="composer"><button type="button" class="loc" title="Share location">📍</button><input class="text" placeholder="e.g. register" autocomplete="off"><button>Send</button></form>
  </section>
</main>
<dialog id="where">
  <form method="dialog">
    <p>Share a location</p>
    <select id="area"></select>
    <p><button value="cancel">Cancel</button> <button value="ok">Share</button></p>
  </form>
</dialog>
<script>
(function () {
  var panes = {};
  var areas = [];
  var locPane = null;

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c];
    });
  }
  function fmt(s) {
    var h = esc(s);
    h = h.replace(/\*([^*\n]+)\*/g, "<b>$1</b>").replace(/(^|\s)_([^_\n]+)_/g, "$1<i>$2</i>");
    h = h.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
    return h.replace(/\n/g, "<br>");
  }
  function safeUrl(u) { return /^https?:\/\//.test(u) ? u : "#"; }
  function prefilled(u) {
    try { return new URL(u).searchParams.get("text") || u; } catch (e) { return u; }
  }
  function number(p) { return p.from.value.replace(/\D/g, ""); }

  function bubble(p, cls, html) {
    var d = document.createElement("div");
    d.className = "msg " + cls;
    d.innerHTML = html;
    p.chat.appendChild(d);
    p.chat.scrollTop = p.chat.scrollHeight;
    return d;
  }
  function button(label, onClick, cls) {
    var b = document.createElement("button");
    b.type = "button";
    if (cls) b.className = cls;
    b.textContent = label;
    b.onclick = onClick;
    return b;
  }

  function send(p, content, echo) {
    bubble(p, "me", fmt(echo));
    var body = { channel: p.channel, from: number(p), content: content };
    if (p.name && p.name.value.trim()) body.name = p.name.value.trim();
    return fetch("/simulator/api/send", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      .then(function (r) { if (!r.ok) return r.text().then(function (t) { bubble(p, "bot", "<i>Error: " + esc(t) + "</i>"); }); })
      .then(pollAll);
  }

  function render(p, item) {
    var m = item.message;
    var d;
    if (m.kind === "text") {
      d = bubble(p, "bot", fmt(m.text));
    } else if (m.kind === "buttons") {
      d = bubble(p, "bot", (m.header ? "<b>" + esc(m.header) + "</b><br>" : "") + fmt(m.body) + (m.footer ? '<div class="footer">' + esc(m.footer) + "</div>" : ""));
      var box = document.createElement("div");
      box.className = "btns";
      m.buttons.forEach(function (b) {
        box.appendChild(button(b.title, function () { send(p, { type: "button_reply", id: b.id, title: b.title }, b.title); }));
      });
      d.appendChild(box);
    } else if (m.kind === "list") {
      d = bubble(p, "bot", (m.header ? "<b>" + esc(m.header) + "</b><br>" : "") + fmt(m.body) + (m.footer ? '<div class="footer">' + esc(m.footer) + "</div>" : ""));
      var rows = document.createElement("div");
      rows.className = "rows";
      m.sections.forEach(function (s) {
        if (s.title) { var t = document.createElement("div"); t.className = "section"; t.textContent = s.title; rows.appendChild(t); }
        s.rows.forEach(function (r) {
          var b = button(r.title, function () { send(p, { type: "list_reply", id: r.id, title: r.title }, r.title); });
          if (r.description) { var small = document.createElement("small"); small.textContent = r.description; b.appendChild(small); }
          rows.appendChild(b);
        });
      });
      d.appendChild(button("☰ " + m.button, function () { rows.classList.toggle("open"); }, "toggle"));
      d.appendChild(rows);
    } else if (m.kind === "cta_url") {
      d = bubble(p, "bot", fmt(m.body));
      var a = document.createElement("a");
      a.className = "link";
      a.href = safeUrl(m.url);
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = "↗ " + m.displayText;
      d.appendChild(a);
      var note = document.createElement("div");
      note.className = "footer";
      note.textContent = "Opens a chat with this message typed: “" + prefilled(m.url) + "”";
      d.appendChild(note);
    } else if (m.kind === "location_request") {
      d = bubble(p, "bot", fmt(m.body));
      var lb = document.createElement("div");
      lb.className = "btns";
      lb.appendChild(button("📍 Send location", function () { askLocation(p); }));
      d.appendChild(lb);
    } else if (m.kind === "contact_card") {
      d = bubble(p, "bot", "👤 " + esc(m.name) + " +" + esc(m.phone));
    } else {
      d = bubble(p, "bot", "<i>(" + esc(m.kind) + ")</i>");
    }
    var meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = new Date(item.at).toLocaleTimeString();
    d.appendChild(meta);
  }

  function poll(p) {
    var n = number(p);
    if (!n) return Promise.resolve();
    return fetch("/simulator/api/messages?channel=" + p.channel + "&to=" + n + "&after=" + p.after)
      .then(function (r) { return r.json(); })
      .then(function (items) {
        items.forEach(function (it) { if (it.seq > p.after) { p.after = it.seq; render(p, it); } });
      })
      .catch(function () {});
  }
  function pollAll() { return Promise.all(Object.keys(panes).map(function (k) { return poll(panes[k]); })); }

  function reset(p) { p.after = 0; p.chat.innerHTML = ""; poll(p); }

  function askLocation(p) { locPane = p; document.getElementById("where").showModal(); }
  document.getElementById("where").addEventListener("close", function () {
    var dlg = document.getElementById("where");
    if (dlg.returnValue !== "ok" || !locPane) return;
    var a = areas[Number(document.getElementById("area").value)];
    if (a) send(locPane, { type: "location", lat: a.lat, lng: a.lng, name: a.name }, "📍 " + a.name + ", " + a.city);
  });

  Array.prototype.forEach.call(document.querySelectorAll(".phone"), function (section) {
    var p = {
      channel: section.getAttribute("data-channel"),
      chat: section.querySelector(".chat"),
      from: section.querySelector(".from"),
      name: section.querySelector(".name"),
      after: 0
    };
    panes[p.channel] = p;
    section.querySelector("form").addEventListener("submit", function (e) {
      e.preventDefault();
      var input = section.querySelector(".text");
      var text = input.value.trim();
      if (!text || !number(p)) return;
      input.value = "";
      send(p, { type: "text", text: text }, text);
    });
    section.querySelector(".loc").addEventListener("click", function () { askLocation(p); });
    p.from.addEventListener("change", function () { reset(p); });
    var pick = section.querySelector(".pick");
    if (pick) pick.addEventListener("change", function () { if (pick.value) { p.from.value = pick.value; reset(p); } });
  });

  fetch("/simulator/api/areas").then(function (r) { return r.json(); }).then(function (list) {
    areas = list;
    var sel = document.getElementById("area");
    list.forEach(function (a, i) {
      var o = document.createElement("option");
      o.value = String(i);
      o.textContent = a.name === a.city ? a.name : a.name + " (" + a.city + ")";
      sel.appendChild(o);
    });
  });
  fetch("/simulator/api/businesses").then(function (r) { return r.json(); }).then(function (list) {
    var pick = document.querySelector(".pick");
    list.forEach(function (b) {
      var o = document.createElement("option");
      o.value = b.phone;
      o.textContent = (b.verification === "verified" ? "✅ " : "") + b.name + " · " + b.phone;
      pick.appendChild(o);
    });
  });
  document.getElementById("jobs").addEventListener("click", function () {
    fetch("/simulator/api/jobs/run-now", { method: "POST" }).then(pollAll);
  });

  pollAll();
  setInterval(pollAll, 1500);
})();
</script>
</body>
</html>`;
