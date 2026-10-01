// FindZim has one look: dark. There is no light mode and no switch.
// Loaded in <head>, before the page draws. It clears a "light" choice saved by an older
// version of the site, and makes sure nothing (an old saved choice, a "?theme=light" link)
// can turn a page light.
(function () {
  var KEY = "dz.theme";
  var DARK = "#0c0a09";
  var root = document.documentElement;

  try {
    localStorage.removeItem(KEY);
  } catch (e) {
    /* private browsing, or storage switched off: nothing was saved */
  }

  function keepDark() {
    if (root.hasAttribute("data-theme")) root.removeAttribute("data-theme");
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta && meta.getAttribute("content") !== DARK) meta.setAttribute("content", DARK);
  }

  keepDark();
  // The theme-color tag is parsed after this script runs.
  document.addEventListener("DOMContentLoaded", keepDark);
})();
