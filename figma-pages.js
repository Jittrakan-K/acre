/* ==========================================================================
   ACRE — separate pages (desktop / tablet ≥769px)
   Dashboard, Tasks and Timeline each show only their own content instead of
   one long scrolling page. Uses the app's own navigation (desktopNavigateTo)
   and view switching; nothing in app.js is changed. Phones keep their
   bottom tab bar, which already works this way.
   ========================================================================== */
(function () {
  'use strict';
  var KEY = 'acre_page_v1';
  var PAGES = ['dashboard', 'tasks', 'timeline'];
  function isWide() { return window.matchMedia('(min-width: 769px)').matches; }
  function getPage() { return document.body.getAttribute('data-acre-page') || 'dashboard'; }

  function markNav(page) {
    document.querySelectorAll('.desktop-nav-link').forEach(function (b) { b.classList.remove('active'); });
    var el = document.getElementById('deskNav' + page.charAt(0).toUpperCase() + page.slice(1));
    if (el) el.classList.add('active');
  }
  function setPage(page, opts) {
    if (PAGES.indexOf(page) === -1) page = 'dashboard';
    document.body.setAttribute('data-acre-page', page);
    try { localStorage.setItem(KEY, page); } catch (e) {}
    markNav(page);
    if (!(opts && opts.keepScroll)) window.scrollTo(0, 0);
  }
  window.acreSetPage = setPage;

  /* nav links */
  var origNav = window.desktopNavigateTo;
  if (typeof origNav === 'function') {
    window.desktopNavigateTo = function (dest) {
      if (!isWide()) return origNav.apply(this, arguments);
      navigating = true;
      try { origNav.apply(this, arguments); } finally { navigating = false; }
      setPage(dest);
    };
  }

  /* anything that jumps to the task list (filters from dashboard cards,
     "view all", requester rows…) opens the Tasks page instead of scrolling */
  var navigating = false;
  var origScroll = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = function () {
    if (isWide() && (this.id === 'controlsBar' || this.id === 'viewContainer' || (this.classList && this.classList.contains('controls-bar')))) {
      var target = (typeof currentView !== 'undefined' && currentView === 'timeline') ? 'timeline' : 'tasks';
      if (getPage() === 'dashboard' || navigating) setPage(target); else window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    if (isWide() && (this.id === 'statsGrid' || (this.classList && this.classList.contains('analytics-section'))) && getPage() !== 'dashboard') {
      setPage('dashboard');
    }
    return origScroll.apply(this, arguments);
  };

  /* Cards / Timeline / Table switcher keeps the menu in step */
  document.addEventListener('click', function (e) {
    var tab = e.target.closest && e.target.closest('.view-tab');
    if (!tab || !isWide()) return;
    var v = tab.getAttribute('data-view');
    setPage(v === 'timeline' ? 'timeline' : 'tasks', { keepScroll: true });
  });

  function init() {
    var saved = 'dashboard';
    try { saved = localStorage.getItem(KEY) || 'dashboard'; } catch (e) {}
    if (PAGES.indexOf(saved) === -1) saved = 'dashboard';
    if (saved === 'dashboard') setPage('dashboard', { keepScroll: true });
    else if (typeof origNav === 'function') { navigating = true; try { origNav(saved); } finally { navigating = false; } setPage(saved); }
    else setPage(saved);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { setTimeout(init, 60); });
  else setTimeout(init, 60);
})();

/* ACRE — brand mark: a geometric "A", an outer peak with a smaller peak rising inside it */
(function () {
  'use strict';
  var INK = '#111827';
  function glyph(c) {
    return "<path d='M4 58 L32 6 L60 58 H47 L32 30 L17 58Z' fill='" + c + "'/><path d='M23 58 L32 41 L41 58Z' fill='" + c + "'/>";
  }
  function acreMark(c) { return "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64' aria-hidden='true'>" + glyph(c || 'currentColor') + "</svg>"; }
  function acreTile() {
    return "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><rect width='64' height='64' rx='14' fill='" + INK + "'/>" +
      "<g transform='translate(11 12) scale(.656)'>" + glyph('#fff') + "</g></svg>";
  }
  window.acreMark = acreMark;
  function sync() {
    if (document.title !== 'ACRE') document.title = 'ACRE';
    var link = document.querySelector('link[rel="icon"][type="image/svg+xml"]');
    if (!link) { link = document.createElement('link'); link.rel = 'icon'; link.type = 'image/svg+xml'; document.head.appendChild(link); }
    var href = 'data:image/svg+xml,' + encodeURIComponent(acreTile());
    if (link.href !== href) link.href = href;
    document.querySelectorAll('.brand-app-icon, .mobile-brand-icon-circle').forEach(function (el) {
      if (el.getAttribute('data-acre') === '2') return;
      el.setAttribute('data-acre', '2'); el.classList.add('acre-mark'); el.innerHTML = acreMark();
    });
  }
  sync();
  var t = document.querySelector('title'); if (t) new MutationObserver(function () { if (document.title !== 'ACRE') document.title = 'ACRE'; }).observe(t, { childList: true, characterData: true, subtree: true });
  window.addEventListener('load', sync); setTimeout(sync, 1500);
})();

/* ACRE — job type dropdown: show what each code means */
(function () {
  'use strict';
  var L = { D: 'D (DESIGN)', R: 'R (REPAIR)', M: 'M (MODIFY)', I: 'I (INCREASE)', A: 'A (ASSY/INSTALL)', S: 'S (SIMULATION)',
    'D-A': 'D-A (DESIGN + ASSY/INSTALL)', 'D-I': 'D-I (DESIGN + INCREASE)', 'D-I-A': 'D-I-A (DESIGN + INCREASE + ASSY)', 'I-A': 'I-A (INCREASE + ASSY/INSTALL)',
    'R-A': 'R-A (REPAIR + ASSY/INSTALL)', 'M-I': 'M-I (MODIFY + INCREASE)', 'M-A': 'M-A (MODIFY + ASSY/INSTALL)', 'D-M': 'D-M (DESIGN + MODIFY)',
    'D-M-I': 'D-M-I (DESIGN + MODIFY + INCREASE)', 'I-R': 'I-R (INCREASE + REPAIR)', 'R-D': 'R-D (REPAIR + DESIGN)', 'I-M': 'I-M (INCREASE + MODIFY)',
    T: 'T (TRAINING)', AC: 'AC (ACTIVITY / 5S)', Q: 'Q (QUOTATION)', '': '-- AUTO --' };
  function apply() {
    var s = document.getElementById('achvJobType'); if (!s) return; s.classList.add('no-case');
    Array.prototype.forEach.call(s.options, function (o) { var t = L[o.value]; if (t && o.textContent !== t) o.textContent = t; });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', apply); else apply();
  setTimeout(apply, 500); setTimeout(apply, 2000);
  var s = document.getElementById('achvJobType');
  if (s) new MutationObserver(function () { setTimeout(apply, 0); }).observe(s, { childList: true, subtree: true, characterData: true });
})();

/* ACRE — team tables: short column headers so they never collide */
(function () {
  'use strict';
  var MAP = [[/count\s*\(%\s*of\s*all\)/i, 'Tasks'], [/team\s*share\s*\(%\)/i, 'Share']];
  function fix(root) {
    (root || document).querySelectorAll('.eng-support-table th').forEach(function (th) {
      var t = th.textContent.trim();
      MAP.forEach(function (m) { if (m[0].test(t)) th.textContent = m[1]; });
    });
  }
  function watch() {
    ['engDesignSupportContainer', 'engMaintSupportContainer'].forEach(function (id) {
      var el = document.getElementById(id); if (!el || el.__fxw) return; el.__fxw = 1;
      fix(el); new MutationObserver(function () { fix(el); }).observe(el, { childList: true, subtree: true, characterData: true });
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watch); else watch();
  setTimeout(watch, 1500);
})();

/* ACRE — quiet toasts: only warnings and errors pop up; routine "saved / synced / uploaded" messages stay hidden */
(function () {
  'use strict';
  var IMPORTANT = /⚠|❌|🚫|⛔|error|fail|denied|ผิดพลาด|ไม่สำเร็จ|ไม่ได้|ไม่พบ|ล้มเหลว|ปฏิเสธ|เฉพาะผู้ดูแล|ถูกระงับ|หมดอายุ|offline|ออฟไลน์/i;
  function patch() {
    var orig = window.showToast;
    if (typeof orig !== 'function' || orig.__acreQuiet) return;
    var quiet = function (message) {
      if (IMPORTANT.test(String(message == null ? '' : message))) return orig.apply(this, arguments);
    };
    quiet.__acreQuiet = true;
    window.showToast = quiet;
  }
  patch();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', patch);
  setTimeout(patch, 1500);
})();
