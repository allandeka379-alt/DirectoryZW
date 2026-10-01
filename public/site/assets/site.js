/* FindZim site: optional progressive enhancement. The page works and is
   fully visible without this script. It adds reveal-on-scroll, pauses
   loops off-screen and replays the hero chat (under 5 s of motion).
   The marquee's Pause switch is pure CSS (a sibling checkbox).
   No network, no storage, no dependencies. */
(function () {
  'use strict';
  var doc = document;

  function each(sel, fn) {
    var list = doc.querySelectorAll(sel);
    for (var i = 0; i < list.length; i++) fn(list[i]);
  }

  // Fail open: show every reveal block (no motion, errors, printing).
  function showAll() {
    try { each('[data-reveal]', function (el) { el.classList.add('in'); }); } catch (e) {}
  }

  try {
    doc.documentElement.classList.add('js');
    window.addEventListener('beforeprint', showAll);

    var reduce = false;
    try { reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}
    if (reduce || !('IntersectionObserver' in window)) return showAll();

    // Reveal each block once as it scrolls in. A block much taller than
    // the screen shows as soon as its top does: no blank gap on phones.
    function onReveal(entries, obs) {
      entries.forEach(function (en) {
        if (en.isIntersecting) {
          en.target.classList.add('in');
          obs.unobserve(en.target);
        }
      });
    }
    var margin = '0px 0px -10% 0px';
    var reveal = new IntersectionObserver(onReveal, { rootMargin: margin, threshold: 0.15 });
    var revealTall = new IntersectionObserver(onReveal, { rootMargin: margin, threshold: 0 });
    var view = window.innerHeight || 800;
    each('[data-reveal]', function (el) {
      (el.offsetHeight * 0.15 > view * 0.2 ? revealTall : reveal).observe(el);
    });

    // Pause loops off-screen; replay the hero chat on return, at most
    // every 20 s (the page-load play counts).
    var hero = doc.querySelector('.hero');
    var stage = doc.querySelector('.hero-stage');
    var heroOut = false;
    var lastPlay = Date.now();

    var watch = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        var el = en.target;
        el.classList.toggle('is-offscreen', !en.isIntersecting);
        if (el !== hero) return;
        if (!en.isIntersecting) { heroOut = true; return; }
        if (!heroOut || !stage || Date.now() - lastPlay < 20000) return;
        heroOut = false;
        stage.classList.add('restart');
        void stage.offsetWidth; // reflow, so the animations start again
        stage.classList.remove('restart');
        lastPlay = Date.now();
      });
    }, { threshold: 0 });
    each('.hero, .marquee, .final', function (el) { watch.observe(el); });
  } catch (err) {
    showAll();
  }
})();
