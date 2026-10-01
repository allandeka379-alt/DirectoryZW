/* FindZim site: optional progressive enhancement. The page works and is
   fully visible without this script. It adds reveal-on-scroll, pauses
   loops off-screen and plays the hero chat in a loop.
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

    // The hero chat plays in a loop: the conversation (its CSS animations
    // take about 4.7 s), time to read the last message, a short fade, then
    // a fresh round. It waits while the hero is off-screen or the tab is
    // hidden, and starts a fresh round when it is seen again.
    var hero = doc.querySelector('.hero');
    var stage = doc.querySelector('.hero-stage');
    var PLAY = 4700;
    var READ = 4800;
    var FADE = 450; // matches the .clearing transition in site.css
    var timer = 0;
    var heroSeen = true;

    function restart() {
      stage.classList.add('restart');
      void stage.offsetWidth; // reflow, so the animations start again
      stage.classList.remove('restart');
    }
    function nextRound() {
      clearTimeout(timer);
      if (!heroSeen || doc.hidden) return; // resumes when seen again
      stage.classList.add('clearing');
      timer = setTimeout(function () {
        restart();
        stage.classList.remove('clearing');
        timer = setTimeout(nextRound, PLAY + READ);
      }, FADE);
    }
    function pauseRounds() {
      clearTimeout(timer);
    }

    if (hero && stage) {
      timer = setTimeout(nextRound, PLAY + READ);
      doc.addEventListener('visibilitychange', function () {
        if (doc.hidden) pauseRounds();
        else nextRound();
      });
    }

    // Pause loops off-screen.
    var watch = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        var el = en.target;
        el.classList.toggle('is-offscreen', !en.isIntersecting);
        if (el !== hero || !stage) return;
        if (!en.isIntersecting) {
          heroSeen = false;
          pauseRounds();
        } else if (!heroSeen) {
          heroSeen = true;
          nextRound();
        }
      });
    }, { threshold: 0 });
    each('.hero, .marquee, .final', function (el) { watch.observe(el); });
  } catch (err) {
    showAll();
  }
})();
