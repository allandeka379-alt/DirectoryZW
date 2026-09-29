// Dark is our default look. Anyone can switch to light; we remember the choice on this device.
// Loaded in <head>, before the page draws, so a light-mode visitor never sees a dark flash.
(function () {
  var KEY = "dz.theme";
  var root = document.documentElement;

  function saved() {
    try {
      return localStorage.getItem(KEY);
    } catch (e) {
      return null; // private browsing, or storage switched off
    }
  }

  function apply(theme) {
    if (theme === "light") root.setAttribute("data-theme", "light");
    else root.removeAttribute("data-theme");
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", theme === "light" ? "#ffffff" : "#0c0a09");
  }

  apply(saved());
  document.addEventListener("DOMContentLoaded", function () {
    apply(saved()); // the theme-color tag is parsed after this script runs
  });

  // Any button with data-theme-toggle switches, including ones the dashboard draws later.
  document.addEventListener("click", function (e) {
    var button = e.target.closest ? e.target.closest("[data-theme-toggle]") : null;
    if (!button) return;
    var next = root.getAttribute("data-theme") === "light" ? "dark" : "light";
    try {
      localStorage.setItem(KEY, next);
    } catch (err) {
      /* the switch still works for this page */
    }
    apply(next);
  });
})();
